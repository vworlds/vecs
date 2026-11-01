import { afterEach, describe, expect, it } from "vitest";
import {
  Client2Server,
  ComponentSnapshot,
  Server2Client,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, wireType } from "@vworlds/vecs-wire";
import { Exclusive, Relationship, type Entity, type QueryDSL } from "@vworlds/vecs";
import { NetworkClient, Networked, ServerWorld, View } from "../src/index.js";
import { TrackerCache } from "../src/view.js";
import { symmetric } from "./harness/lossy_link.js";
import { ReplicationSim } from "./harness/replication_sim.js";
import { CidLayout } from "@vworlds/vecs-protocol";

const testCid = new CidLayout(4);
const decodeServer2Client = {
  wireDecode: (decoder: Decoder) => Server2Client.decodeWith(testCid, decoder),
};
const decodeComponentSnapshot = {
  wireDecode: (decoder: Decoder) => ComponentSnapshot.decodeWith(testCid, decoder),
};

// A View keeps three sets between two sends: the entities visible now, those that entered since
// the last send (the client is sent a full snapshot) and those that left it (the client is sent a
// removal). An entity that is back where it started when the frame ends, a client that never lost
// it, is in neither of the last two.

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

class Health {
  @wireType("i32")
  public hp = 100;
}

class InCell extends Relationship {}

class CellA {}
class CellB {}
class CellC {}

describe("View", () => {
  it("shares gate trackers and releases them across swaps, swap-back and teardown", () => {
    const world = new ServerWorld({ networkComponents: [Position, Health] });
    world.component(CellA);
    world.component(CellB);
    world.component(CellC);
    const cache = new TrackerCache(world);
    const trackers = (cache as unknown as { _trackers: Map<number, unknown> })._trackers;
    const a = world.entity().add(Networked).add(CellA).add(CellC);
    world.entity().add(Networked).add(CellB);
    // Non-networked matching entities never hold a session's render clock open.
    world.entity().add(CellA).add(CellC);
    const views = [new View(), new View()];
    views.forEach((view) => {
      view.dsl = CellA;
      view._refreshTracker(cache, CellC);
    });
    world.progress(0, 0);
    expect(trackers.size).toBe(2);
    expect(views.map((view) => view.gateCount)).toEqual([1, 1]);
    const first = views[0]!;
    first.dsl = CellB;
    first._refreshTracker(cache, CellC);
    world.progress(0, 0);
    expect(first.gateCount).toBe(0);
    expect(trackers.size).toBe(4);
    // Return to the original DSL before the send releases the old pair.
    first.dsl = CellA;
    first._refreshTracker(cache, CellC);
    first._releaseOldTracker(cache);
    expect(first.gateCount).toBe(1);
    expect(trackers.size).toBe(2);
    a.remove(CellC);
    expect(views.map((view) => view.gateCount)).toEqual([0, 0]);
    first.dsl = CellB;
    first._refreshTracker(cache, CellC);
    first._releaseTrackers(cache);
    expect(trackers.size).toBe(2);
    views[1]!._releaseTrackers(cache);
    expect(trackers.size).toBe(0);
    world.dispose();
  });
  function setup(): { view: View; entity: Entity } {
    const world = new ServerWorld({ networkComponents: [Position, Health] });
    return { view: new View(), entity: world.entity().add(Networked) };
  }

  /** What the next send makes of the view: who is sent a full snapshot, and who a removal. */
  function pending(view: View): { entered: Entity[]; exited: Entity[] } {
    return { entered: [...view._enteredView], exited: [...view._exitedView] };
  }

  /** What `ServerWorld.send` does with the two sets once it has built the frame. */
  function endFrame(view: View): void {
    view._enteredView.clear();
    view._exitedView.clear();
  }

  it("sends a full snapshot of an entity that enters the view", () => {
    const { view, entity } = setup();

    view.enter(entity);

    expect(view._visible.has(entity)).toBe(true);
    expect(pending(view)).toEqual({ entered: [entity], exited: [] });
  });

  it("sends a removal of an entity that exits the view in a later frame, then a full snapshot when it enters in a later one", () => {
    const { view, entity } = setup();
    view.enter(entity);
    endFrame(view);

    view.exit(entity);
    expect(pending(view)).toEqual({ entered: [], exited: [entity] });
    endFrame(view);

    view.enter(entity);
    expect(pending(view)).toEqual({ entered: [entity], exited: [] });
  });

  it("sends nothing for an entity that enters and exits in the same frame: the client never knew it", () => {
    const { view, entity } = setup();

    view.enter(entity);
    view.exit(entity);

    expect(view._visible.has(entity)).toBe(false);
    expect(pending(view)).toEqual({ entered: [], exited: [] });
  });

  it("sends nothing for an entity that exits and enters in the same frame: the client never lost it", () => {
    const { view, entity } = setup();
    view.enter(entity);
    endFrame(view);

    view.exit(entity);
    view.enter(entity);

    expect(view._visible.has(entity)).toBe(true);
    expect(pending(view)).toEqual({ entered: [], exited: [] });
  });

  it("stays settled however often an entity crosses the edge of the view within a frame", () => {
    const { view, entity } = setup();
    view.enter(entity);
    endFrame(view);

    for (let i = 0; i < 3; i++) {
      view.exit(entity);
      view.enter(entity);
    }
    expect(pending(view)).toEqual({ entered: [], exited: [] });

    // An odd number of crossings leaves it outside: that is a removal, as for a single exit.
    view.exit(entity);
    expect(pending(view)).toEqual({ entered: [], exited: [entity] });
    view.enter(entity);
    view.exit(entity);
    expect(pending(view)).toEqual({ entered: [], exited: [entity] });
  });

  it("does not mistake one entity's re-entry for another's", () => {
    const { view, entity } = setup();
    const other = entity.world.entity().add(Networked);
    view.enter(entity);
    view.enter(other);
    endFrame(view);

    view.exit(entity);
    view.exit(other);
    view.enter(other);

    expect(pending(view)).toEqual({ entered: [], exited: [entity] });
  });

  it("still re-sends every visible entity in full when the session needs a baseline", () => {
    const { view, entity } = setup();
    const other = entity.world.entity().add(Networked);
    view.enter(entity);
    view.enter(other);
    endFrame(view);

    // `entity` left and came back in this frame: it is not entered, but a baseline sends it anyway.
    view.exit(entity);
    view.enter(entity);
    expect(pending(view)).toEqual({ entered: [], exited: [] });
    view._resyncAll();

    expect(pending(view).entered.sort((a, b) => a.eid - b.eid)).toEqual(
      [entity, other].sort((a, b) => a.eid - b.eid)
    );
    expect(pending(view).exited).toEqual([]);
  });
});

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  public readonly sent: Uint8Array[] = [];
  private readonly _handlers = new Map<string, SocketHandler[]>();

  public constructor(public readonly id: string) {}

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public send(data: Uint8Array): void {
    this.sent.push(data);
  }

  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }

  public close(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

class MockListener implements VecsSocketListener {
  private readonly _handlers: ((socket: VecsSocket) => void)[] = [];

  public on(event: "new", handler: (socket: VecsSocket) => void): this {
    if (event === "new") {
      this._handlers.push(handler);
    }
    return this;
  }

  public connect(socket: VecsSocket): void {
    this._handlers.forEach((handler) => handler(socket));
  }
}

describe("a session whose view covers two cells of an interest grid", () => {
  // The entities live in cells, an `Exclusive` `InCell` relationship. The session sees cells A and
  // B, not C. Retargeting an entity from A to B makes the view's query leave the A pair and enter
  // the B pair in one mutation, and the entity is visible throughout.
  const VIEW: QueryDSL = {
    any: [{ target: [InCell, CellA] }, { target: [InCell, CellB] }],
  };

  interface Rig {
    world: ServerWorld;
    socket: MemorySocket;
    /** Starts in cell A, with a `Position` and a `Health`. */
    mover: Entity;
    cells: { a: Entity; b: Entity; c: Entity };
    /** The frames the server has sent the session since the last call, decoded. */
    take(): Server2Client[];
    /** Run one server frame and take what it sent. */
    step(): Server2Client[];
  }

  /** A world with one session whose first baseline has been sent and acked. */
  function connect(): Rig {
    const world = new ServerWorld({ networkComponents: [Position, Health] });
    [CellA, CellB, CellC].forEach((Class) => world.component(Class));
    world.component(InCell).add(Exclusive);
    world.component(NetworkClient).on("set", (entity) => {
      entity.set(View, { dsl: VIEW });
    });
    const listener = new MockListener();
    world._attach(listener);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    const cells = {
      a: world.entity().add(CellA),
      b: world.entity().add(CellB),
      c: world.entity().add(CellC),
    };
    const mover = world
      .entity()
      .add(Networked)
      .set(Position, { x: 0, y: 0 })
      .set(Health, { hp: 100 })
      .add(InCell, cells.a);
    let taken = 0;
    let nowMs = 0;
    const rig: Rig = {
      world,
      socket,
      mover,
      cells,
      take: () => {
        const frames = socket.sent
          .slice(taken)
          .map((bytes) => new Decoder(bytes).read(decodeServer2Client));
        taken = socket.sent.length;
        return frames;
      },
      step: () => {
        world.progress(nowMs, 16);
        nowMs += 16;
        return rig.take();
      },
    };

    const [baseline] = rig.step();
    expect(baseline.diff).toMatchObject({ fromFrame: 0 });
    expect(snapshotsOf(baseline).filter((s) => s.eid === mover.eid)).toHaveLength(2);
    ack(rig, baseline);
    return rig;
  }

  function ack(rig: Rig, frame: Server2Client): void {
    const encoder = new Encoder(new Uint8Array(64 * 1024));
    encoder.write(new Client2Server({ ackFrame: frame.diff!.toFrame }));
    rig.socket.receive(encoder.getBuffer());
  }

  function snapshotsOf(frame: Server2Client): Array<{ eid: number; wireType: number }> {
    return frame.diff!.snapshots.map((s) => {
      const snapshot = new Decoder(s.bytes).read(decodeComponentSnapshot);
      return { eid: snapshot.eid, wireType: snapshot.wireType };
    });
  }

  it("sends nothing when an entity is retargeted from one cell to the other, as it has not changed", () => {
    const rig = connect();

    rig.mover.add(InCell, rig.cells.b);

    // The client holds the entity and nothing about it changed: no frame at all, rather than a
    // full snapshot (its Position and Health) of an entity the client already has.
    expect(rig.step()).toEqual([]);
  });

  it("sends the entity's changes as an ordinary delta, with no removal and no snapshot of what did not change", () => {
    const rig = connect();

    rig.mover.add(InCell, rig.cells.b);
    rig.mover.set(Position, { x: 7, y: 0 });
    const [frame] = rig.step();

    expect(frame.diff!.fromFrame).toBeGreaterThan(0);
    expect(frame.diff!.removed).toEqual([]);
    expect(frame.diff!.resets).toBeUndefined();
    expect(snapshotsOf(frame)).toEqual([{ eid: rig.mover.eid, wireType: 1 }]);
  });

  it("keeps sending the entity's changes as deltas while it moves back and forth between the cells", () => {
    const rig = connect();
    const frames: Server2Client[] = [];

    for (let i = 1; i <= 6; i++) {
      rig.mover.add(InCell, i % 2 === 1 ? rig.cells.b : rig.cells.a);
      rig.mover.set(Position, { x: i, y: 0 });
      frames.push(...rig.step());
    }

    expect(frames).toHaveLength(6);
    frames.forEach((frame) => {
      expect(frame.diff!.removed).toEqual([]);
      expect(frame.diff!.resets).toBeUndefined();
      expect(snapshotsOf(frame)).toEqual([{ eid: rig.mover.eid, wireType: 1 }]);
    });
  });

  it("still sends a removal when the entity leaves the view, and a full snapshot when it comes back in a later frame", () => {
    const rig = connect();

    rig.mover.add(InCell, rig.cells.c);
    const [removal] = rig.step();
    expect(removal.diff!.snapshots).toEqual([]);
    expect(removal.diff!.removed).toEqual([]);
    expect(removal.diff!.resets).toEqual([[rig.mover.eid, removal.diff!.toFrame]]);
    ack(rig, removal);

    rig.mover.add(InCell, rig.cells.a);
    const [entered] = rig.step();
    expect(entered.diff!.removed).toEqual([]);
    expect(snapshotsOf(entered)).toEqual([
      { eid: rig.mover.eid, wireType: 1 },
      { eid: rig.mover.eid, wireType: 2 },
    ]);
  });

  it("sends nothing for an entity that passes through the view's cells without staying in one at the end of the frame", () => {
    const rig = connect();

    // A -> C -> A: the entity ends the frame where it began.
    rig.mover.add(InCell, rig.cells.c);
    rig.mover.add(InCell, rig.cells.a);

    expect(rig.step()).toEqual([]);
  });

  it("keeps an entity the client holds when it stops being Networked and is Networked again in one frame", () => {
    const rig = connect();

    // The entity leaves the view's query and comes back, like the retarget above. It was not told
    // to the client, so it must not be told it is gone either: the frame carries its current
    // components, which were all recorded again when it became Networked, and no removal.
    rig.mover.remove(Networked);
    rig.mover.add(Networked);
    const [frame] = rig.step();

    expect(frame.diff!.fromFrame).toBeGreaterThan(0);
    expect(frame.diff!.removed).toEqual([]);
    expect(snapshotsOf(frame)).toEqual([
      { eid: rig.mover.eid, wireType: 1 },
      { eid: rig.mover.eid, wireType: 2 },
    ]);
  });

  it("does not re-send an entity that the view's own change took out of the view and brought back in one frame", () => {
    const rig = connect();
    const session = [...rig.world.entities.values()].find((e) => e.has(NetworkClient))!;

    // The query leaves the entity when it moves to C, and the new DSL, which takes in C too, brings
    // it back when the session's tracker is replaced, all before the frame is built.
    rig.mover.add(InCell, rig.cells.c);
    session.set(View, {
      dsl: { any: [{ target: [InCell, CellA] }, { target: [InCell, CellC] }] },
    });

    expect(rig.step()).toEqual([]);
  });
});

describe("a client whose entity stops being Networked and is Networked again in one frame", () => {
  let sim: ReplicationSim | undefined;

  afterEach(() => {
    sim?.dispose();
    sim = undefined;
  });

  it("still has the entity, with the components it has now, and never saw it leave", () => {
    sim = new ReplicationSim({
      networkComponents: [Position, Health],
      seed: 1,
      link: symmetric({ oneWayMs: 20 }),
    });
    const entity = sim.server
      .entity()
      .add(Networked)
      .set(Position, { x: 1, y: 2 })
      .set(Health, { hp: 50 });
    const client = sim.addClient();
    sim.run(1_000);
    expect(sim.diffFromServer(client)).toEqual([]);

    // Health goes while the entity is not Networked and Position changes meanwhile.
    entity.remove(Networked);
    entity.remove(Health);
    entity.set(Position, { x: 9, y: 9 });
    entity.add(Networked);
    sim.run(1_000);

    expect(sim.diffFromServer(client)).toEqual([]);
    expect(client.stats).toMatchObject({ enters: 1, exits: 0, errors: [], disconnects: [] });
  });
});
