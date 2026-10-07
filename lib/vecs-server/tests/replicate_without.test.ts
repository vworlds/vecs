import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_COMPONENTS,
  Client2Server,
  ComponentSnapshot,
  Server2Client,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, wireType } from "@vworlds/vecs-wire";
import { Module, type ComponentClass, type Entity } from "@vworlds/vecs";
import { performance } from "node:perf_hooks";
import {
  NetworkClient,
  Networked,
  ServerWorld,
  View,
  type ServerWorldOptions,
} from "../src/index.js";
import { symmetric } from "./harness/lossy_link.js";
import { ReplicationSim, type SimClient } from "./harness/replication_sim.js";

// `ServerWorld.replicateWithout(C, T)`: a network component C that is not replicated on the
// entities that have T. The server keeps writing C for its own systems; clients stop receiving it
// while T is present, keep the last value they had, and get the current value again once T goes.

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

/** The excluding component of these tests. It is a network component itself, as dead reckoning's `Motion` is. */
class Motion {
  @wireType("u32")
  public frame = 0;
}

/** A server-local tag, to show the excluding component does not have to be replicated. */
class Hidden {}

const NETWORK_COMPONENTS: ComponentClass[] = [Position, Health, Motion];

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

const TICK_MS = 40;
let nowMs = 0;

beforeEach(() => {
  nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A world whose sessions see every networked entity, and the names its entities print as. */
interface Rig {
  world: ServerWorld;
  listener: MockListener;
  names: Map<number, string>;
}

function createRig(options: ServerWorldOptions = {}): Rig {
  const world = new ServerWorld({
    name: "main",
    networkComponents: NETWORK_COMPONENTS,
    ...options,
  });
  world.component(NetworkClient).on("set", (entity) => {
    entity.set(View, { dsl: true });
  });
  const listener = new MockListener();
  world._attach(listener);
  return { world, listener, names: new Map() };
}

/** A replicated entity at `x`, with full health, printed as `name` in frame summaries. */
function spawn(rig: Rig, name: string, x: number): Entity {
  const entity = rig.world
    .entity()
    .add(Networked)
    .set(Position, { x, y: 0 })
    .set(Health, { hp: 100 });
  rig.names.set(entity.eid, name);
  return entity;
}

function connect(rig: Rig, id = "client-1"): MemorySocket {
  const socket = new MemorySocket(id);
  rig.listener.connect(socket);
  return socket;
}

/** Run one server frame and return what it sent `socket`, if anything. */
function step(rig: Rig, socket: MemorySocket): Server2Client | undefined {
  const before = socket.sent.length;
  rig.world.progress(nowMs, TICK_MS);
  nowMs += TICK_MS;
  const frames = socket.sent.slice(before).map((bytes) => new Decoder(bytes).read(Server2Client));
  expect(frames.length).toBeLessThanOrEqual(1);
  return frames[0];
}

function ack(socket: MemorySocket, ackFrame: number): void {
  const encoder = new Encoder(new Uint8Array(1024));
  encoder.write(new Client2Server({ ackFrame }));
  socket.receive(encoder.getBuffer());
}

/** Run a frame, expect it to carry state, and ack it as a client that received it would. */
function stepAndAck(rig: Rig, socket: MemorySocket): FrameSummary {
  const frame = step(rig, socket);
  expect(frame?.diff).toBeDefined();
  ack(socket, frame!.diff!.toFrame);
  return summarize(rig, frame!);
}

interface FrameSummary {
  baseline: boolean;
  /** `"<entity> <Component> <json>"`, sorted. */
  snapshots: string[];
  /** `"<entity> <Component>"`, or `"<entity> *"` for a whole-entity removal, sorted. */
  removed: string[];
}

function summarize(rig: Rig, frame: Server2Client): FrameSummary {
  const diff = frame.diff!;
  const name = (eid: number): string => rig.names.get(eid) ?? `#${eid}`;
  const snapshots = diff.snapshots.map((encoded) => {
    const snapshot = new Decoder(encoded.bytes).read(ComponentSnapshot);
    const Class = NETWORK_COMPONENTS[snapshot.wireType - 1];
    const value = new Decoder(snapshot.payload).read(Class);
    return `${name(snapshot.eid)} ${Class.name} ${JSON.stringify(value)}`;
  });
  const removed = diff.removed.map(([eid, type]) =>
    type === ALL_COMPONENTS ? `${name(eid)} *` : `${name(eid)} ${NETWORK_COMPONENTS[type - 1].name}`
  );
  return { baseline: diff.fromFrame === 0, snapshots: snapshots.sort(), removed: removed.sort() };
}

/**
 * A world that does not replicate Position on entities with Motion, holding `a` and `b`, and one
 * client that has acked its baseline.
 */
function connectedRig(): { rig: Rig; socket: MemorySocket; a: Entity; b: Entity } {
  const rig = createRig();
  rig.world.replicateWithout(Position, Motion);
  const a = spawn(rig, "a", 1);
  const b = spawn(rig, "b", 2);
  const socket = connect(rig);
  expect(stepAndAck(rig, socket)).toEqual({
    baseline: true,
    snapshots: [
      'a Health {"hp":100}',
      'a Position {"x":1,"y":0}',
      'b Health {"hp":100}',
      'b Position {"x":2,"y":0}',
    ],
    removed: [],
  });
  return { rig, socket, a, b };
}

describe("ServerWorld.replicateWithout", () => {
  it("stops replicating the component while the entity has the excluding one, and sends no removal", () => {
    const { rig, socket, a, b } = connectedRig();

    a.set(Position, { x: 10, y: 0 }).set(Motion, { frame: 7 }).set(Health, { hp: 90 });
    b.set(Position, { x: 20, y: 0 });
    expect(stepAndAck(rig, socket)).toEqual({
      baseline: false,
      snapshots: ['a Health {"hp":90}', 'a Motion {"frame":7}', 'b Position {"x":20,"y":0}'],
      removed: [],
    });

    // Moving `a` alone leaves nothing to send at all.
    a.set(Position, { x: 11, y: 0 });
    expect(step(rig, socket)).toBeUndefined();
    a.set(Position, { x: 12, y: 0 });
    expect(step(rig, socket)).toBeUndefined();
  });

  it("sends the current value, as if the component had just entered, once the excluding component goes", () => {
    const { rig, socket, a } = connectedRig();
    a.add(Motion);
    stepAndAck(rig, socket);
    a.set(Position, { x: 30, y: 4 });
    expect(step(rig, socket)).toBeUndefined();

    a.remove(Motion);
    expect(stepAndAck(rig, socket)).toEqual({
      baseline: false,
      snapshots: ['a Position {"x":30,"y":4}'],
      removed: ["a Motion"],
    });

    // And it replicates normally again.
    a.set(Position, { x: 31, y: 4 });
    expect(stepAndAck(rig, socket).snapshots).toEqual(['a Position {"x":31,"y":4}']);
  });

  it("leaves the component out of the snapshots of an entity entering a view", () => {
    const { rig, socket } = connectedRig();

    const c = spawn(rig, "c", 3).set(Motion, { frame: 2 });
    expect(stepAndAck(rig, socket)).toEqual({
      baseline: false,
      snapshots: ['c Health {"hp":100}', 'c Motion {"frame":2}'],
      removed: [],
    });

    // A second client connecting now gets a baseline without it too.
    const late = connect(rig, "client-2");
    c.set(Position, { x: 33, y: 0 });
    expect(stepAndAck(rig, late)).toEqual({
      baseline: true,
      snapshots: [
        'a Health {"hp":100}',
        'a Position {"x":1,"y":0}',
        'b Health {"hp":100}',
        'b Position {"x":2,"y":0}',
        'c Health {"hp":100}',
        'c Motion {"frame":2}',
      ],
      removed: [],
    });
  });

  it("leaves the component out of the baseline that rebuilds a client that fell out of the history window", () => {
    const rig = createRig({ historyFrames: 2 });
    rig.world.replicateWithout(Position, Motion);
    const a = spawn(rig, "a", 1).set(Motion, { frame: 1 });
    const b = spawn(rig, "b", 2);
    const socket = connect(rig);
    const baseline = step(rig, socket)!;
    ack(socket, baseline.diff!.toFrame);

    // The client stops acking while `b` keeps moving, until a frame it lacks leaves the window.
    const frames: FrameSummary[] = [];
    for (let i = 0; i < 4; i++) {
      a.set(Position, { x: 100 + i, y: 0 });
      b.set(Position, { x: 200 + i, y: 0 });
      const frame = step(rig, socket);
      if (frame?.diff !== undefined) {
        frames.push(summarize(rig, frame));
      }
    }

    const recovery = frames.filter((frame) => frame.baseline);
    expect(recovery).toEqual([
      {
        baseline: true,
        snapshots: [
          'a Health {"hp":100}',
          'a Motion {"frame":1}',
          'b Health {"hp":100}',
          'b Position {"x":202,"y":0}',
        ],
        removed: [],
      },
    ]);
    expect(
      frames.flatMap((frame) => frame.snapshots).filter((s) => s.startsWith("a Position"))
    ).toEqual([]);
  });

  it("still replicates the removal of the component while the entity has the excluding one", () => {
    const { rig, socket, a } = connectedRig();
    a.add(Motion);
    stepAndAck(rig, socket);

    a.remove(Position);
    expect(stepAndAck(rig, socket)).toEqual({
      baseline: false,
      snapshots: [],
      removed: ["a Position"],
    });

    // Nothing comes back when the exclusion ends: the entity has no Position to send.
    a.remove(Motion);
    expect(stepAndAck(rig, socket)).toEqual({
      baseline: false,
      snapshots: [],
      removed: ["a Motion"],
    });
  });

  it("sends the new value when the component is removed and added again within one frame", () => {
    const { rig, socket, b } = connectedRig();

    b.remove(Position);
    b.set(Position, { x: 9, y: 9 });
    expect(stepAndAck(rig, socket)).toEqual({
      baseline: false,
      snapshots: ['b Position {"x":9,"y":9}'],
      removed: [],
    });
  });

  it("accepts any number of excluding components, from one call or several", () => {
    const rig = createRig();
    rig.world.replicateWithout(Position, Motion);
    rig.world.replicateWithout(Position, Hidden, Motion);
    const a = spawn(rig, "a", 1);
    const b = spawn(rig, "b", 2);
    const socket = connect(rig);
    stepAndAck(rig, socket);

    a.add(Hidden).set(Position, { x: 5, y: 0 });
    b.add(Motion).set(Position, { x: 6, y: 0 });
    expect(stepAndAck(rig, socket)).toEqual({
      baseline: false,
      snapshots: ['b Motion {"frame":0}'],
      removed: [],
    });

    a.remove(Hidden);
    expect(stepAndAck(rig, socket).snapshots).toEqual(['a Position {"x":5,"y":0}']);
  });

  it("can be declared from a module's init(), after the world has already been flushed", () => {
    class DeadReckoningLike extends Module {
      public init(): void {
        (this.world as ServerWorld).replicateWithout(Position, Motion);
      }
    }
    const rig = createRig();
    const a = spawn(rig, "a", 1).add(Motion);
    spawn(rig, "b", 2);
    rig.world.flush();
    rig.world.module(DeadReckoningLike);
    const socket = connect(rig);

    expect(stepAndAck(rig, socket)).toEqual({
      baseline: true,
      snapshots: [
        'a Health {"hp":100}',
        'a Motion {"frame":0}',
        'b Health {"hp":100}',
        'b Position {"x":2,"y":0}',
      ],
      removed: [],
    });
    a.set(Position, { x: 50, y: 0 });
    expect(step(rig, socket)).toBeUndefined();
  });

  it("leaves other components, and entities without the excluding component, replicating as before", () => {
    // The same script against a world with the filter and one without: every frame matches once
    // `a`'s Position, the one thing the filter is for, is taken out.
    const script = (rig: Rig, socket: MemorySocket): FrameSummary[] => {
      const a = spawn(rig, "a", 1);
      const b = spawn(rig, "b", 2);
      const frames: FrameSummary[] = [stepAndAck(rig, socket)];
      for (let i = 0; i < 6; i++) {
        if (i === 1) {
          a.add(Motion);
        }
        if (i === 4) {
          a.remove(Motion);
        }
        a.set(Position, { x: 10 + i, y: i }).set(Health, { hp: 90 - i });
        b.set(Position, { x: 20 + i, y: i });
        if (i % 2 === 0) {
          b.set(Health, { hp: 80 - i });
        }
        frames.push(stepAndAck(rig, socket));
      }
      b.remove(Health);
      frames.push(stepAndAck(rig, socket));
      b.destroy();
      frames.push(stepAndAck(rig, socket));
      return frames;
    };
    const filtered = createRig();
    filtered.world.replicateWithout(Position, Motion);
    const plain = createRig();

    const withFilter = script(filtered, connect(filtered));
    const withoutFilter = script(plain, connect(plain));

    const excluded = new Set(["a Position"]);
    const strip = (frames: FrameSummary[]): FrameSummary[] =>
      frames.map((frame) => ({
        ...frame,
        snapshots: frame.snapshots.filter((s) => !excluded.has(s.split(" ", 2).join(" "))),
      }));
    expect(strip(withFilter)).toEqual(strip(withoutFilter));
    expect(withFilter[withFilter.length - 1].removed).toEqual(["b *"]);
    // `a`'s Position goes out while `a` has no Motion, and once more when Motion goes.
    const aPositions = (frames: FrameSummary[]): string[] =>
      frames.flatMap((frame) => frame.snapshots.filter((s) => s.startsWith("a Position")));
    expect(aPositions(withoutFilter)).toHaveLength(7);
    expect(aPositions(withFilter)).toEqual([
      'a Position {"x":1,"y":0}',
      'a Position {"x":10,"y":0}',
      'a Position {"x":14,"y":4}',
      'a Position {"x":15,"y":5}',
    ]);
  });

  it("throws once the world has sent a frame", () => {
    const rig = createRig();
    rig.world.progress(0, TICK_MS);

    expect(() => rig.world.replicateWithout(Position, Motion)).toThrow(
      /must be declared before the world replicates its first frame/
    );
  });

  it("throws for a component that is not one of the world's network components", () => {
    const rig = createRig();

    expect(() => rig.world.replicateWithout(Hidden, Motion)).toThrow(
      /Hidden is not a network component of world 'main'/
    );
  });

  it("throws for a component that would exclude itself", () => {
    const rig = createRig();

    expect(() => rig.world.replicateWithout(Position, Motion, Position)).toThrow(
      /Position cannot exclude itself/
    );
  });
});

// The filter end to end, over the loss/latency harness of #216: a real ServerWorld and
// ClientWorld, an unordered link with loss and reordering, ack/retransmit through the history,
// and a stall that forces a recovery baseline.
describe("replicateWithout over a lossy, high-latency link", () => {
  const HARSH_LINK = symmetric({ oneWayMs: 100, loss: 0.05, reorder: 0.1, reorderExtraMs: 60 });
  const SETTLE_MS = 800;
  /** Longer than the default history window, which is about 2.1 s at 30 Hz. */
  const STALL_MS = 3_500;

  let sim: ReplicationSim | undefined;

  afterEach(() => {
    sim?.dispose();
    sim = undefined;
  });

  it.each([1, 2, 3])(
    "seed %i: the client keeps the last value while excluded, rebuilds without it, and converges once the exclusion ends",
    (seed) => {
      const simulation = new ReplicationSim({
        networkComponents: [Position, Health, Motion],
        seed,
        link: HARSH_LINK,
      });
      sim = simulation;
      simulation.server.replicateWithout(Position, Motion);
      const entities: Entity[] = [];
      for (let i = 0; i < 20; i++) {
        entities.push(
          simulation.server
            .entity()
            .add(Networked)
            .set(Position, { x: i * 10, y: i })
            .set(Health, { hp: 100 })
        );
      }
      const excluded = entities.filter((_, index) => index % 2 === 0);
      const included = entities.filter((_, index) => index % 2 === 1);
      let moving = true;
      let excludeAtTick: number | undefined;
      const lastSentX = new Map<Entity, number>();
      simulation.onTick((tick) => {
        if (tick === excludeAtTick) {
          // What the client last got is the value before this tick's move: the move below
          // happens in the frame that adds Motion, so it is never replicated.
          excluded.forEach((entity) => {
            lastSentX.set(entity, entity.get(Position)!.x);
            entity.set(Motion, { frame: tick });
          });
        }
        if (!moving) {
          return;
        }
        entities.forEach((entity, index) => {
          const position = entity.get(Position)!;
          entity.set(Position, { x: position.x + 1, y: position.y });
          if (tick % 4 === index % 4) {
            entity.set(Health, { hp: (entity.get(Health)!.hp + 7) % 101 });
          }
        });
      });
      const client = simulation.addClient();
      const onClient = (entity: Entity): Entity => {
        const replica = client.world.getEntity(entity.eid);
        expect(replica).toBeDefined();
        return replica!;
      };

      // Replicate normally, then exclude half the entities' Position while they keep moving.
      simulation.run(3_000);
      excludeAtTick = simulation.ticks;
      simulation.run(3_000);
      moving = false;
      simulation.run(SETTLE_MS);

      expect(clientHealth(client)).toEqual({ errors: [], disconnects: [], resets: 1 });
      expect(simulation.diffFromServer(client, [Health, Motion])).toEqual([]);
      expect(simulation.diffFromServer(client, [Position])).toHaveLength(excluded.length);
      excluded.forEach((entity) => {
        expect(onClient(entity).get(Position)?.x).toBe(lastSentX.get(entity));
        expect(entity.get(Position)!.x).toBeGreaterThan(lastSentX.get(entity)! + 50);
      });
      included.forEach((entity) => {
        expect(onClient(entity).get(Position)).toEqual(entity.get(Position));
      });

      // A stall longer than the window while everything moves: the recovery baseline rebuilds
      // the client, and the excluded entities come back without Position.
      moving = true;
      client.setBlocked("both", true);
      simulation.run(STALL_MS);
      client.setBlocked("both", false);
      simulation.run(3_000);
      moving = false;
      simulation.run(SETTLE_MS);

      expect(clientHealth(client)).toEqual({ errors: [], disconnects: [], resets: 2 });
      expect(simulation.diffFromServer(client, [Health, Motion])).toEqual([]);
      excluded.forEach((entity) => {
        expect(onClient(entity).get(Position)).toBeUndefined();
        expect(onClient(entity).get(Motion)).toEqual(entity.get(Motion));
      });
      included.forEach((entity) => {
        expect(onClient(entity).get(Position)).toEqual(entity.get(Position));
      });

      // The exclusion ends while everything moves again: every Position converges.
      excluded.forEach((entity) => entity.remove(Motion));
      moving = true;
      simulation.run(3_000);
      moving = false;
      simulation.run(SETTLE_MS);

      expect(clientHealth(client)).toEqual({ errors: [], disconnects: [], resets: 2 });
      expect(simulation.diffFromServer(client)).toEqual([]);
    },
    120_000
  );

  function clientHealth(client: SimClient) {
    return {
      errors: client.stats.errors,
      disconnects: client.stats.disconnects,
      resets: client.stats.resets.length,
    };
  }
});
