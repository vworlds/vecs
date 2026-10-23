import { describe, expect, it, vi } from "vitest";
import * as vecs from "@vworlds/vecs";
import {
  Client2Server,
  ComponentSnapshot,
  RPC,
  RPC_RESPONSE_ID,
  rpcIdFor,
  Server2Client,
  SessionRPC,
  RPC_CLOSED_CODE,
  RPC_TIMEOUT_CODE,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import {
  POST_UPDATE,
  PRE_STORE,
  Exclusive,
  ComponentDef,
  type QueryDSL,
  Relationship,
  type Entity,
  type World,
} from "@vworlds/vecs";
import { performance } from "node:perf_hooks";
import {
  CLOSE_PROTOCOL_ERROR_CODE,
  EntityTracker,
  type IEntityTrackerListener,
  NetworkClient,
  NetworkInput,
  Networked,
  RPCError,
  ServerWorld,
  type ServerRPCContext,
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
  public closeCalls = 0;
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
    this.closeCalls++;
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
  world.component(NetworkClient).on("set", (entity) => {
    entity.set(View, { dsl: true });
  });
}

function createWorld(options: ServerWorldOptions = {}): ServerWorld {
  return new ServerWorld({ name: "main", networkComponents: [Position], ...options });
}

describe("ServerWorld.invoke", () => {
  it("expires outgoing calls even when the session has no View", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const world = createWorld();
    const listener = new MockListener();
    world._attach(listener);
    const socket = new MemorySocket("viewless");
    listener.connect(socket);
    getSession(world, socket.id).entity.remove(View);
    world.flush();
    try {
      const rejected = vi.fn();
      const outcome = world.invoke(socket.id, 201, [], 10_000).catch((error) => {
        rejected(error);
        return error;
      });
      clock.mockReturnValue(10_099);
      world.send();
      await Promise.resolve();
      expect(rejected).not.toHaveBeenCalled();
      expect(getSession(world, socket.id).entity.has(View)).toBe(false);
      clock.mockReturnValue(10_100);
      world.send();
      await Promise.resolve();
      await Promise.resolve();
      expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ code: RPC_TIMEOUT_CODE }));
      expect(await outcome).toMatchObject({ code: RPC_TIMEOUT_CODE });
    } finally {
      world.dispose();
      clock.mockRestore();
    }
  });

  it("does not charge a new call for time before it existed while another call is pending", async () => {
    const world = createWorld();
    const listener = new MockListener();
    world._attach(listener);
    const { socket } = connectSession(world, listener);
    const clock = vi.spyOn(performance, "now");
    try {
      clock.mockReturnValue(100);
      const old = world.invoke("client-1", 201, [], 10);
      clock.mockReturnValue(200);
      const fresh = world.invoke("client-1", 201, [], 10);
      tick(world);
      await expect(old).rejects.toMatchObject({ code: RPC_TIMEOUT_CODE });
      const [request] = decodeLastMessage(socket).rpc;
      expect(request.callId).toBe(1);
      clock.mockReturnValue(210);
      tick(world);
      await expect(fresh).rejects.toMatchObject({ code: RPC_TIMEOUT_CODE });
    } finally {
      clock.mockRestore();
      world.dispose();
    }
  });
  it("returns reply params and preserves a remote handler's error code", async () => {
    const world = createWorld();
    const listener = new MockListener();
    world._attach(listener);
    const { socket } = connectSession(world, listener);
    try {
      const call = world.invoke(socket.id, 201, ["question"]);
      tick(world);
      const [request] = decodeLastMessage(socket).rpc;
      expect(request).toMatchObject({ rpcId: 201, params: ["question"] });
      socket.receive(
        encodeClient2Server(
          new Client2Server({
            rpc: [
              new RPC({
                rpcId: RPC_RESPONSE_ID,
                callId: request.callId,
                params: ["answer", 42],
              }),
            ],
          })
        )
      );
      await expect(call).resolves.toEqual(["answer", 42]);
      const failed = world.invoke(socket.id, 202);
      tick(world);
      const [next] = decodeLastMessage(socket).rpc;
      socket.receive(
        encodeClient2Server(
          new Client2Server({
            rpc: [
              new RPC({
                rpcId: RPC_RESPONSE_ID,
                callId: next.callId,
                error: 4001,
                message: "denied",
              }),
            ],
          })
        )
      );
      await expect(failed).rejects.toMatchObject({ code: 4001, message: "denied" });
    } finally {
      world.dispose();
    }
  });

  it("rejects unknown and closing connections immediately, and aborts on session end", async () => {
    const world = createWorld();
    const listener = new MockListener();
    world._attach(listener);
    const { socket } = connectSession(world, listener);
    await expect(world.invoke("missing", 201)).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
    const pending = world.invoke(socket.id, 201);
    socket.close();
    await expect(pending).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
    const second = connectSession(world, listener, "second");
    world.closeSession(second.socket.id);
    await expect(world.invoke(second.socket.id, 201)).rejects.toMatchObject({
      code: RPC_CLOSED_CODE,
    });
    world.dispose();
  });

  it("ticks only sessions with outgoing calls, expires ttl, and stops ticking after settlement", async () => {
    const world = createWorld();
    const listener = new MockListener();
    world._attach(listener);
    const called = connectSession(world, listener, "called");
    connectSession(world, listener, "never-called");
    const spy = vi.spyOn(SessionRPC.prototype, "timeoutTick");
    const clock = vi.spyOn(performance, "now");
    try {
      clock.mockReturnValue(100);
      tick(world);
      expect(spy).not.toHaveBeenCalled();
      // Even an outgoing reply is not an outgoing call and must pay no timeout work.
      world.handleRpc(101, () => "ok");
      called.socket.receive(
        encodeClient2Server(new Client2Server({ rpc: [new RPC({ rpcId: 101 })] }))
      );
      await Promise.resolve();
      await Promise.resolve();
      tick(world);
      expect(spy).not.toHaveBeenCalled();
      const pending = world.invoke("called", 201, [], 20);
      clock.mockReturnValue(110);
      tick(world);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenLastCalledWith(110);
      clock.mockReturnValue(120);
      tick(world);
      await expect(pending).rejects.toMatchObject({ code: RPC_TIMEOUT_CODE });
      expect(spy).toHaveBeenCalledTimes(2);
      tick(world);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      clock.mockRestore();
      world.dispose();
    }
  });
});

let tickMs = 0;

/** Advance one frame, keeping the timeline monotonic across a test's ticks. */
function tick(world: ServerWorld): void {
  world.progress(tickMs, 16);
  tickMs += 16;
}

/** Deliver an inbound frame and return the RPC replies the server sent back. */
async function deliver(
  socket: MemorySocket,
  world: ServerWorld,
  message: Partial<Client2Server> = {}
): Promise<RPC[]> {
  socket.receive(
    encodeClient2Server(new Client2Server({ ackFrame: 0, ...message } as Client2Server))
  );
  // Handlers are async, so let the response reach the session outbox before send().
  await Promise.resolve();
  await Promise.resolve();
  const before = socket.sent.length;
  tick(world);
  return socket.sent.slice(before).flatMap((bytes) => new Decoder(bytes).read(Server2Client).rpc);
}

/**
 * Ack the newest frame the server sent, as a client that received it would. The server sends a
 * session no state after its baseline until the baseline is acked, so a test that expects a delta
 * acks the baseline first.
 */
function ackLatestFrame(socket: MemorySocket): void {
  const frame = decodeLastMessage(socket);
  socket.receive(encodeClient2Server(new Client2Server({ ackFrame: frame.diff!.toFrame })));
}

/** Ack the close frame a closing session just sent, so its linger ends on the next tick. */
function ackCloseFrame(socket: MemorySocket): void {
  ackLatestFrame(socket);
}

/** Call `rpcId` from a connected socket and return the single reply. */
async function callRpc(
  socket: MemorySocket,
  world: ServerWorld,
  rpcId: number,
  params: unknown[] = []
): Promise<RPC> {
  const replies = await deliver(socket, world, {
    rpc: [new RPC({ rpcId, callId: 0, params })],
  });
  const reply = replies.find((candidate) => candidate.callId === 0);
  if (!reply) {
    throw new Error(`no RPC reply for rpc ${rpcId} on ${socket.id}`);
  }
  return reply;
}

describe("ServerWorld timing", () => {
  it("adds per-frame operation rows only when enabled, with synchronous send costs", () => {
    const world = createWorld();
    allowAllClientViews(world);
    const listener = new MockListener();
    world._attach(listener);
    const { socket } = connectSession(world, listener);
    const { socket: secondSocket } = connectSession(world, listener, "client-2");
    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 2 });
    tick(world);
    expect(world.stats.operations()).toEqual([]);
    ackLatestFrame(socket);
    ackLatestFrame(secondSocket);
    world.stats.enableSystems();
    let clockMs = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => clockMs);
    const send = vi.spyOn(socket, "send").mockImplementation((bytes) => {
      // The second client must keep this frame's selected measuring primitive.
      world.stats.disableSystems();
      clockMs += 5;
      socket.sent.push(bytes);
    });
    const secondSend = vi.spyOn(secondSocket, "send").mockImplementation((bytes) => {
      clockMs += 3;
      secondSocket.sent.push(bytes);
    });
    try {
      entity.set(Position, { x: 3 });
      tick(world);
      expect(send).toHaveBeenCalledTimes(1);
      expect(secondSend).toHaveBeenCalledTimes(1);
      expect(world.stats.operations()).toEqual([
        { name: "replication:encode", runs: 1, totalMs: 0, maxMs: 0 },
        { name: "replication:send", runs: 1, totalMs: 8, maxMs: 8 },
      ]);
      expect(decodeFirstSnapshotPayload(socket.sent[socket.sent.length - 1])).toEqual({
        x: 3,
        y: 2,
      });
      world.stats.resetSystems();
      expect(
        world.stats
          .operations()
          .every((row) => row.runs === 0 && row.totalMs === 0 && row.maxMs === 0)
      ).toBe(true);
      world.stats.disableSystems();
      entity.set(Position, { x: 4 });
      tick(world);
      expect(world.stats.operations().every((row) => row.runs === 0)).toBe(true);
    } finally {
      clock.mockRestore();
      send.mockRestore();
      secondSend.mockRestore();
    }
  });

  it("records zero-client frames without reading clocks in the disabled path", () => {
    const world = createWorld();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      tick(world);
      expect(clock).not.toHaveBeenCalled();
      world.stats.enableSystems();
      tick(world);
      expect(world.stats.operations()).toEqual([
        { name: "replication:encode", runs: 1, totalMs: 0, maxMs: 0 },
        { name: "replication:send", runs: 1, totalMs: 0, maxMs: 0 },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves wire bytes and close-linger behavior with timing enabled", () => {
    function scenario(enabled: boolean): number[][] {
      const world = createWorld({ redundancyFrames: 2, keepAliveFrames: 1 });
      if (enabled) {
        world.stats.enableSystems();
      }
      allowAllClientViews(world);
      const listener = new MockListener();
      world._attach(listener);
      const { socket } = connectSession(world, listener);
      const entity = world.entity().add(Networked).set(Position, { x: 1, y: 2 });
      tick(world);
      ackLatestFrame(socket);
      entity.set(Position, { x: 7 });
      tick(world);
      ackLatestFrame(socket);
      tick(world);
      world.closeSession(socket.id, "done");
      tick(world);
      tick(world);
      ackCloseFrame(socket);
      tick(world);
      expect(socket.closeCalls).toBe(1);
      if (enabled) {
        expect(world.stats.operations()[0].runs).toBe(6);
      }
      return socket.sent.map((bytes) => Array.from(bytes));
    }
    expect(scenario(true)).toEqual(scenario(false));
  });

  it("preserves every client's wire bytes when switching timing on and off between frames", () => {
    function scenario(measureFirstFrame: boolean): number[][][] {
      const world = createWorld();
      allowAllClientViews(world);
      const listener = new MockListener();
      world._attach(listener);
      const sockets = [
        connectSession(world, listener, "client-1").socket,
        connectSession(world, listener, "client-2").socket,
      ];
      const entity = world.entity().add(Networked).set(Position, { x: 1, y: 2 });
      tick(world);
      sockets.forEach(ackLatestFrame);
      const initialCounts = sockets.map((socket) => socket.sent.length);
      if (measureFirstFrame) {
        world.stats.enableSystems();
      }
      entity.set(Position, { x: 3 });
      tick(world);
      sockets.forEach(ackLatestFrame);
      world.stats.disableSystems();
      entity.set(Position, { x: 4 });
      tick(world);
      expect(world.stats.operations().map((row) => row.runs)).toEqual(
        measureFirstFrame ? [1, 1] : []
      );
      return sockets.map((socket, index) => {
        const frames = socket.sent.slice(initialCounts[index]);
        expect(frames).toHaveLength(2);
        expect(decodeFirstSnapshotPayload(frames[0])).toEqual({ x: 3, y: 2 });
        expect(decodeFirstSnapshotPayload(frames[1])).toEqual({ x: 4, y: 2 });
        return frames.map((bytes) => Array.from(bytes));
      });
    }
    expect(scenario(true)).toEqual(scenario(false));
  });

  it("tears down a failed transport on the measured path", () => {
    const world = createWorld();
    world.stats.enableSystems();
    allowAllClientViews(world);
    const listener = new MockListener();
    world._attach(listener);
    const { socket } = connectSession(world, listener);
    vi.spyOn(socket, "send").mockImplementation(() => {
      throw new Error("gone");
    });
    world.entity().add(Networked).set(Position, { x: 1 });
    tick(world);
    expect(socket.closeCalls).toBe(1);
    expect(world.stats.operations().map((row) => row.runs)).toEqual([1, 1]);
  });
});

describe("ServerWorld", () => {
  it("honours moduleIdCount", () => {
    const world = new ServerWorld({ moduleIdCount: 300 });
    expect(world.pools.find((pool) => pool.name === "module")).toEqual({
      name: "module",
      min: 700,
      max: 999,
    });
  });

  it("rejects the client-only localEntityIdStart option before constructing the world", () => {
    expect(() => new ServerWorld({ localEntityIdStart: 10_000 })).toThrow(
      "localEntityIdStart applies to ClientWorld only; ServerWorld allocates every id from its entity pool"
    );
  });

  it("constructs normally without localEntityIdStart", () => {
    expect(() => new ServerWorld()).not.toThrow();
  });

  it("rejects ComponentDef in the network component allowlist", () => {
    expect(() => createWorld({ networkComponents: [Position, ComponentDef] })).toThrow(
      "ComponentDef is local schema metadata and cannot be networked"
    );
  });

  it("omits ComponentDef from replication snapshots and updates", () => {
    const world = createWorld();
    allowAllClientViews(world);
    const listener = new MockListener();
    world._attach(listener);
    const { socket } = connectSession(world, listener);
    const definition = world.component(LocalOnly).add(Networked).set(Position, { x: 10, y: 20 });
    expect(definition.has(ComponentDef)).toBe(true);

    for (const x of [10, 30]) {
      definition.set(Position, { x });
      world.progress(x, 16);
      const message = decodeLastMessage(socket);
      const snapshots = message.diff!.snapshots.map((encoded) =>
        new Decoder(encoded.bytes).read(ComponentSnapshot)
      );
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ eid: definition.eid, wireType: 1 });
      expect(new Decoder(snapshots[0].payload).read(Position)).toEqual({ x, y: 20 });
      expect(message.diff!.removed).toEqual([]);
      ackLatestFrame(socket);
    }
  });

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
    ackLatestFrame(socket);
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
    ackLatestFrame(socket);
    const removalStart = socket.sent.length;

    entity.destroy();
    world.progress(16, 16);

    const last = socket.sent[socket.sent.length - 1];
    expect(socket.sent.length).toBeGreaterThan(removalStart);
    const message = new Decoder(last).read(Server2Client);
    expect(message.diff!.resets).toContainEqual([entity.eid, message.diff!.toFrame]);
    expect(message.diff!.removed).toEqual([]);
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
    ackLatestFrame(socket);
    const removalStart = socket.sent.length;

    entity.remove(Networked);
    world.progress(16, 16);

    const last = socket.sent[socket.sent.length - 1];
    expect(socket.sent.length).toBeGreaterThan(removalStart);
    const message = new Decoder(last).read(Server2Client);
    expect(message.diff!.resets).toContainEqual([entity.eid, message.diff!.toFrame]);
    expect(message.diff!.removed).toEqual([]);
  });

  it("sends an entity whose Networked is removed and added back in one frame as an update, never as a component removal", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const socket = new MemorySocket("client-1");
    const listener = new MockListener();
    server._attach(listener);
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 2 });
    world.progress(0, 16);
    ackLatestFrame(socket);
    const removalStart = socket.sent.length;

    entity.remove(Networked);
    entity.add(Networked);
    world.progress(16, 16);

    expect(socket.sent.length).toBeGreaterThan(removalStart);
    const message = new Decoder(socket.sent[socket.sent.length - 1]).read(Server2Client);
    expect(message.diff!.removed).toEqual([]);
    expect(message.diff!.resets).toBeUndefined();
    expect(message.diff!.snapshots).toHaveLength(1);
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

  it("holds state back until the client acks its baseline, then sends everything it missed", () => {
    const world = createWorld();
    const server = world;
    allowAllClientViews(world);
    const listener = new MockListener();
    server._attach(listener);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 1 });
    world.progress(0, 16);
    const afterBaseline = socket.sent.length;
    entity.set(Position, { x: 2, y: 2 });
    world.progress(16, 16);
    entity.set(Position, { x: 3, y: 3 });
    world.progress(32, 16);

    // The baseline is in flight, and a delta from a frame the client has not acked would
    // be rejected, so nothing more is sent until the client acks it.
    expect(socket.sent.length).toBe(afterBaseline);

    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 1 })));
    world.progress(48, 16);

    const message = decodeLastMessage(socket);
    const position = decodeFirstSnapshotPayload(socket.sent[socket.sent.length - 1]);
    expect(message.diff?.fromFrame).toBe(1);
    expect(message.diff?.toFrame).toBe(4);
    expect(message.diff?.snapshots).toHaveLength(1);
    expect(position).toMatchObject({ x: 3, y: 3 });
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
    ackLatestFrame(socket);
    world.progress(16, 16);
    entity.set(Position, { x: 6, y: 6 });
    world.progress(32, 16);

    const message = decodeLastMessage(socket);
    const position = decodeFirstSnapshotPayload(socket.sent[socket.sent.length - 1]);
    expect(message.diff?.fromFrame).toBe(1);
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

    const entity = world.entity().add(Networked).set(Position, { x: 7, y: 7 });
    world.progress(0, 16);
    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 1 })));
    const sentBeforeLag = socket.sent.length;

    // Frame 2 changes something the client never acks, and leaves the history window once frame
    // HISTORY_LENGTH + 2 has been pushed. A client is only outside the window for a frame that
    // held something: a quiet one is not resynced, however old its ack.
    entity.set(Position, { x: 8, y: 8 });
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
    expect(position).toMatchObject({ x: 8, y: 8 });
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
    ackLatestFrame(socket);
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
    ackLatestFrame(socket);
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
    ackLatestFrame(socket);

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
    ackLatestFrame(first);

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
    server.handleRpc(142, (_params, req) => {
      expect(req.rpcId).toBe(142);
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
    ackLatestFrame(socket);
    const baseline = socket.sent.length;

    session.entity.set(View, { dsl: [LocalOnly] });
    world.progress(16, 16);

    expect(view._visible).toEqual(new Set([visible]));
    expect(view._enteredView).toEqual(new Set());
    expect(view._exitedView).toEqual(new Set());
    expect(socket.sent.length).toBeGreaterThan(baseline);
    const message = decodeLastMessage(socket);
    expect(message.diff!.resets).toEqual([
      [hidden.eid, message.diff!.toFrame],
      [session.entity.eid, message.diff!.toFrame],
    ]);
    expect(message.diff!.removed).toEqual([]);
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
    ackLatestFrame(socket);
    const baseline = socket.sent.length;

    entity.set(Position, { x: 9, y: 9 });
    session.entity.set(View, { dsl: [Velocity] });
    world.progress(16, 16);

    expect(socket.sent.length).toBeGreaterThan(baseline);
    const message = decodeLastMessage(socket);
    expect(message.diff!.resets).toEqual([[entity.eid, message.diff!.toFrame]]);
    expect(message.diff!.removed).toEqual([]);
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
    ackLatestFrame(socket);
    const baseline = socket.sent.length;

    session.entity.set(View, { dsl: [Velocity] });
    world.progress(16, 16);

    expect(view._visible).toEqual(new Set([moving]));
    expect(view._enteredView).toEqual(new Set());
    expect(view._exitedView).toEqual(new Set());
    expect(socket.sent.length).toBeGreaterThan(baseline);
    const message = decodeLastMessage(socket);
    expect(message.diff!.resets).toEqual([[local.eid, message.diff!.toFrame]]);
    expect(message.diff!.removed).toEqual([]);
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
    ackLatestFrame(socket);
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
  // reset of the viewer: it blinked on every grid-cell crossing.
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
    world.component(NetworkClient).on("set", (entity) => {
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
      expect(message.diff!.resets?.map(([eid]) => eid) ?? []).not.toContain(session.entity.eid);
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

describe("ServerWorld RPC caller context", () => {
  it("rejects a forced name collision before any sessions connect", () => {
    const hash = vi.spyOn(vecs, "fnv1a32").mockReturnValue(123);
    try {
      const server = createWorld();
      const handler = () => [];
      server.handleRpc("first", handler);
      expect(() => server.handleRpc("second", handler)).toThrow(/"first".*"second"/);
      expect(server.unhandleRpc("first", handler)).toBe(true);
      expect(() => server.handleRpc("second", handler)).toThrow(/"first".*"second"/);
    } finally {
      hash.mockRestore();
    }
  });

  it.each([101, "auth"])(
    "unhandles %s on existing and future sessions without removing replacements",
    async (key) => {
      const server = createWorld();
      const id = typeof key === "string" ? rpcIdFor(key) : key;
      const unknown = `Unknown RPC id ${id}${typeof key === "string" ? ` (${JSON.stringify(key)})` : ""}`;
      let nextId = 1;
      const call = async (socket: MemorySocket) => {
        const callId = nextId++;
        const replies = await deliver(socket, server, {
          rpc: [new RPC({ rpcId: id, callId, params: [] })],
        });
        const reply = replies.find((reply) => reply.callId === callId);
        if (!reply) {
          throw new Error(`Missing reply ${callId}`);
        }
        return reply;
      };
      const listener = new MockListener();
      server._attach(listener);
      const first = new MemorySocket("first");
      listener.connect(first);
      const original = () => ["original"];
      expect(server.handleRpc(key, original)).toBeUndefined();
      const second = new MemorySocket("second");
      listener.connect(second);
      expect((await call(first)).params).toEqual(["original"]);
      expect((await call(second)).params).toEqual(["original"]);
      expect(server.unhandleRpc(key, original)).toBe(true);
      expect(server.unhandleRpc(key, original)).toBe(false);
      const third = new MemorySocket("third");
      listener.connect(third);
      for (const socket of [first, second, third]) {
        expect((await call(socket)).message).toBe(
          socket === third ? `Unknown RPC id ${id}` : unknown
        );
      }
      const old = () => ["old"];
      const current = () => ["replacement"];
      server.handleRpc(key, old);
      server.handleRpc(key, current);
      expect(server.unhandleRpc(key, old)).toBe(false);
      expect((await call(first)).params).toEqual(["replacement"]);
      expect(server.unhandleRpc(key, current)).toBe(true);
      expect((await call(first)).message).toBe(unknown);
    }
  );

  it("gives each concurrent session its own caller", async () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const seen: Array<{ connectionId: string; eid: number; world: ServerWorld }> = [];
    server.handleRpc(101, (_params, _request, ctx) => {
      seen.push({ connectionId: ctx.connectionId, eid: ctx.caller.eid, world: ctx.world });
      return [ctx.connectionId, ctx.caller.get(NetworkClient)?.id];
    });

    const first = new MemorySocket("client-1");
    const second = new MemorySocket("client-2");
    listener.connect(first);
    listener.connect(second);

    const firstReply = await callRpc(first, server, 101);
    const secondReply = await callRpc(second, server, 101);

    expect(firstReply.params).toEqual(["client-1", "client-1"]);
    expect(secondReply.params).toEqual(["client-2", "client-2"]);
    expect(seen).toEqual([
      { connectionId: "client-1", eid: seen[0].eid, world: server },
      { connectionId: "client-2", eid: seen[1].eid, world: server },
    ]);
    expect(seen[0].eid).not.toBe(seen[1].eid);
    expect(world.getEntity(seen[0].eid)?.get(NetworkClient)?.id).toBe("client-1");
    expect(world.getEntity(seen[1].eid)?.get(NetworkClient)?.id).toBe("client-2");
  });

  it("keeps concurrent calls on one connection attributed to that connection", async () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    server.handleRpc(101, (_params, _request, ctx) => {
      ctx.caller.set(NetworkInput, { input: ctx.connectionId });
      return [ctx.connectionId];
    });

    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    expect((await callRpc(socket, server, 101)).params).toEqual(["client-1"]);
    expect((await callRpc(socket, server, 101)).params).toEqual(["client-1"]);
  });

  it("binds handlers registered after the sessions already exist", async () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    server.handleRpc(101, (_params, _request, ctx) => [ctx.caller.get(NetworkClient)?.id]);

    expect((await callRpc(socket, server, 101)).params).toEqual(["client-1"]);
  });

  it("forwards a handler's RPCError code and message to the client", async () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    server.handleRpc(101, () => {
      throw new RPCError(4001, "unknown resume token");
    });

    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    const reply = await callRpc(socket, server, 101);
    expect(reply.rpcId).toBe(0);
    expect(reply.error).toBe(4001);
    expect(reply.message).toBe("unknown resume token");
  });

  it("reports an rpc id the server does not handle as code 1", async () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    const reply = await callRpc(socket, server, 999);
    expect(reply.error).toBe(1);
    expect(reply.message).toBe("Unknown RPC id 999");
  });

  it("does not answer a call made on a closed session", async () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const calls: string[] = [];
    server.handleRpc(101, (_params, _request, ctx) => {
      calls.push(ctx.connectionId);
      return [];
    });

    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    server.closeSession("client-1");

    const replies = await deliver(socket, server, {
      rpc: [new RPC({ rpcId: 101, callId: 0, params: [] })],
    });

    expect(calls).toEqual([]);
    expect(replies).toEqual([]);
  });
});

describe("ServerWorld RPC retransmission", () => {
  const SPEND_RPC = 101;

  /** A promise the test settles by hand, to hold a handler in flight. */
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  /** Let the continuation of a settled handler queue the reply it owes. */
  async function settleHandlers(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  }

  /** The ack a client sends while its call is pending: every ack carries the request again. */
  function ackWithRequest(callId: number): Uint8Array {
    return encodeClient2Server(
      new Client2Server({
        ackFrame: 0,
        rpc: [new RPC({ rpcId: SPEND_RPC, callId, params: ["spend 10 credits"] })],
      })
    );
  }

  /** Every RPC reply the server has sent on `socket` so far. */
  function repliesSent(socket: MemorySocket): RPC[] {
    return socket.sent.flatMap((bytes) => new Decoder(bytes).read(Server2Client).rpc);
  }

  function connectClient(handler: Parameters<ServerWorld["handleRpc"]>[1]): {
    server: ServerWorld;
    socket: MemorySocket;
  } {
    const server = createWorld();
    const listener = new MockListener();
    server._attach(listener);
    server.handleRpc(SPEND_RPC, handler);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);
    return { server, socket };
  }

  it("runs a slow handler once when the client retransmits its request before it resolves", async () => {
    const gate = deferred<unknown[]>();
    const handler = vi.fn(() => gate.promise);
    const { server, socket } = connectClient(handler);

    // The client re-sends its pending request with every ack while the server keeps ticking.
    const ack = ackWithRequest(0);
    for (let copy = 0; copy < 3; copy++) {
      socket.receive(ack);
      tick(server);
    }
    await settleHandlers();

    expect(handler).toHaveBeenCalledOnce();
    expect(repliesSent(socket)).toEqual([]);

    gate.resolve(["spent"]);
    await settleHandlers();
    tick(server);

    expect(handler).toHaveBeenCalledOnce();
    expect(repliesSent(socket)).toMatchObject([
      { rpcId: RPC_RESPONSE_ID, callId: 0, params: ["spent"] },
    ]);
  });

  it("re-sends the cached reply to a copy that arrives after the reply, without re-running the handler", async () => {
    const handler = vi.fn(() => ["spent"]);
    const { server, socket } = connectClient(handler);
    const ack = ackWithRequest(0);
    socket.receive(ack);
    await settleHandlers();
    tick(server);
    expect(repliesSent(socket)).toHaveLength(1);

    // A retransmit that crossed the reply on the wire.
    socket.receive(ack);
    await settleHandlers();
    tick(server);

    expect(handler).toHaveBeenCalledOnce();
    expect(repliesSent(socket)).toMatchObject([
      { callId: 0, params: ["spent"] },
      { callId: 0, params: ["spent"] },
    ]);
  });

  it("ignores a replayed request once the client's watermark has passed it", async () => {
    const handler = vi.fn(() => ["spent"]);
    const { server, socket } = connectClient(handler);
    const ack = ackWithRequest(0);
    socket.receive(ack);
    await settleHandlers();
    tick(server);
    expect(repliesSent(socket)).toHaveLength(1);

    // The client got its reply, so its next ack says call 0 has settled ...
    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 0, rpcSettledBelow: 1 })));
    // ... and then an old frame that still carries the request turns up late.
    socket.receive(ack);
    await settleHandlers();
    tick(server);

    expect(handler).toHaveBeenCalledOnce();
    expect(repliesSent(socket)).toHaveLength(1);
  });

  it("carries the session's own watermark on the per-tick frame and on the close frame", async () => {
    const { server, socket } = connectClient(() => []);
    // ServerWorld has no public way to call a client, so reach the session's channel directly.
    const rpc = (getSession(server, "client-1") as unknown as { rpc: SessionRPC }).rpc;
    const answered = rpc.invoke(SPEND_RPC);
    void rpc.invoke(SPEND_RPC).catch(() => undefined); // call 1 stays pending, so every frame is sent

    socket.receive(
      encodeClient2Server(
        new Client2Server({
          ackFrame: 0,
          rpc: [new RPC({ rpcId: RPC_RESPONSE_ID, callId: 0, params: ["ok"] })],
        })
      )
    );
    await answered;
    tick(server);

    expect(decodeLastMessage(socket)).toMatchObject({ rpcSettledBelow: 1 });

    server.closeSession("client-1", "done");
    tick(server);

    expect(decodeLastMessage(socket)).toMatchObject({
      rpcSettledBelow: 1,
      close: { reason: "done" },
    });
  });

  it("sends a zero watermark on every frame while the session has issued no calls", async () => {
    const { server, socket } = connectClient(() => ["ok"]);
    socket.receive(ackWithRequest(0));
    await settleHandlers();
    tick(server); // the per-tick frame that carries the reply
    server.closeSession("client-1", "done");
    tick(server); // the close frame

    const frames = socket.sent.map((bytes) => new Decoder(bytes).read(Server2Client));
    expect(frames).toHaveLength(2);
    expect(frames[0].rpc).toMatchObject([{ callId: 0, params: ["ok"] }]);
    expect(frames[1].close).toEqual({ reason: "done" });
    expect(frames.map((frame) => frame.rpcSettledBelow)).toEqual([0, 0]);
  });
});

describe("ServerWorld.closeSession", () => {
  it("closes one session and leaves the others connected", () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const first = connectSession(server, listener, "client-1");
    const second = connectSession(server, listener, "client-2");
    const firstEid = first.session.entity.eid;
    const secondEid = second.session.entity.eid;

    expect(server.closeSession("client-1")).toBe(true);
    tick(world);

    expect(first.socket.closed).toBe(true);
    expect(first.socket.closeCalls).toBe(1);
    expect(world.getEntity(firstEid)).toBeUndefined();
    expect(second.socket.closed).toBe(false);
    expect(second.socket.closeCalls).toBe(0);
    expect(world.getEntity(secondEid)?.get(NetworkClient)?.id).toBe("client-2");
    expect(world.entity(secondEid).get(View)).toBeDefined();
  });

  it("accepts the caller's NetworkClient entity", () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const { session, socket } = connectSession(server, listener, "client-1");

    expect(server.closeSession(session.entity)).toBe(true);
    tick(world);

    expect(socket.closed).toBe(true);
    expect(world.getEntity(session.entity.eid)).toBeUndefined();
  });

  it("is a no-op for an unknown connection or an already-closed session", () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const { session, socket } = connectSession(server, listener, "client-1");

    expect(server.closeSession("never-connected")).toBe(false);
    expect(server.closeSession(session.entity, "first")).toBe(true);
    tick(world);
    ackCloseFrame(socket);
    tick(world);
    const closesAfterFirst = socket.closeCalls;

    expect(server.closeSession(session.entity, "second")).toBe(false);
    expect(server.closeSession("client-1", "third")).toBe(false);
    expect(server.closeSession(world.entity(), "not a client")).toBe(false);
    tick(world);

    expect(socket.closeCalls).toBe(closesAfterFirst);
  });

  it("records the close reason for a NetworkClient exit system", () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const observed: Array<{ id: string; reason: string | undefined }> = [];
    world
      .system("log-close")
      .with(Networked, NetworkClient)
      .phase(PRE_STORE)
      .exit([NetworkClient], (_entity, [client]) => {
        observed.push({ id: client.id, reason: client.closeReason });
      });

    const { socket: first } = connectSession(server, listener, "client-1");
    connectSession(server, listener, "client-2");
    tick(world);

    server.closeSession("client-1", "superseded by a newer connection");
    server.closeSession("client-2");
    // The close is scheduled; the tick that runs `send` flushes client-1's close
    // frame, and the client's ack lets the next tick tear it down. The tick after
    // that drains the exit callbacks.
    tick(world);
    ackCloseFrame(first);
    tick(world);
    tick(world);

    // client-2 had nothing to deliver and closed first.
    expect(observed).toEqual([
      { id: "client-2", reason: undefined },
      { id: "client-1", reason: "superseded by a newer connection" },
    ]);
  });

  it("closes the socket when the application destroys the NetworkClient entity", () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const { session, socket } = connectSession(server, listener, "client-1");

    session.entity.destroy();
    tick(world);

    expect(socket.closed).toBe(true);
    expect(socket.closeCalls).toBe(1);
  });

  it("cleans up exactly once when the peer disconnects after a server close", () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const { socket } = connectSession(server, listener, "client-1");

    server.closeSession("client-1");
    socket.close();
    socket.close();
    tick(world);

    // One close from the server, then the peer's own two; the world adds none.
    expect(socket.closeCalls).toBe(3);
    expect(server.closeSession("client-1")).toBe(false);
  });

  it("closes every connected client when queried through NetworkClient", () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const first = connectSession(server, listener, "client-1");
    const second = connectSession(server, listener, "client-2");
    tick(world);

    world
      .query("shutdown:clients")
      .with(NetworkClient)
      .track()
      .build()
      .forEach((entity) => {
        server.closeSession(entity, "server shutting down");
      });
    tick(world);
    ackCloseFrame(first.socket);
    ackCloseFrame(second.socket);
    tick(world);

    expect(first.socket.closeCalls).toBe(1);
    expect(second.socket.closeCalls).toBe(1);
  });

  it("delivers the rejection that explains the close before disconnecting", async () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const AUTH_RPC = 101;
    const WRONG_WORLD = 4001;
    const INVALID_CREDENTIALS = 4002;
    const accepted = new Set<string>();
    server.handleRpc(AUTH_RPC, (params, _request, ctx: ServerRPCContext) => {
      const [playerId] = params as [string];
      if (!accepted.has(playerId)) {
        // The auth handshake in one call: reject, then hang up.
        const code = playerId === "known" ? WRONG_WORLD : INVALID_CREDENTIALS;
        server.closeSession(ctx.caller, "unauthenticated");
        throw new RPCError(code, `unknown resume token for ${playerId}`);
      }
      return ["ok"];
    });

    const { socket } = connectSession(server, listener, "client-1");
    const reply = await callRpc(socket, world, AUTH_RPC, ["known"]);

    expect(reply.error).toBe(WRONG_WORLD);
    expect(reply.message).toBe("unknown resume token for known");
    // The reply was written on a numbered frame, and the transport stays open
    // while the close lingers — the client acks the frame it received, and
    // only then does the teardown run, exactly once.
    const flushFrame = decodeLastMessage(socket);
    expect(flushFrame.diff).toBeDefined();
    expect(socket.closed).toBe(false);

    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: flushFrame.diff!.toFrame })));
    tick(world);

    expect(socket.closeCalls).toBe(1);
    expect(socket.closed).toBe(true);
    expect(server.closeSession("client-1")).toBe(false);

    const other = connectSession(server, listener, "client-2");
    const second = await callRpc(other.socket, world, AUTH_RPC, ["stranger"]);
    expect(second.error).toBe(INVALID_CREDENTIALS);
    // Same contract on the second connection: linger open until the ack.
    expect(other.socket.closed).toBe(false);
    const secondFlush = decodeLastMessage(other.socket);
    other.socket.receive(
      encodeClient2Server(new Client2Server({ ackFrame: secondFlush.diff!.toFrame }))
    );
    tick(world);
    expect(other.socket.closeCalls).toBe(1);
  });

  it("replicates no further state to a closing session", async () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    server.handleRpc(101, () => "ok");
    const { session, socket } = connectSession(server, listener, "client-1");
    tick(world);

    server.closeSession("client-1");
    const before = socket.sent.length;

    // A frame the transport had already queued must not be honored.
    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 0 })));
    await Promise.resolve();
    tick(world);

    expect(session.entity.get(NetworkInput)).toBeUndefined();
    // Nothing owed and no notice to deliver, so the close emits no frame at all.
    expect(socket.sent.length).toBe(before);
    expect(socket.closeCalls).toBe(1);
  });

  it("closes a stale session once when the disconnect grace period elapses", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const world = createWorld({ disconnectGraceMs: 10_000 });
      const server = world;
      const listener = new MockListener();
      server._attach(listener);
      const { session, socket } = connectSession(server, listener, "client-1");

      tick(world);
      expect(socket.closed).toBe(false);

      now.mockReturnValue(10_001);
      tick(world);
      expect(socket.closed).toBe(true);
      expect(socket.closeCalls).toBe(1);
      expect(world.getEntity(session.entity.eid)).toBeUndefined();

      socket.close();
      expect(socket.closeCalls).toBe(2);
      expect(server.closeSession("client-1")).toBe(false);
    } finally {
      now.mockRestore();
    }
  });
});

describe("ServerWorld close linger", () => {
  async function flushMicrotasks(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * A transport that delivers each send on a later macrotask and drops
   * everything still queued when `close()` runs, the way an unreliable
   * datagram channel does when the peer connection is torn down mid-send.
   */
  class DropOnCloseSocket extends MemorySocket {
    public readonly delivered: Uint8Array[] = [];
    private readonly _undelivered = new Set<Uint8Array>();

    public override send(data: Uint8Array): void {
      super.send(data);
      this._undelivered.add(data);
      queueMicrotask(() => {
        if (!this._undelivered.delete(data)) {
          return; // close() discarded it before the macrotask ran
        }
        this.delivered.push(data);
      });
    }

    public override close(): void {
      this._undelivered.clear();
      super.close();
    }
  }

  /** A world whose linger clock the test drives through mocked `performance.now`. */
  function createLingerWorld(closeLingerMs: number): ServerWorld {
    return createWorld({ closeLingerMs });
  }

  /** Encode one delivered frame so its RPC replies can be inspected. */
  function deliveredReplies(socket: DropOnCloseSocket): RPC[] {
    return socket.delivered.flatMap((bytes) => new Decoder(bytes).read(Server2Client).rpc);
  }

  it("delivers the typed error to a transport that drops undelivered sends on close", async () => {
    const world = createWorld();
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    const AUTH_RPC = 101;
    const WRONG_WORLD = 4001;
    server.handleRpc(AUTH_RPC, (_params, _request, ctx: ServerRPCContext) => {
      server.closeSession(ctx.caller, "wrong world");
      throw new RPCError(WRONG_WORLD, "this client belongs to another world");
    });

    const socket = new DropOnCloseSocket("client-1");
    listener.connect(socket);
    const replies = await deliver(socket, world, {
      rpc: [new RPC({ rpcId: AUTH_RPC, callId: 0, params: [] })],
    });

    // The typed rejection left the server before the transport closed.
    expect(replies.find((reply) => reply.callId === 0)?.error).toBe(WRONG_WORLD);
    await flushMicrotasks();
    // The transport delivered it: closing the session no longer discards the
    // queued reply frame in the same turn it was written.
    expect(deliveredReplies(socket).find((reply) => reply.callId === 0)?.error).toBe(WRONG_WORLD);
    expect(socket.closed).toBe(false);
  });

  it("does not replicate state or accept new calls while the close lingers", async () => {
    const world = createLingerWorld(10_000);
    const server = world;
    allowAllClientViews(world);
    const listener = new MockListener();
    server._attach(listener);
    const calls: string[] = [];
    server.handleRpc(101, (_params, _request, ctx) => {
      server.closeSession(ctx.caller, "closing");
      throw new RPCError(4001, "rejected");
    });
    server.handleRpc(102, (_params, _request, ctx) => {
      calls.push(ctx.connectionId);
      return [];
    });

    const socket = new DropOnCloseSocket("client-1");
    listener.connect(socket);
    const session = getSession(server, "client-1");
    world.entity().add(Networked).set(Position, { x: 1, y: 1 });
    tick(world);
    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: 1 })));
    await deliver(socket, world, {
      rpc: [new RPC({ rpcId: 101, callId: 0, params: [] })],
    });
    const baseline = socket.sent.length;
    expect(socket.closed).toBe(false);

    // State changes and new calls during the linger reach nobody.
    world.entity().add(Networked).set(Position, { x: 2, y: 2 });
    socket.receive(
      encodeClient2Server(
        new Client2Server({
          ackFrame: 0,
          input: { up: true },
          rpc: [new RPC({ rpcId: 102, callId: 1, params: [] })],
        })
      )
    );
    await Promise.resolve();
    await Promise.resolve();
    tick(world);
    tick(world);

    expect(calls).toEqual([]);
    expect(session.entity.get(NetworkInput)).toBeUndefined();
    for (const bytes of socket.sent.slice(baseline)) {
      const message = new Decoder(bytes).read(Server2Client);
      // Only the flush frame may be written: an empty receipt diff, no state.
      expect(message.diff?.snapshots ?? []).toEqual([]);
      expect(message.diff?.removed ?? []).toEqual([]);
    }
    socket.close();
  });

  it("sends the close code and reason on a numbered frame when no reply is owed", () => {
    const server = createLingerWorld(10_000);
    const listener = new MockListener();
    server._attach(listener);
    const socket = new DropOnCloseSocket("client-1");
    listener.connect(socket);
    tick(server);
    const before = socket.sent.length;

    expect(server.closeSession("client-1", "superseded by client-2", 4003)).toBe(true);
    tick(server);

    const frame = new Decoder(socket.sent[socket.sent.length - 1]).read(Server2Client);
    expect(socket.sent.length).toBe(before + 1);
    expect(frame.close).toEqual({ code: 4003, reason: "superseded by client-2" });
    expect(frame.diff).toBeDefined();
    // The close lingers until the frame is acked, like any close with a reply.
    expect(socket.closed).toBe(false);
    tick(server);
    expect(new Decoder(socket.sent[socket.sent.length - 1]).read(Server2Client).close).toEqual({
      code: 4003,
      reason: "superseded by client-2",
    });

    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: frame.diff!.toFrame })));
    tick(server);
    expect(socket.closed).toBe(true);
  });

  it("sends the close notice together with the owed RPC reply", async () => {
    const server = createLingerWorld(10_000);
    const listener = new MockListener();
    server._attach(listener);
    server.handleRpc(101, (_params, _request, ctx) => {
      server.closeSession(ctx.caller, "wrong world", 4001);
      throw new RPCError(4001, "rejected");
    });
    const socket = new DropOnCloseSocket("client-1");
    listener.connect(socket);

    await deliver(socket, server, { rpc: [new RPC({ rpcId: 101, callId: 0, params: [] })] });

    const frame = new Decoder(socket.sent[socket.sent.length - 1]).read(Server2Client);
    expect(frame.rpc[0].error).toBe(4001);
    expect(frame.close).toEqual({ code: 4001, reason: "wrong world" });
  });

  it("emits no close frame for a close with neither reason nor code", () => {
    const server = createLingerWorld(10_000);
    const listener = new MockListener();
    server._attach(listener);
    const socket = new DropOnCloseSocket("client-1");
    listener.connect(socket);
    tick(server);
    const before = socket.sent.length;

    server.closeSession("client-1");
    tick(server);

    expect(socket.sent.length).toBe(before);
    expect(socket.closed).toBe(true);
  });

  it("ends the linger as soon as the client acknowledges the flushed frame", async () => {
    const world = createLingerWorld(10_000);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    server.handleRpc(101, (_params, _request, ctx) => {
      server.closeSession(ctx.caller, "closing");
      throw new RPCError(4001, "rejected");
    });

    const socket = new DropOnCloseSocket("client-1");
    listener.connect(socket);
    const session = getSession(server, "client-1");
    await deliver(socket, world, {
      rpc: [new RPC({ rpcId: 101, callId: 0, params: [] })],
    });

    // The flush frame is numbered: acking it is the delivery receipt.
    const flush = new Decoder(socket.sent[socket.sent.length - 1]).read(Server2Client);
    expect(flush.diff).toBeDefined();
    const flushedTo = flush.diff!.toFrame;
    expect(socket.closed).toBe(false);

    socket.receive(encodeClient2Server(new Client2Server({ ackFrame: flushedTo })));
    tick(world);

    expect(socket.closeCalls).toBe(1);
    expect(socket.closed).toBe(true);
    expect(world.getEntity(session.entity.eid)).toBeUndefined();
    expect(server.closeSession("client-1")).toBe(false);
  });

  it("bounds the linger by closeLingerMs when no acknowledgement arrives", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const world = createLingerWorld(250);
      const server = world;
      const listener = new MockListener();
      server._attach(listener);
      server.handleRpc(101, (_params, _request, ctx) => {
        server.closeSession(ctx.caller, "closing");
        throw new RPCError(4001, "rejected");
      });

      const socket = new DropOnCloseSocket("client-1");
      listener.connect(socket);
      await deliver(socket, world, {
        rpc: [new RPC({ rpcId: 101, callId: 0, params: [] })],
      });
      expect(socket.closed).toBe(false);

      now.mockReturnValue(249);
      tick(world);
      expect(socket.closed).toBe(false);

      now.mockReturnValue(250);
      tick(world);
      expect(socket.closeCalls).toBe(1);
      expect(socket.closed).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("retransmits the flushed frame on every linger tick so a lost datagram gets another chance", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const world = createLingerWorld(10_000);
      const server = world;
      const listener = new MockListener();
      server._attach(listener);
      server.handleRpc(101, (_params, _request, ctx) => {
        server.closeSession(ctx.caller, "closing");
        throw new RPCError(4001, "rejected");
      });

      const socket = new DropOnCloseSocket("client-1");
      listener.connect(socket);
      await deliver(socket, world, {
        rpc: [new RPC({ rpcId: 101, callId: 0, params: [] })],
      });
      const flushBytes = socket.sent[socket.sent.length - 1];
      const flushFrame = new Decoder(flushBytes).read(Server2Client);
      const sentAfterFlush = socket.sent.length;
      expect(socket.closed).toBe(false);

      tick(world);
      tick(world);

      // Every linger tick re-sends the same frame; the client deduplicates.
      expect(socket.sent.length - sentAfterFlush).toBe(2);
      for (const bytes of socket.sent.slice(sentAfterFlush)) {
        expect(new Decoder(bytes).read(Server2Client).diff?.toFrame).toBe(flushFrame.diff!.toFrame);
      }

      // The retransmitted frame carries the reply to the client, repeatedly.
      await flushMicrotasks();
      expect(deliveredReplies(socket).filter((reply) => reply.callId === 0)).toHaveLength(3);
    } finally {
      now.mockRestore();
    }
  });

  it("ends the session exactly once when the transport disconnects during the linger", async () => {
    const world = createLingerWorld(10_000);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);
    server.handleRpc(101, (_params, _request, ctx) => {
      server.closeSession(ctx.caller, "closing");
      throw new RPCError(4001, "rejected");
    });

    const socket = new DropOnCloseSocket("client-1");
    listener.connect(socket);
    const session = getSession(server, "client-1");
    await deliver(socket, world, {
      rpc: [new RPC({ rpcId: 101, callId: 0, params: [] })],
    });
    expect(socket.closed).toBe(false);

    // The peer vanishes mid-linger: the existing teardown runs immediately.
    socket.close();
    // One close from the peer's own `close()`, one from the server's teardown.
    expect(socket.closeCalls).toBe(2);
    expect(world.getEntity(session.entity.eid)).toBeUndefined();
    expect(server.closeSession("client-1")).toBe(false);

    // Later ticks neither resurrect the session nor touch the socket again.
    tick(world);
    tick(world);
    expect(socket.closeCalls).toBe(2);
    expect(world.getEntity(session.entity.eid)).toBeUndefined();
  });

  it("closes promptly when the session owes no replies", () => {
    const world = createLingerWorld(10_000);
    const server = world;
    const listener = new MockListener();
    server._attach(listener);

    const socket = new DropOnCloseSocket("client-1");
    listener.connect(socket);
    const sent = socket.sent.length;

    server.closeSession("client-1");
    tick(world);

    // Nothing owed and no notice, so the close emits no frame and does not wait for an ack.
    expect(socket.sent.length).toBe(sent);
    expect(socket.closeCalls).toBe(1);
    expect(socket.closed).toBe(true);
  });
});

describe("ServerWorld undecodable frames", () => {
  /** A leading ack varint that never ends: every byte has its continuation bit set. */
  const randomBytes = (): Uint8Array => Uint8Array.of(0xde, 0xad, 0xbe, 0xef);

  /** A well-formed frame followed by a field tag no protocol version defines. */
  const unknownTagFrame = (tag: number): Uint8Array =>
    Uint8Array.of(...encodeClient2Server(new Client2Server({ ackFrame: 0 })), tag);

  /** A valid frame whose last bytes never arrived. */
  const truncatedFrame = (): Uint8Array => {
    const whole = encodeClient2Server(
      new Client2Server({
        ackFrame: 3,
        rpc: [new RPC({ rpcId: 101, callId: 1, params: ["hello"] })],
      })
    );
    return whole.slice(0, whole.length - 3);
  };

  const UNDECODABLE_FRAMES = [
    { name: "random bytes", frame: randomBytes, reason: /^protocol error: .+/ },
    { name: "a truncated frame", frame: truncatedFrame, reason: /^protocol error: .+/ },
    {
      name: "an unknown field tag",
      frame: () => unknownTagFrame(99),
      reason: /^protocol error: Invalid Client2Server field tag 99$/,
    },
  ];

  /** Two sessions in one world, both able to see every networked entity. */
  function setup(options: ServerWorldOptions = {}) {
    const world = createWorld(options);
    allowAllClientViews(world);
    const listener = new MockListener();
    world._attach(listener);
    world.handleRpc(101, () => "pong");
    const a = connectSession(world, listener, "client-a");
    const b = connectSession(world, listener, "client-b");
    return { world, a, b };
  }

  function closeReasonOf(session: TestSession): string | undefined {
    return session.entity.get(NetworkClient)?.closeReason;
  }

  function lastPosition(socket: MemorySocket): Position {
    return decodeFirstSnapshotPayload(socket.sent[socket.sent.length - 1]);
  }

  it.each(UNDECODABLE_FRAMES)("closes only the session that sends $name", ({ frame, reason }) => {
    const { world, a, b } = setup();
    tick(world);
    const aEid = a.session.entity.eid;
    const bEid = b.session.entity.eid;

    expect(() => a.socket.receive(frame())).not.toThrow();

    const closeReason = closeReasonOf(a.session);
    expect(closeReason).toMatch(reason);
    expect(closeReasonOf(b.session)).toBeUndefined();

    // The next send() hands the client the close notice on a numbered frame, and
    // the session lingers until the client acks that frame.
    tick(world);
    expect(decodeLastMessage(a.socket).close).toEqual({
      code: CLOSE_PROTOCOL_ERROR_CODE,
      reason: closeReason,
    });
    expect(a.socket.closed).toBe(false);

    ackCloseFrame(a.socket);
    tick(world);

    expect(a.socket.closeCalls).toBe(1);
    expect(world.getEntity(aEid)).toBeUndefined();
    expect(world.closeSession("client-a")).toBe(false);
    expect(b.socket.closed).toBe(false);
    expect(world.getEntity(bEid)?.get(NetworkClient)?.id).toBe("client-b");
  });

  it.each(UNDECODABLE_FRAMES)(
    "keeps serving the other session while one sends $name",
    async ({ frame }) => {
      const { world, a, b } = setup();
      const thing = world.entity().add(Networked).set(Position, { x: 1, y: 1 });
      tick(world);
      expect(lastPosition(b.socket)).toMatchObject({ x: 1, y: 1 });
      ackLatestFrame(b.socket);

      a.socket.receive(frame());

      // While the offender's close lingers, the other session still receives
      // state and has its calls answered.
      thing.set(Position, { x: 2, y: 2 });
      expect((await callRpc(b.socket, world, 101)).params).toEqual(["pong"]);
      expect(lastPosition(b.socket)).toMatchObject({ x: 2, y: 2 });
      expect(a.socket.closed).toBe(false);

      // And once the offender is gone.
      ackCloseFrame(a.socket);
      tick(world);
      expect(a.socket.closed).toBe(true);
      thing.set(Position, { x: 3, y: 3 });
      expect((await callRpc(b.socket, world, 101)).params).toEqual(["pong"]);
      expect(lastPosition(b.socket)).toMatchObject({ x: 3, y: 3 });
      expect(b.socket.closeCalls).toBe(0);
    }
  );

  it("tears the session down when the linger ends without an ack", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const { world, a } = setup({ closeLingerMs: 250 });
      const aEid = a.session.entity.eid;

      a.socket.receive(randomBytes());
      tick(world);
      expect(decodeLastMessage(a.socket).close?.code).toBe(CLOSE_PROTOCOL_ERROR_CODE);

      now.mockReturnValue(249);
      tick(world);
      expect(a.socket.closed).toBe(false);

      now.mockReturnValue(250);
      tick(world);
      expect(a.socket.closeCalls).toBe(1);
      expect(world.getEntity(aEid)).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it("drops further undecodable frames from a closing session and keeps the first reason", () => {
    const { world, a } = setup();

    a.socket.receive(unknownTagFrame(99));
    const first = closeReasonOf(a.session);
    expect(first).toBe("protocol error: Invalid Client2Server field tag 99");

    expect(() => {
      a.socket.receive(unknownTagFrame(98));
      a.socket.receive(randomBytes());
    }).not.toThrow();

    expect(closeReasonOf(a.session)).toBe(first);
    tick(world);
    expect(decodeLastMessage(a.socket).close).toEqual({
      code: CLOSE_PROTOCOL_ERROR_CODE,
      reason: first,
    });
    ackCloseFrame(a.socket);
    tick(world);
    expect(a.socket.closeCalls).toBe(1);
  });

  it("keeps the reason of a session the application already closed", () => {
    const { world, a } = setup();
    const SUPERSEDED = 4003;

    expect(world.closeSession("client-a", "superseded by client-b", SUPERSEDED)).toBe(true);
    expect(() => a.socket.receive(randomBytes())).not.toThrow();

    expect(closeReasonOf(a.session)).toBe("superseded by client-b");
    tick(world);
    expect(decodeLastMessage(a.socket).close).toEqual({
      code: SUPERSEDED,
      reason: "superseded by client-b",
    });
  });

  it("drops an undecodable frame that arrives after the session was torn down", () => {
    const { world, a } = setup();
    world.closeSession("client-a");
    tick(world);
    expect(a.socket.closeCalls).toBe(1);

    expect(() => a.socket.receive(randomBytes())).not.toThrow();

    expect(world.closeSession("client-a")).toBe(false);
    expect(a.socket.closeCalls).toBe(1);
  });
});

describe("ServerWorld send failures", () => {
  type FailureMode = "throw" | "reject";

  /** A socket whose `send` fails on demand, as a transport does mid-disconnect. */
  class FailingSocket extends MemorySocket {
    public attempts = 0;
    public failing = false;

    public constructor(
      id: string,
      private readonly _mode: FailureMode
    ) {
      super(id);
    }

    public override send(data: Uint8Array): void {
      this.attempts++;
      if (!this.failing) {
        super.send(data);
        return;
      }
      if (this._mode === "throw") {
        throw new Error("CONNECTION_CLOSED");
      }
      return Promise.reject(new Error("CONNECTION_CLOSED")) as unknown as void;
    }
  }

  async function flushMicrotasks(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function withUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await run();
      await flushMicrotasks();
    } finally {
      process.off("unhandledRejection", listener);
    }
    return seen;
  }

  function setup(mode: FailureMode) {
    const world = createWorld();
    allowAllClientViews(world);
    const listener = new MockListener();
    world._attach(listener);
    const bad = new FailingSocket("bad", mode);
    listener.connect(bad);
    const good = connectSession(world, listener, "good");
    const entity = world.entity().add(Networked).set(Position, { x: 1, y: 1 });
    tick(world);
    ackLatestFrame(bad);
    ackLatestFrame(good.socket);
    return { world, bad, good: good.socket, entity, badEid: getSession(world, "bad").entity.eid };
  }

  for (const mode of ["throw", "reject"] as const) {
    describe(`when socket.send ${mode === "throw" ? "throws" : "returns a rejected promise"}`, () => {
      it("disconnects only that session, once, with no unhandled rejection", async () => {
        const { world, bad, good, entity, badEid } = setup(mode);
        const goodBefore = good.sent.length;
        bad.failing = true;

        const unhandled = await withUnhandledRejections(async () => {
          entity.set(Position, { x: 2, y: 2 });
          tick(world);
          await flushMicrotasks();
          entity.set(Position, { x: 3, y: 3 });
          tick(world);
          tick(world);
        });

        expect(unhandled).toEqual([]);
        expect(bad.attempts).toBe(2);
        expect(bad.closeCalls).toBe(1);
        expect(world.getEntity(badEid)).toBeUndefined();
        expect(good.closed).toBe(false);
        expect(good.sent.length).toBeGreaterThan(goodBefore);
        expect(decodeFirstSnapshotPayload(good.sent[good.sent.length - 1])).toMatchObject({
          x: 3,
          y: 3,
        });
      });

      it("keeps the world ticking and healthy sessions replicating", async () => {
        const { world, bad, good, entity } = setup(mode);
        bad.failing = true;
        entity.set(Position, { x: 2, y: 2 });
        tick(world);
        await flushMicrotasks();
        entity.set(Position, { x: 9, y: 9 });
        tick(world);

        expect(decodeFirstSnapshotPayload(good.sent[good.sent.length - 1])).toMatchObject({
          x: 9,
          y: 9,
        });
      });

      it("does not retry sends when several frames fail in a row", async () => {
        const { world, bad, entity } = setup(mode);
        bad.failing = true;
        const before = bad.attempts;
        const unhandled = await withUnhandledRejections(async () => {
          for (let i = 0; i < 4; i++) {
            entity.set(Position, { x: 10 + i, y: 0 });
            tick(world);
            // A rejection lands on a later turn, as it does between real ticks.
            await flushMicrotasks();
          }
        });
        expect(unhandled).toEqual([]);
        expect(bad.attempts - before).toBe(1);
        expect(bad.closeCalls).toBe(1);
      });

      it("treats a failed RPC reply flush as a disconnect", async () => {
        const { world, bad, good } = setup(mode);
        world.handleRpc(107, () => "pong");
        const before = bad.attempts;
        bad.failing = true;

        const unhandled = await withUnhandledRejections(async () => {
          bad.receive(
            encodeClient2Server(
              new Client2Server({
                ackFrame: 0,
                rpc: [new RPC({ rpcId: 107, callId: 0, params: [] })],
              })
            )
          );
          await Promise.resolve();
          await Promise.resolve();
          tick(world);
          await flushMicrotasks();
          tick(world);
        });

        expect(unhandled).toEqual([]);
        expect(bad.attempts - before).toBe(1);
        expect(bad.closeCalls).toBe(1);
        expect(good.closed).toBe(false);
      });

      it("treats a failed closeSession flush as a disconnect", async () => {
        const { world, bad, good } = setup(mode);
        world.handleRpc(107, () => {
          world.closeSession("bad");
          return "bye";
        });
        const before = bad.attempts;
        bad.failing = true;

        const unhandled = await withUnhandledRejections(async () => {
          bad.receive(
            encodeClient2Server(
              new Client2Server({
                ackFrame: 0,
                rpc: [new RPC({ rpcId: 107, callId: 0, params: [] })],
              })
            )
          );
          await Promise.resolve();
          await Promise.resolve();
          tick(world);
          await flushMicrotasks();
          tick(world);
        });

        expect(unhandled).toEqual([]);
        expect(bad.attempts - before).toBe(1);
        expect(bad.closeCalls).toBe(1);
        expect(good.closed).toBe(false);
      });
    });
  }

  it("works with a transport whose send returns undefined", () => {
    const { world, good } = setup("throw");
    tick(world);
    expect(good.closed).toBe(false);
    expect(world.getEntity(getSession(world, "good").entity.eid)).toBeDefined();
  });
});

describe("ServerWorld.frame", () => {
  it("is the frame the next send numbers, which systems see during progress", () => {
    const world = createWorld();
    const seen: number[] = [];
    world.system("test.frame").run(() => {
      seen.push(world.frame);
    });

    expect(world.frame).toBe(1);
    tick(world);
    tick(world);
    world.send();

    expect(seen).toEqual([1, 2]);
    expect(world.frame).toBe(4);
  });
});
