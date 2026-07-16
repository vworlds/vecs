import { describe, expect, it, vi } from "vitest";
import {
  ALL_COMPONENTS,
  Client2Server,
  ComponentSnapshot,
  Server2Client,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import {
  POST_UPDATE,
  PRE_STORE,
  Exclusive,
  type QueryDSL,
  Relationship,
  type Entity,
  type World,
} from "@vworlds/vecs";
import { performance } from "node:perf_hooks";
import {
  EntityTracker,
  type IEntityTrackerListener,
  NetworkClient,
  NetworkInput,
  Networked,
  ServerWorld,
  type ServerWorldOptions,
  View,
} from "../src/index.js";
import { HISTORY_LENGTH } from "../src/history.js";

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

class InCell extends Relationship {}

class CellA {}

class CellB {}

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  public readonly sent: Uint8Array[] = [];
  public closed = false;
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
    this.closed = true;
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
  const snapshot = new Decoder(message.diff!.snapshots[0].bytes).read(ComponentSnapshot);
  return new Decoder(snapshot.payload).read(Position);
}

function decodeLastMessage(socket: MemorySocket): Server2Client {
  return new Decoder(socket.sent[socket.sent.length - 1]).read(Server2Client);
}

interface TestSession {
  entity: Entity;
}

function getSession(server: ServerWorld, socketId: string): TestSession {
  const sessions = (server as unknown as { _sessions: Map<string, TestSession> })._sessions;
  const session = sessions.get(socketId);
  if (!session) {
    throw new Error(`session ${socketId} not found`);
  }
  return session;
}

function getSessionView(server: ServerWorld, socketId: string): Readonly<View> {
  const view = getSession(server, socketId).entity.get(View);
  if (!view) {
    throw new Error(`session ${socketId} has no View`);
  }
  return view;
}

function connectSession(
  server: ServerWorld,
  listener: MockListener,
  socketId = "client-1"
): { session: TestSession; socket: MemorySocket; view: Readonly<View> } {
  const socket = new MemorySocket(socketId);
  listener.connect(socket);
  return { socket, session: getSession(server, socketId), view: getSessionView(server, socketId) };
}

function allowAllClientViews(world: World): void {
  world.component(NetworkClient).onSet((entity) => {
    entity.set(View, { dsl: true });
  });
}

function createWorld(options: ServerWorldOptions = {}): ServerWorld {
  return new ServerWorld({ name: "main", networkComponents: [Position], ...options });
}

describe("ServerWorld", () => {
  it("sends full component snapshots for networked component updates", () => {
    const world = createWorld();
    world.component(LocalOnly);
    const server = world;
    allowAllClientViews(world);
    const socket = new MemorySocket("client-1");
    const listener = new MockListener();
    server._attach(listener);
    listener.connect(socket);

    const entity = world.entity();
    entity.add(Networked).set(Position, { x: 10, y: 20 }).set(LocalOnly, { value: 5 });
    world.progress(0, 16);

    // sent[0] is the join snapshot (no Position yet at connect time).
    // The most recent message contains the diff produced by progress().
    const last = socket.sent[socket.sent.length - 1];
    const message = new Decoder(last).read(Server2Client);
    const snapshot = new Decoder(message.diff!.snapshots[0].bytes).read(ComponentSnapshot);
    const position = new Decoder(snapshot.payload).read(Position);

    expect(snapshot).toMatchObject({ eid: entity.eid, wireType: 1 });
    expect(position).toMatchObject({ x: 10, y: 20 });
    expect(message.diff!.removed).toEqual([]);
  });

  it("sends component removals when a synchronized component exits", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const socket = new MemorySocket("client-1");
    const listener = new MockListener();
    server._attach(listener);
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 2 });
    world.progress(0, 16);
    const removalStart = socket.sent.length;

    entity.remove(Position);
    world.progress(16, 16);

    const last = socket.sent[socket.sent.length - 1];
    expect(socket.sent.length).toBeGreaterThan(removalStart);
    const message = new Decoder(last).read(Server2Client);
    expect(message.diff!.removed).toEqual([[entity.eid, 1]]);
    expect(message.diff!.snapshots).toEqual([]);
  });

  it("sends entity destruction when a networked entity is destroyed", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const socket = new MemorySocket("client-1");
    const listener = new MockListener();
    server._attach(listener);
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 2 });
    world.progress(0, 16);
    const removalStart = socket.sent.length;

    entity.destroy();
    world.progress(16, 16);

    const last = socket.sent[socket.sent.length - 1];
    expect(socket.sent.length).toBeGreaterThan(removalStart);
    const message = new Decoder(last).read(Server2Client);
    expect(message.diff!.removed).toContainEqual([entity.eid, ALL_COMPONENTS]);
  });

  it("sends entity destruction when Networked exits", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const socket = new MemorySocket("client-1");
    const listener = new MockListener();
    server._attach(listener);
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 2 });
    world.progress(0, 16);
    const removalStart = socket.sent.length;

    entity.remove(Networked);
    world.progress(16, 16);

    const last = socket.sent[socket.sent.length - 1];
    expect(socket.sent.length).toBeGreaterThan(removalStart);
    const message = new Decoder(last).read(Server2Client);
    expect(message.diff!.removed).toContainEqual([entity.eid, ALL_COMPONENTS]);
  });

  it("sends current networked state only to the late-joining client", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);

    const first = new MemorySocket("client-1");
    const listener = new MockListener();
    server._attach(listener);
    listener.connect(first);

    const entity = world.entity().add(Networked).set(Position, { x: 30, y: 40 });
    world.progress(0, 16);
    first.receive(encodeClient2Server(new Client2Server({ ackFrame: 1 })));
    const firstSentBeforeJoin = first.sent.length;

    const late = new MemorySocket("client-2");
    listener.connect(late);

    expect(late.sent.length).toBe(0);
    world.progress(16, 16);

    expect(late.sent.length).toBe(1);
    const message = decodeLastMessage(late);
    expect(message.diff?.fromFrame).toBe(0);
    expect(message.diff?.toFrame).toBe(2);
    const position = decodeFirstSnapshotPayload(late.sent[0]);
    expect(position).toMatchObject({ x: 30, y: 40 });
    // existing client must not have received anything as a side-effect of the join
    expect(first.sent.length).toBe(firstSentBeforeJoin);

    // hide eid reference for type-narrowing in subsequent assertions
    expect(entity.eid).toBeGreaterThan(0);
  });

  it("sends merged updates to clients that have not acked", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const listener = new MockListener();
    server._attach(listener);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 1 });
    world.progress(0, 16);
    entity.set(Position, { x: 2, y: 2 });
    world.progress(16, 16);

    const message = decodeLastMessage(socket);
    const position = decodeFirstSnapshotPayload(socket.sent[socket.sent.length - 1]);
    expect(message.diff?.fromFrame).toBe(0);
    expect(message.diff?.toFrame).toBe(2);
    expect(message.diff?.snapshots).toHaveLength(1);
    expect(position).toMatchObject({ x: 2, y: 2 });
    expect(entity.eid).toBeGreaterThan(0);
  });

  it("sends only changes after an acknowledged frame", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const listener = new MockListener();
    server._attach(listener);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 3, y: 3 });
    world.progress(0, 16);
    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 1 })));
    entity.set(Position, { x: 4, y: 4 });
    world.progress(16, 16);

    const message = decodeLastMessage(socket);
    const position = decodeFirstSnapshotPayload(socket.sent[socket.sent.length - 1]);
    expect(message.diff?.fromFrame).toBe(1);
    expect(message.diff?.toFrame).toBe(2);
    expect(message.diff?.snapshots).toHaveLength(1);
    expect(position).toMatchObject({ x: 4, y: 4 });
    expect(entity.eid).toBeGreaterThan(0);
  });

  it("retains empty frames while pulling merged updates", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const listener = new MockListener();
    server._attach(listener);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 5, y: 5 });
    world.progress(0, 16);
    world.progress(16, 16);
    entity.set(Position, { x: 6, y: 6 });
    world.progress(32, 16);

    const message = decodeLastMessage(socket);
    const position = decodeFirstSnapshotPayload(socket.sent[socket.sent.length - 1]);
    expect(message.diff?.fromFrame).toBe(0);
    expect(message.diff?.toFrame).toBe(3);
    expect(position).toMatchObject({ x: 6, y: 6 });
  });

  it("resyncs clients that lag outside the history window", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const listener = new MockListener();
    server._attach(listener);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    world.entity().add(Networked).set(Position, { x: 7, y: 7 });
    world.progress(0, 16);
    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 1 })));
    const sentBeforeLag = socket.sent.length;

    for (let i = 1; i <= HISTORY_LENGTH + 1; i++) {
      world.progress(i * 16, 16);
    }

    expect(socket.closed).toBe(false);
    expect(socket.sent.length).toBeGreaterThan(sentBeforeLag);
    const message = decodeLastMessage(socket);
    const position = decodeFirstSnapshotPayload(socket.sent[socket.sent.length - 1]);
    expect(message.diff?.fromFrame).toBe(0);
    expect(message.diff?.toFrame).toBe(HISTORY_LENGTH + 2);
    expect(message.diff?.snapshots).toHaveLength(1);
    expect(position).toMatchObject({ x: 7, y: 7 });
  });

  it("disconnects only after the grace period elapses without inbound messages", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const world = createWorld({ disconnectGraceMs: 10_000 });
      const server = world;
      allowAllClientViews(world);
      const listener = new MockListener();
      server._attach(listener);
      const socket = new MemorySocket("client-1");
      listener.connect(socket);

      world.entity().add(Networked).set(Position, { x: 7, y: 7 });
      world.progress(0, 16);

      now.mockReturnValue(9_999);
      for (let i = 1; i <= HISTORY_LENGTH + 1; i++) {
        world.progress(i * 16, 16);
      }
      expect(socket.closed).toBe(false);

      now.mockReturnValue(10_001);
      world.progress(100_000, 16);

      expect(socket.closed).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("ignores default ack before the first frame is sent", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const listener = new MockListener();
    server._attach(listener);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 0 })));
    world.entity().add(Networked).set(Position, { x: 8, y: 8 });
    world.progress(0, 16);

    const message = decodeLastMessage(socket);
    const position = decodeFirstSnapshotPayload(socket.sent[socket.sent.length - 1]);
    expect(message.diff?.fromFrame).toBe(0);
    expect(message.diff?.toFrame).toBe(1);
    expect(position).toMatchObject({ x: 8, y: 8 });
  });

  it("creates a NetworkClient entity on connect and destroys it on disconnect", () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const seen: { connected: number[]; disconnected: number[] } = {
      connected: [],
      disconnected: [],
    };
    world
      .system("track-clients")
      .with(Networked, NetworkClient)
      .phase(PRE_STORE)
      .enter([NetworkClient], (e, [client]) => {
        seen.connected.push(e.eid);
        expect(client?.id).toMatch(/client-/);
      })
      .exit((e) => {
        seen.disconnected.push(e.eid);
      });

    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    world.progress(0, 16);
    expect(seen.connected).toHaveLength(1);

    socket.close();
    world.progress(16, 16);
    expect(seen.disconnected).toEqual(seen.connected);
  });

  it("adds a default View to connected clients", () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    const view = getSessionView(server, "client-1");

    expect(view.dsl).toBe(false);
    world.progress(0, 16);
    expect(view.tracker.count).toBe(0);
    expect(view._visible).toEqual(new Set());
  });

  it("writes incoming input to the connected client's NetworkInput component", () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    let observed: unknown = null;
    world
      .system("read-input")
      .with(Networked, NetworkInput)
      .phase(PRE_STORE)
      .update({ watch: NetworkInput, onEnter: true }, (_e, ni) => {
        observed = ni.input;
      });

    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    world.progress(0, 16);

    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 0, input: { up: true } })));
    world.progress(16, 16);

    expect(observed).toEqual({ up: true });
  });

  it("collapses update-then-remove within a frame into a single removal", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const listener = new MockListener();
    server._attach(listener);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 1 });
    world.progress(0, 16);
    const baseline = socket.sent.length;

    // Within a single progress step, update then remove Position.
    entity.set(Position, { x: 9, y: 9 });
    entity.remove(Position);
    world.progress(16, 16);

    const after = socket.sent.slice(baseline);
    expect(after.length).toBe(1);
    const message = new Decoder(after[0]).read(Server2Client);
    expect(message.diff!.snapshots).toEqual([]);
    expect(message.diff!.removed).toEqual([[entity.eid, 1]]);
  });

  it("collapses remove-then-readd within a frame into a single snapshot", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const listener = new MockListener();
    server._attach(listener);
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
    const snap = new Decoder(lastDiff!.snapshots[0].bytes).read(ComponentSnapshot);
    expect(snap).toMatchObject({ eid: entity.eid, wireType: 1 });
    const pos = new Decoder(snap.payload).read(Position);
    expect(pos).toMatchObject({ x: 7, y: 7 });
  });

  it("uses the buffer ref pattern but produces independent message buffers", () => {
    const world = createWorld({ encodeBufferSize: 1024 });
    const server = world;
    allowAllClientViews(world);
    const listener = new MockListener();
    server._attach(listener);
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
    const p1 = new Decoder(
      new Decoder(m1.diff!.snapshots[0].bytes).read(ComponentSnapshot).payload
    ).read(Position);
    const p2 = new Decoder(
      new Decoder(m2.diff!.snapshots[0].bytes).read(ComponentSnapshot).payload
    ).read(Position);
    expect(p1).toMatchObject({ x: 1, y: 1 });
    expect(p2).toMatchObject({ x: 2, y: 2 });
  });

  it("invalidates cached snapshots before sending synchronized component updates", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const listener = new MockListener();
    server._attach(listener);
    const first = new MemorySocket("client-1");
    listener.connect(first);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 1 });
    world.progress(0, 16);

    const late = new MemorySocket("client-2");
    listener.connect(late);
    entity.set(Position, { x: 3, y: 4 });
    world.progress(16, 16);

    const firstPosition = decodeFirstSnapshotPayload(first.sent[first.sent.length - 1]);
    const latePosition = decodeFirstSnapshotPayload(late.sent[late.sent.length - 1]);
    expect(firstPosition).toMatchObject({ x: 3, y: 4 });
    expect(latePosition).toMatchObject({ x: 3, y: 4 });
  });

  it("renames listen to handleRpc and applies registered handlers to new sessions", () => {
    const world = createWorld();
    const server = world;
    server.handleRpc(42, (_params, req) => {
      expect(req.rpcId).toBe(42);
      return [];
    });
    // handler registration must be retroactive to sessions opened later
    const listener = new MockListener();
    server._attach(listener);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    const surface = server as unknown as Record<string, unknown>;
    expect(typeof surface.handleRpc).toBe("function");
    expect(surface.listen).toBeUndefined();
    expect(surface.addSocket).toBeUndefined();
    expect(surface.getInput).toBeUndefined();
  });

  it("notifies and unsubscribes EntityTracker listeners", () => {
    const world = createWorld();
    world.component(Position);
    const tracker = new EntityTracker(world, [Position]);
    const events: string[] = [];
    const listener: IEntityTrackerListener = {
      enter: (entity) => events.push(`enter:${entity.eid}`),
      exit: (entity) => events.push(`exit:${entity.eid}`),
    };
    tracker.subscribe(listener);
    tracker.build();

    const entity = world.entity().add(Position);
    entity.remove(Position);

    expect(events).toEqual([`enter:${entity.eid}`, `exit:${entity.eid}`]);

    tracker.unsubscribe(listener);
    const afterUnsubscribe = world.entity().add(Position);
    afterUnsubscribe.remove(Position);

    expect(events).toEqual([`enter:${entity.eid}`, `exit:${entity.eid}`]);
    tracker.destroy();
  });

  it("acquires a View tracker that tracks matching entities", () => {
    const world = createWorld();
    world.component(Position);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const matching = world.entity().add(Networked).add(Position);
    const nonNetworked = world.entity().add(Position);
    const other = world.entity().add(Networked);
    const { session, view } = connectSession(server, listener);
    session.entity.set(View, { dsl: [Position] });
    world.progress(0, 16);

    expect(view.tracker.has(matching)).toBe(true);
    expect(view.tracker.has(nonNetworked)).toBe(false);
    expect(view.tracker.has(other)).toBe(false);
    expect(view.tracker.count).toBe(1);
  });

  it("shares cached trackers for equivalent View DSL", () => {
    const world = createWorld();
    world.component(Position);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const { session: firstSession, view: first } = connectSession(server, listener, "client-1");
    const { session: secondSession, view: second } = connectSession(server, listener, "client-2");
    firstSession.entity.set(View, { dsl: [Position] });
    secondSession.entity.set(View, { dsl: Position });
    world.progress(0, 16);

    expect(first.tracker).toBe(second.tracker);
  });

  it("does not preserve an old tracker when View DSL changes to an equivalent query", () => {
    const world = createWorld();
    world.component(Position);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const { session, view } = connectSession(server, listener);
    session.entity.set(View, { dsl: [Position] });
    world.progress(0, 16);
    const original = view.tracker;

    session.entity.set(View, { dsl: Position });
    world.progress(16, 16);

    expect(view.tracker).toBe(original);
    expect(view._old_tracker).toBeUndefined();
    expect(view._old_tracker_key).toBeUndefined();
  });

  it("moves the previous tracker to old tracker and installs a new tracker on View set", () => {
    const world = createWorld();
    world.component(Position);
    world.component(Velocity);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const positionEntity = world.entity().add(Networked).add(Position);
    const velocityEntity = world.entity().add(Networked).add(Velocity);
    const { session, view } = connectSession(server, listener);
    session.entity.set(View, { dsl: [Position] });
    world.progress(0, 16);
    const original = view.tracker;

    session.entity.set(View, { dsl: [Velocity] });
    expect(view._old_tracker).toBe(original);

    world.progress(16, 16);

    expect(view._old_tracker).toBeUndefined();
    expect(view.tracker).not.toBe(original);
    expect(view.tracker.has(velocityEntity)).toBe(true);
    expect(view.tracker.has(positionEntity)).toBe(false);
  });

  it("builds a View tracker when View is set during a system run", () => {
    const world = createWorld();
    world.component(Position);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    let target: ReturnType<World["entity"]>;
    let viewer: ReturnType<World["entity"]>;

    world
      .system("set-view")
      .phase(POST_UPDATE)
      .run(() => {
        viewer!.set(View, { dsl: [Position] });
      });
    target = world.entity().add(Networked).add(Position);
    viewer = connectSession(server, listener).session.entity;
    world.progress(0, 16);

    // ServerWorld refreshes interest in a phase after ON_STORE, so a View set
    // mid-pipeline has its tracker built by the time the tick completes.
    expect(viewer!.get(View)?.tracker.has(target!)).toBe(true);
  });

  it("releases active and old trackers when View is removed", () => {
    const world = createWorld();
    world.component(Position);
    world.component(Velocity);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const { session, socket, view } = connectSession(server, listener);
    session.entity.set(View, { dsl: [Position] });
    world.progress(0, 16);
    const original = view.tracker;
    session.entity.set(View, { dsl: [Velocity] });
    world.progress(16, 16);
    const replacement = view.tracker;

    socket.close();
    world.progress(32, 16);
    const { session: positionSession, view: nextPosition } = connectSession(
      server,
      listener,
      "client-2"
    );
    const { session: velocitySession, view: nextVelocity } = connectSession(
      server,
      listener,
      "client-3"
    );
    positionSession.entity.set(View, { dsl: [Position] });
    velocitySession.entity.set(View, { dsl: [Velocity] });
    world.progress(48, 16);

    expect(nextPosition.tracker).not.toBe(original);
    expect(nextVelocity.tracker).not.toBe(replacement);
  });

  it("preserves the first old tracker across repeated View sets", () => {
    const world = createWorld();
    world.component(Position);
    world.component(Velocity);
    world.component(LocalOnly);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const positionEntity = world.entity().add(Networked).add(Position);
    const velocityEntity = world.entity().add(Networked).add(Velocity);
    const localEntity = world.entity().add(Networked).add(LocalOnly);
    const { session, view } = connectSession(server, listener);
    session.entity.set(View, { dsl: [Position] });
    world.progress(0, 16);
    const original = view.tracker;

    world.defer(() => {
      session.entity.set(View, { dsl: [Velocity] });
      session.entity.set(View, { dsl: [LocalOnly] });
    });
    expect(view._old_tracker).toBe(original);

    world.progress(16, 16);

    expect(view._old_tracker).toBeUndefined();
    expect(view.tracker).not.toBe(original);
    expect(view.tracker.has(positionEntity)).toBe(false);
    expect(view.tracker.has(velocityEntity)).toBe(false);
    expect(view.tracker.has(localEntity)).toBe(true);
  });

  it("reuses the old tracker without leaking refs when View DSL changes back", () => {
    const world = createWorld();
    world.component(Position);
    world.component(Velocity);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const { session, socket, view } = connectSession(server, listener);
    session.entity.set(View, { dsl: [Position] });
    world.progress(0, 16);
    const original = view.tracker;

    world.defer(() => {
      session.entity.set(View, { dsl: [Velocity] });
      session.entity.set(View, { dsl: [Position] });
    });
    world.progress(16, 16);
    expect(view.tracker).toBe(original);

    socket.close();
    world.progress(32, 16);
    const { session: positionSession, view: nextPosition } = connectSession(
      server,
      listener,
      "client-2"
    );
    const { session: velocitySession, view: nextVelocity } = connectSession(
      server,
      listener,
      "client-3"
    );
    positionSession.entity.set(View, { dsl: [Position] });
    velocitySession.entity.set(View, { dsl: [Velocity] });
    world.progress(48, 16);

    expect(nextPosition.tracker).not.toBe(original);
    expect(nextVelocity.tracker).toBeDefined();
  });

  it("reuses the old tracker without leaking refs after false View DSL", () => {
    const world = createWorld();
    world.component(Position);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const { session, socket, view } = connectSession(server, listener);
    session.entity.set(View, { dsl: [Position] });
    world.progress(0, 16);
    const original = view.tracker;

    world.defer(() => {
      session.entity.set(View, { dsl: false });
      session.entity.set(View, { dsl: [Position] });
    });
    world.progress(16, 16);
    expect(view.tracker).toBe(original);

    socket.close();
    world.progress(32, 16);
    const { session: positionSession, view: nextPosition } = connectSession(
      server,
      listener,
      "client-2"
    );
    positionSession.entity.set(View, { dsl: [Position] });
    world.progress(48, 16);

    expect(nextPosition.tracker).not.toBe(original);
  });

  it("does not process non-session Views", () => {
    const world = createWorld();
    world.component(Position);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const empty = world.entity().set(View, { dsl: false }).get(View)!;
    world.progress(0, 16);
    expect(() => empty.tracker).toThrow("View tracker is undefined");

    const { session, view } = connectSession(server, listener);
    session.entity.set(View, { dsl: [Position] });
    world.progress(16, 16);
    const original = view.tracker;

    session.entity.set(View, { dsl: false });
    expect(view._old_tracker).toBe(original);

    world.progress(32, 16);

    expect(view.dsl).toBe(false);
    expect(view.tracker.has(session.entity)).toBe(false);
    expect(view.tracker.count).toBe(0);
    expect(view._old_tracker).toBeUndefined();
  });

  it("queues removals when a client View narrows visibility", () => {
    const world = createWorld();
    world.component(LocalOnly);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const visible = world.entity().add(Networked).set(Position, { x: 1, y: 1 }).add(LocalOnly);
    const hidden = world.entity().add(Networked).set(Position, { x: 2, y: 2 });
    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    const session = getSession(server, "client-1");
    const view = getSessionView(server, "client-1");

    expect(view._visible).toEqual(new Set());
    session.entity.set(View, { dsl: true });
    world.progress(0, 16);
    expect(view._visible).toEqual(new Set([visible, hidden, session.entity]));
    expect(view._enteredView).toEqual(new Set());
    expect(view._exitedView).toEqual(new Set());
    const baseline = socket.sent.length;

    session.entity.set(View, { dsl: [LocalOnly] });
    world.progress(16, 16);

    expect(view._visible).toEqual(new Set([visible]));
    expect(view._enteredView).toEqual(new Set());
    expect(view._exitedView).toEqual(new Set());
    expect(socket.sent.length).toBeGreaterThan(baseline);
    const message = decodeLastMessage(socket);
    expect(message.diff!.removed).toEqual([
      [hidden.eid, ALL_COMPONENTS],
      [session.entity.eid, ALL_COMPONENTS],
    ]);
    expect(view.canSee(visible)).toBe(true);
    expect(view.canSee(hidden)).toBe(false);
  });

  it("does not send component updates for entities exiting visibility", () => {
    const world = createWorld();
    world.component(LocalOnly);
    world.component(Velocity);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 1 }).add(LocalOnly);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    const session = getSession(server, "client-1");

    session.entity.set(View, { dsl: [LocalOnly] });
    world.progress(0, 16);
    const baseline = socket.sent.length;

    entity.set(Position, { x: 9, y: 9 });
    session.entity.set(View, { dsl: [Velocity] });
    world.progress(16, 16);

    expect(socket.sent.length).toBeGreaterThan(baseline);
    const message = decodeLastMessage(socket);
    expect(message.diff!.removed).toEqual([[entity.eid, ALL_COMPONENTS]]);
    expect(message.diff!.snapshots).toEqual([]);
  });

  it("queues entries and exits when a client View switches trackers", () => {
    const world = createWorld();
    world.component(LocalOnly);
    world.component(Velocity);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const local = world.entity().add(Networked).set(Position, { x: 1, y: 1 }).add(LocalOnly);
    const moving = world.entity().add(Networked).set(Position, { x: 2, y: 2 }).add(Velocity);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    const session = getSession(server, "client-1");
    const view = getSessionView(server, "client-1");

    session.entity.set(View, { dsl: [LocalOnly] });
    world.progress(0, 16);
    const baseline = socket.sent.length;

    session.entity.set(View, { dsl: [Velocity] });
    world.progress(16, 16);

    expect(view._visible).toEqual(new Set([moving]));
    expect(view._enteredView).toEqual(new Set());
    expect(view._exitedView).toEqual(new Set());
    expect(socket.sent.length).toBeGreaterThan(baseline);
    const message = decodeLastMessage(socket);
    expect(message.diff!.removed).toEqual([[local.eid, ALL_COMPONENTS]]);
    expect(message.diff!.snapshots).toHaveLength(1);
  });

  it("refreshes set View DSL changes before sending relationship visibility changes", () => {
    const world = createWorld();
    world.component(InCell).add(Exclusive);
    world.component(CellA);
    world.component(CellB);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const cellA = world.entity().add(CellA);
    const cellB = world.entity().add(CellB);
    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 1 }).add(InCell, cellA);
    const entering = world.entity().add(Networked).set(Position, { x: 2, y: 2 }).add(InCell, cellB);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    const session = getSession(server, "client-1");
    const view = getSessionView(server, "client-1");
    session.entity.set(View, { dsl: { target: [InCell, CellA] } });
    world.progress(0, 16);
    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 0 })));
    const baseline = socket.sent.length;

    entity.set(Position, { x: 3, y: 3 });
    entity.add(InCell, cellB);
    session.entity.set(View, { dsl: { target: [InCell, CellB] } });
    world.progress(16, 16);

    expect(view.tracker.has(entity)).toBe(true);
    expect(socket.sent.length).toBeGreaterThan(baseline);
    const message = decodeLastMessage(socket);
    expect(message.diff!.removed).toEqual([]);
    const snapshotEids = message.diff!.snapshots.map(
      (snapshot) => new Decoder(snapshot.bytes).read(ComponentSnapshot).eid
    );
    expect(snapshotEids).toContain(entity.eid);
    expect(snapshotEids).toContain(entering.eid);
  });

  // Regression: a client that retargets its own InCell and swaps its View DSL
  // to a new cell from a PRE_STORE system (the demo's AssignCells /
  // UpdatePlayerViews pattern) must not be dropped for a tick. ServerWorld
  // refreshes interest trackers, captures snapshots and sends in a dedicated
  // phase inserted AFTER ON_STORE, so it runs strictly after every user system
  // regardless of phase or registration order. The new tracker is therefore
  // installed the same tick the DSL changes and the viewer stays visible to
  // itself. Before that fix the refresh ran in PRE_STORE, registered ahead of
  // user systems, so a PRE_STORE DSL change lagged a tick and emitted a spurious
  // ALL_COMPONENTS removal: the viewer blinked on every grid-cell crossing.
  it("does not drop a client that moves its own View to a new cell in PRE_STORE", () => {
    const world = createWorld();
    world.component(InCell).add(Exclusive);
    world.component(CellA);
    world.component(CellB);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const cellA = world.entity().add(CellA);
    const cellB = world.entity().add(CellB);
    const dslA: QueryDSL = { target: [InCell, CellA] };
    const dslB: QueryDSL = { target: [InCell, CellB] };

    // Each client starts in cell A, viewing cell A (so it can see itself).
    world.component(NetworkClient).onSet((entity) => {
      entity.set(View, { dsl: dslA }).add(InCell, cellA);
    });

    // Mirror the demo: derive the cell from position, then retarget InCell and
    // swap the View DSL to match, in PRE_STORE. x < 5 is cell A, x >= 5 cell B.
    world
      .system("CrossCell")
      .with(Networked, NetworkClient, Position, View)
      .phase(PRE_STORE)
      .update({ watch: Position, onEnter: true, inject: [View] }, (entity, position, [view]) => {
        const cell = position.x < 5 ? cellA : cellB;
        const dsl = position.x < 5 ? dslA : dslB;
        if (entity.target(InCell) !== cell) {
          entity.add(InCell, cell);
        }
        if (view.dsl !== dsl) {
          view.dsl = dsl;
          entity.modified(View);
        }
      });

    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    const session = getSession(server, "client-1");
    const view = getSessionView(server, "client-1");

    session.entity.set(Position, { x: 1, y: 1 });
    world.progress(0, 16);
    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 1 })));
    const baseline = socket.sent.length;

    // The crossing tick: CrossCell retargets InCell + View to cell B.
    session.entity.set(Position, { x: 9, y: 9 });
    world.progress(16, 16);

    expect(view.canSee(session.entity)).toBe(true);
    if (socket.sent.length > baseline) {
      const message = decodeLastMessage(socket);
      expect(message.diff!.removed).not.toContainEqual([session.entity.eid, ALL_COMPONENTS]);
    }
  });

  it("queues all networked entities when a client View changes to true", () => {
    const world = createWorld();
    world.component(LocalOnly);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const local = world.entity().add(Networked).set(Position, { x: 1, y: 1 }).add(LocalOnly);
    const hidden = world.entity().add(Networked).set(Position, { x: 2, y: 2 });
    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    const session = getSession(server, "client-1");
    const view = getSessionView(server, "client-1");

    session.entity.set(View, { dsl: [LocalOnly] });
    world.progress(0, 16);
    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 1 })));
    const baseline = socket.sent.length;

    session.entity.set(View, { dsl: true });
    world.progress(16, 16);

    expect(view._visible).toEqual(new Set([local, hidden, session.entity]));
    expect(view._enteredView).toEqual(new Set());
    expect(view._exitedView).toEqual(new Set());
    expect(view._old_tracker).toBeUndefined();
    expect(socket.sent.length).toBeGreaterThan(baseline);
    const message = decodeLastMessage(socket);
    expect(message.diff!.snapshots).toHaveLength(1);
  });

  it("queues tracker listener entries and exits for active client Views", () => {
    const world = createWorld();
    world.component(LocalOnly);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    const session = getSession(server, "client-1");
    const view = getSessionView(server, "client-1");
    session.entity.set(View, { dsl: [LocalOnly] });
    world.progress(0, 16);
    expect(view._enteredView).toEqual(new Set());
    expect(view._exitedView).toEqual(new Set());

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 1 }).add(LocalOnly);

    expect(view._visible).toEqual(new Set([entity]));
    expect(view._enteredView).toEqual(new Set([entity]));
    expect(view._exitedView).toEqual(new Set());

    view._enteredView.clear();
    entity.remove(LocalOnly);

    expect(view._visible).toEqual(new Set());
    expect(view._enteredView).toEqual(new Set());
    expect(view._exitedView).toEqual(new Set([entity]));
  });
});
