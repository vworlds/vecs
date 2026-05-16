import { describe, expect, it } from "vitest";
import { type VecsSocket, type VecsSocketListener } from "@vworlds/vecs-protocol";
import { Decoder, Encoder, type IEncodable, type as wireType } from "@vworlds/vecs-wire";
import { ALL_COMPONENTS, World, cid_pack } from "@vworlds/vecs";
import { Client2Server, ComponentSnapshot, Server2Client } from "@vworlds/vecs-protocol";
import { NetworkClient, NetworkInput, Networked, VecsServer, View } from "../src/index.js";

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

class LocalOnly {
  public value = 0;
}

class Velocity {
  public x = 0;
}

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
    this._handlers.forEach((h) => h(socket));
  }
}

function encodeClient2Server(message: Client2Server): Uint8Array {
  return encodeMessage(message);
}

function encodeMessage(message: IEncodable, size = 64 * 1024): Uint8Array {
  const encoder = new Encoder(new Uint8Array(size));
  encoder.write(message);
  return encoder.getBuffer();
}

function decodeFirstSnapshotPayload(bytes: Uint8Array): Position {
  const message = new Decoder(bytes).read(Server2Client);
  const snapshot = new Decoder(message.diff!.snapshots[0]).read(ComponentSnapshot);
  return new Decoder(snapshot.payload).read(Position);
}

describe("VecsServer", () => {
  it("sends full component snapshots for networked component updates", () => {
    const world = new World();
    world.registerComponent(Position, 1);
    world.registerComponent(LocalOnly);
    const server = new VecsServer("main", world);
    const socket = new MemorySocket("client-1");
    server.registerComponent(Position);
    const listener = new MockListener();
    server._attach(listener);
    server.installSystems();
    world.start();
    listener.connect(socket);

    const entity = world.entity();
    entity.add(Networked).set(Position, { x: 10, y: 20 }).set(LocalOnly, { value: 5 });
    world.progress(0, 16);

    // sent[0] is the join snapshot (no Position yet at connect time).
    // The most recent message contains the diff produced by progress().
    const last = socket.sent[socket.sent.length - 1];
    const message = new Decoder(last).read(Server2Client);
    const snapshot = new Decoder(message.diff!.snapshots[0]).read(ComponentSnapshot);
    const position = new Decoder(snapshot.payload).read(Position);

    expect(snapshot.cid).toBe(cid_pack(entity.eid, 1));
    expect(position).toMatchObject({ x: 10, y: 20 });
    expect(message.diff!.removed).toEqual([]);
  });

  it("sends component removals when a synchronized component exits", () => {
    const world = new World();
    world.registerComponent(Position, 1);
    const server = new VecsServer("main", world);
    const socket = new MemorySocket("client-1");
    server.registerComponent(Position);
    const listener = new MockListener();
    server._attach(listener);
    server.installSystems();
    world.start();
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 2 });
    world.progress(0, 16);
    const removalStart = socket.sent.length;

    entity.remove(Position);
    world.progress(16, 16);

    const last = socket.sent[socket.sent.length - 1];
    expect(socket.sent.length).toBeGreaterThan(removalStart);
    const message = new Decoder(last).read(Server2Client);
    expect(message.diff!.removed).toEqual([cid_pack(entity.eid, 1)]);
    expect(message.diff!.snapshots).toEqual([]);
  });

  it("sends entity destruction when a networked entity is destroyed", () => {
    const world = new World();
    world.registerComponent(Position, 1);
    const server = new VecsServer("main", world);
    const socket = new MemorySocket("client-1");
    server.registerComponent(Position);
    const listener = new MockListener();
    server._attach(listener);
    server.installSystems();
    world.start();
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 2 });
    world.progress(0, 16);
    const removalStart = socket.sent.length;

    entity.destroy();
    world.progress(16, 16);

    const last = socket.sent[socket.sent.length - 1];
    expect(socket.sent.length).toBeGreaterThan(removalStart);
    const message = new Decoder(last).read(Server2Client);
    expect(message.diff!.removed).toContain(cid_pack(entity.eid, ALL_COMPONENTS));
  });

  it("sends entity destruction when Networked exits", () => {
    const world = new World();
    world.registerComponent(Position, 1);
    const server = new VecsServer("main", world);
    const socket = new MemorySocket("client-1");
    server.registerComponent(Position);
    const listener = new MockListener();
    server._attach(listener);
    server.installSystems();
    world.start();
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 2 });
    world.progress(0, 16);
    const removalStart = socket.sent.length;

    entity.remove(Networked);
    world.progress(16, 16);

    const last = socket.sent[socket.sent.length - 1];
    expect(socket.sent.length).toBeGreaterThan(removalStart);
    const message = new Decoder(last).read(Server2Client);
    expect(message.diff!.removed).toContain(cid_pack(entity.eid, ALL_COMPONENTS));
  });

  it("sends current networked state only to the late-joining client", () => {
    const world = new World();
    world.registerComponent(Position, 1);
    const server = new VecsServer("main", world);
    server.registerComponent(Position);

    const first = new MemorySocket("client-1");
    const listener = new MockListener();
    server._attach(listener);
    server.installSystems();
    world.start();
    listener.connect(first);

    const entity = world.entity().add(Networked).set(Position, { x: 30, y: 40 });
    world.progress(0, 16);
    const firstSentBeforeJoin = first.sent.length;

    const late = new MemorySocket("client-2");
    listener.connect(late);

    expect(late.sent.length).toBe(1);
    const position = decodeFirstSnapshotPayload(late.sent[0]);
    expect(position).toMatchObject({ x: 30, y: 40 });
    // existing client must not have received anything as a side-effect of the join
    expect(first.sent.length).toBe(firstSentBeforeJoin);

    // hide eid reference for type-narrowing in subsequent assertions
    expect(entity.eid).toBeGreaterThan(0);
  });

  it("creates a NetworkClient entity on connect and destroys it on disconnect", () => {
    const world = new World();
    const server = new VecsServer("main", world);
    const listener = new MockListener();
    server._attach(listener);
    server.installSystems();

    const seen: { connected: number[]; disconnected: number[] } = {
      connected: [],
      disconnected: [],
    };
    world
      .system("track-clients")
      .requires(Networked, NetworkClient)
      .enter([NetworkClient], (e, [client]) => {
        seen.connected.push(e.eid);
        expect(client?.id).toMatch(/client-/);
      })
      .exit((e) => {
        seen.disconnected.push(e.eid);
      });
    world.start();

    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    world.progress(0, 16);
    expect(seen.connected).toHaveLength(1);

    socket.close();
    world.progress(16, 16);
    expect(seen.disconnected).toEqual(seen.connected);
  });

  it("writes incoming input to the connected client's NetworkInput component", () => {
    const world = new World();
    const server = new VecsServer("main", world);
    const listener = new MockListener();
    server._attach(listener);
    server.installSystems();
    let observed: unknown = null;
    world
      .system("read-input")
      .requires(Networked, NetworkInput)
      .update(NetworkInput, (_e, ni) => {
        observed = ni.input;
      });
    world.start();

    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    world.progress(0, 16);

    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 0, input: { up: true } })));
    world.progress(16, 16);

    expect(observed).toEqual({ up: true });
  });

  it("collapses update-then-remove within a frame into a single removal", () => {
    const world = new World();
    world.registerComponent(Position, 1);
    const server = new VecsServer("main", world);
    server.registerComponent(Position);
    const listener = new MockListener();
    server._attach(listener);
    server.installSystems();
    world.start();
    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    const baseline = socket.sent.length;

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 1 });

    // Within a single progress step, update then remove Position.
    entity.set(Position, { x: 9, y: 9 });
    entity.remove(Position);
    world.progress(0, 16);

    const after = socket.sent.slice(baseline);
    expect(after.length).toBe(1);
    const message = new Decoder(after[0]).read(Server2Client);
    expect(message.diff!.snapshots).toEqual([]);
    expect(message.diff!.removed).toEqual([cid_pack(entity.eid, 1)]);
  });

  it("collapses remove-then-readd within a frame into a single snapshot", () => {
    const world = new World();
    world.registerComponent(Position, 1);
    const server = new VecsServer("main", world);
    server.registerComponent(Position);
    const listener = new MockListener();
    server._attach(listener);
    server.installSystems();
    world.start();
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 5, y: 5 });
    world.progress(0, 16);
    const initialCount = socket.sent.length;

    // Remove then re-add Position within the next frame.
    entity.remove(Position);
    entity.set(Position, { x: 7, y: 7 });
    world.progress(16, 16);

    const after = socket.sent.slice(initialCount);
    const lastDiff = new Decoder(after[after.length - 1]).read(Server2Client).diff;
    expect(lastDiff?.removed ?? []).toEqual([]);
    expect(lastDiff?.snapshots.length).toBe(1);
    const snap = new Decoder(lastDiff!.snapshots[0]).read(ComponentSnapshot);
    expect(snap.cid).toBe(cid_pack(entity.eid, 1));
    const pos = new Decoder(snap.payload).read(Position);
    expect(pos).toMatchObject({ x: 7, y: 7 });
  });

  it("uses the buffer ref pattern but produces independent message buffers", () => {
    const world = new World();
    world.registerComponent(Position, 1);
    const server = new VecsServer("main", world, { encodeBufferSize: 1024 });
    server.registerComponent(Position);
    const listener = new MockListener();
    server._attach(listener);
    server.installSystems();
    world.start();
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 1 });
    world.progress(0, 16);

    entity.set(Position, { x: 2, y: 2 });
    world.progress(16, 16);

    // Decode each captured message independently. If the server were reusing
    // the same buffer without slicing, the older message bytes would have been
    // overwritten by the newer one.
    expect(socket.sent.length).toBeGreaterThanOrEqual(2);
    const m1 = new Decoder(socket.sent[socket.sent.length - 2]).read(Server2Client);
    const m2 = new Decoder(socket.sent[socket.sent.length - 1]).read(Server2Client);
    const p1 = new Decoder(new Decoder(m1.diff!.snapshots[0]).read(ComponentSnapshot).payload).read(
      Position
    );
    const p2 = new Decoder(new Decoder(m2.diff!.snapshots[0]).read(ComponentSnapshot).payload).read(
      Position
    );
    expect(p1).toMatchObject({ x: 1, y: 1 });
    expect(p2).toMatchObject({ x: 2, y: 2 });
  });

  it("renames listen to handleRpc and applies registered handlers to new sessions", () => {
    const world = new World();
    const server = new VecsServer("main", world);
    server.handleRpc(42, (_params, req) => {
      expect(req.rpcId).toBe(42);
      return [];
    });
    // handler registration must be retroactive to sessions opened later
    const listener = new MockListener();
    server._attach(listener);
    server.installSystems();
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    const surface = server as unknown as Record<string, unknown>;
    expect(typeof surface.handleRpc).toBe("function");
    expect(surface.listen).toBeUndefined();
    expect(surface.addSocket).toBeUndefined();
    expect(surface.getInput).toBeUndefined();
  });

  it("acquires a View tracker that tracks matching entities", () => {
    const world = new World();
    world.registerComponent(Position);
    const server = new VecsServer("main", world);
    server.installSystems();
    world.start();

    const matching = world.entity().add(Position);
    const other = world.entity();
    const viewer = world.entity().set(View, { dsl: [Position] });
    const view = viewer.get(View)!;
    world.progress(0, 16);

    expect(view.tracker.has(matching)).toBe(true);
    expect(view.tracker.has(other)).toBe(false);
    expect(view.tracker.count).toBe(1);
  });

  it("shares cached trackers for equivalent View DSL", () => {
    const world = new World();
    world.registerComponent(Position);
    const server = new VecsServer("main", world);
    server.installSystems();
    world.start();

    const first = world
      .entity()
      .set(View, { dsl: [Position] })
      .get(View)!;
    const second = world
      .entity()
      .set(View, { dsl: { HAS: Position } })
      .get(View)!;
    world.progress(0, 16);

    expect(first.tracker).toBe(second.tracker);
  });

  it("moves the previous tracker to old tracker and installs a new tracker on View set", () => {
    const world = new World();
    world.registerComponent(Position);
    world.registerComponent(Velocity);
    const server = new VecsServer("main", world);
    server.installSystems();
    world.start();

    const positionEntity = world.entity().add(Position);
    const velocityEntity = world.entity().add(Velocity);
    const viewer = world.entity().set(View, { dsl: [Position] });
    const view = viewer.get(View)!;
    world.progress(0, 16);
    const original = view.tracker;

    viewer.set(View, { dsl: [Velocity] });
    world.progress(16, 16);

    expect(view._old_tracker).toBe(original);
    expect(view.tracker).not.toBe(original);
    expect(view.tracker.has(velocityEntity)).toBe(true);
    expect(view.tracker.has(positionEntity)).toBe(false);
  });

  it("builds a View tracker when View is set during a system run", () => {
    const world = new World();
    world.registerComponent(Position);
    const server = new VecsServer("main", world);
    let target: ReturnType<World["entity"]>;
    let viewer: ReturnType<World["entity"]>;
    let observed = false;

    world.system("set-view").run(() => {
      viewer!.set(View, { dsl: [Position] });
    });
    server.installSystems();
    world.system("read-view").run(() => {
      observed = viewer!.get(View)?.tracker.has(target!) === true;
    });
    world.start();
    target = world.entity().add(Position);
    viewer = world.entity().add(View);
    world.progress(0, 16);

    expect(observed).toBe(true);
  });

  it("releases active and old trackers when View is removed", () => {
    const world = new World();
    world.registerComponent(Position);
    world.registerComponent(Velocity);
    const server = new VecsServer("main", world);
    server.installSystems();
    world.start();

    const viewer = world.entity().set(View, { dsl: [Position] });
    const view = viewer.get(View)!;
    world.progress(0, 16);
    const original = view.tracker;
    viewer.set(View, { dsl: [Velocity] });
    world.progress(16, 16);
    const replacement = view.tracker;

    viewer.remove(View);
    world.progress(32, 16);
    const nextPosition = world
      .entity()
      .set(View, { dsl: [Position] })
      .get(View)!;
    const nextVelocity = world
      .entity()
      .set(View, { dsl: [Velocity] })
      .get(View)!;
    world.progress(48, 16);

    expect(nextPosition.tracker).not.toBe(original);
    expect(nextVelocity.tracker).not.toBe(replacement);
  });

  it("preserves the first old tracker across repeated View sets", () => {
    const world = new World();
    world.registerComponent(Position);
    world.registerComponent(Velocity);
    world.registerComponent(LocalOnly);
    const server = new VecsServer("main", world);
    server.installSystems();
    world.start();

    const positionEntity = world.entity().add(Position);
    const velocityEntity = world.entity().add(Velocity);
    const localEntity = world.entity().add(LocalOnly);
    const viewer = world.entity().set(View, { dsl: [Position] });
    const view = viewer.get(View)!;
    world.progress(0, 16);
    const original = view.tracker;

    world.defer(() => {
      viewer.set(View, { dsl: [Velocity] });
      viewer.set(View, { dsl: [LocalOnly] });
    });
    world.progress(16, 16);

    expect(view._old_tracker).toBe(original);
    expect(view.tracker).not.toBe(original);
    expect(view.tracker.has(positionEntity)).toBe(false);
    expect(view.tracker.has(velocityEntity)).toBe(false);
    expect(view.tracker.has(localEntity)).toBe(true);
  });

  it("reuses the old tracker without leaking refs when View DSL changes back", () => {
    const world = new World();
    world.registerComponent(Position);
    world.registerComponent(Velocity);
    const server = new VecsServer("main", world);
    server.installSystems();
    world.start();

    const viewer = world.entity().set(View, { dsl: [Position] });
    const view = viewer.get(View)!;
    world.progress(0, 16);
    const original = view.tracker;

    viewer.set(View, { dsl: [Velocity] });
    world.progress(16, 16);
    const replacement = view.tracker;
    expect(replacement).not.toBe(original);

    viewer.set(View, { dsl: [Position] });
    world.progress(32, 16);
    expect(view.tracker).toBe(original);

    viewer.remove(View);
    world.progress(48, 16);
    const nextPosition = world
      .entity()
      .set(View, { dsl: [Position] })
      .get(View)!;
    const nextVelocity = world
      .entity()
      .set(View, { dsl: [Velocity] })
      .get(View)!;
    world.progress(64, 16);

    expect(nextPosition.tracker).not.toBe(original);
    expect(nextVelocity.tracker).not.toBe(replacement);
  });

  it("reuses the old tracker without leaking refs after undefined View DSL", () => {
    const world = new World();
    world.registerComponent(Position);
    const server = new VecsServer("main", world);
    server.installSystems();
    world.start();

    const viewer = world.entity().set(View, { dsl: [Position] });
    const view = viewer.get(View)!;
    world.progress(0, 16);
    const original = view.tracker;

    viewer.set(View, { dsl: undefined });
    world.progress(16, 16);
    expect(() => view.tracker).toThrow("View tracker is undefined");

    viewer.set(View, { dsl: [Position] });
    world.progress(32, 16);
    expect(view.tracker).toBe(original);

    viewer.remove(View);
    world.progress(48, 16);
    const nextPosition = world
      .entity()
      .set(View, { dsl: [Position] })
      .get(View)!;
    world.progress(64, 16);

    expect(nextPosition.tracker).not.toBe(original);
  });

  it("does not acquire an active tracker for undefined View DSL", () => {
    const world = new World();
    world.registerComponent(Position);
    const server = new VecsServer("main", world);
    server.installSystems();
    world.start();

    const empty = world.entity().set(View, { dsl: undefined }).get(View)!;
    world.progress(0, 16);
    expect(() => empty.tracker).toThrow("View tracker is undefined");

    const viewer = world.entity().set(View, { dsl: [Position] });
    const view = viewer.get(View)!;
    world.progress(16, 16);
    const original = view.tracker;

    viewer.set(View, { dsl: undefined });
    world.progress(32, 16);

    expect(view.dsl).toBeUndefined();
    expect(() => view.tracker).toThrow("View tracker is undefined");
    expect(view._old_tracker).toBe(original);
  });
});
