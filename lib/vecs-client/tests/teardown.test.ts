import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Client2Server,
  ComponentSnapshot,
  EncodedSnapshot,
  RPC_CLOSED_CODE,
  Server2Client,
  StateDiff,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import { ClientWorld } from "../src/index.js";

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

type SocketHandler = (arg?: unknown) => void;
type SendMode = "ok" | "throw" | "reject" | "deferred-reject";

class MockSocket implements VecsSocket {
  public readonly sent: Uint8Array[] = [];
  public closeCalls = 0;
  public sendMode: SendMode = "ok";
  private readonly _handlers = new Map<string, SocketHandler[]>();
  private readonly _deferred: Array<(reason: Error) => void> = [];

  public constructor(public readonly id: string) {}

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public send(data: Uint8Array): void {
    this.sent.push(data);
    if (this.sendMode === "throw") {
      throw new Error("peer closed");
    }
    if (this.sendMode === "reject") {
      return Promise.reject(new Error("peer closed")) as never;
    }
    if (this.sendMode === "deferred-reject") {
      return new Promise((_, reject) => this._deferred.push(reject)) as never;
    }
  }

  /** Reject the sends made in `deferred-reject` mode. */
  public rejectDeferred(): void {
    this._deferred.splice(0).forEach((reject) => reject(new Error("late failure")));
  }

  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }

  public close(): void {
    this.closeCalls += 1;
    this.disconnect();
  }

  public disconnect(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

/** Observes how a call settles, counting every settlement. */
function track(promise: Promise<unknown[]>) {
  const state = { resolved: 0, rejected: 0, codes: [] as number[] };
  promise.then(
    () => {
      state.resolved += 1;
    },
    (error: { code: number }) => {
      state.rejected += 1;
      state.codes.push(error.code);
    }
  );
  return state;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

function encode(message: IEncodable): Uint8Array {
  const encoder = new Encoder(new Uint8Array(64 * 1024));
  encoder.write(message);
  return encoder.getBuffer();
}

/** A baseline carrying one `Position` snapshot, as a server session would send it. */
function positionBaseline(eid: number, toFrame: number, x: number, y: number): Uint8Array {
  const position = new Position();
  position.x = x;
  position.y = y;
  const payload = new Encoder(new Uint8Array(1024));
  payload.write(position);
  const snapshot = new EncodedSnapshot(
    encode(new ComponentSnapshot({ eid, wireType: 1, payload: payload.getBuffer() })),
    eid,
    1
  );
  return encode(
    new Server2Client({ diff: new StateDiff({ fromFrame: 0, toFrame, snapshots: [snapshot] }) })
  );
}

/** The frame number the client acked on the last frame it sent to `socket`. */
function ackedFrame(socket: MockSocket): number {
  return new Decoder(socket.sent[socket.sent.length - 1]).read(Client2Server).ackFrame;
}

function sentRequests(socket: MockSocket): number {
  return socket.sent.reduce((total, frame) => {
    const message = new Decoder(frame).read(Client2Server);
    return total + message.rpc.length;
  }, 0);
}

/** Drives a world into the disconnected state through one teardown route. */
const routes: Record<string, (world: ClientWorld, socket: MockSocket) => Promise<void>> = {
  "peer disconnect event": async (_world, socket) => {
    socket.disconnect();
  },
  "synchronous send throw": async (world, socket) => {
    socket.sendMode = "throw";
    world.send();
  },
  "rejected send": async (world, socket) => {
    socket.sendMode = "reject";
    world.send();
    await flush();
  },
  "close()": async (world) => {
    world.close();
  },
};

describe("ClientWorld.invoke while disconnected", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each(Object.entries(routes))("after %s", (_name, disconnect) => {
    it("rejects immediately with RPC_CLOSED_CODE", async () => {
      const world = new ClientWorld({ ackIntervalMs: 10 });
      world.attachSocket(new MockSocket("a"));
      await disconnect(world, (world as unknown as { _socket: MockSocket })._socket);

      const call = track(world.invoke(101, ["late"]));
      await flush();

      expect(call).toMatchObject({ resolved: 0, rejected: 1, codes: [RPC_CLOSED_CODE] });
    });

    it("queues nothing for the next connection", async () => {
      const world = new ClientWorld({ ackIntervalMs: 10 });
      const first = new MockSocket("a");
      world.attachSocket(first);
      await disconnect(world, first);
      const call = track(world.invoke(101, ["late"]));
      await flush();

      const second = new MockSocket("b");
      world.attachSocket(second);
      world.send();

      expect(call.rejected).toBe(1);
      expect(sentRequests(second)).toBe(0);
      world.dispose();
    });
  });

  it("still queues a call made before the first attachSocket and sends it on connect", async () => {
    const world = new ClientWorld({ ackIntervalMs: 10 });
    const call = track(world.invoke(101, ["early"]));
    const socket = new MockSocket("a");

    world.attachSocket(socket);
    world.send();
    await flush();

    expect(sentRequests(socket)).toBe(1);
    expect(call).toMatchObject({ resolved: 0, rejected: 0 });
    world.dispose();
  });

  it("works normally after a reconnect", async () => {
    const world = new ClientWorld({ ackIntervalMs: 10 });
    const first = new MockSocket("a");
    world.attachSocket(first);
    first.disconnect();

    const second = new MockSocket("b");
    world.attachSocket(second);
    const call = track(world.invoke(101, ["fresh"]));
    world.send();
    await flush();

    expect(sentRequests(second)).toBe(1);
    expect(call).toMatchObject({ resolved: 0, rejected: 0 });
    world.dispose();
  });
});

describe("ClientWorld teardown order", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  type Step = "event" | "close" | "dispose" | "sendFail";
  const sequences: Step[][] = [
    ["event", "close", "dispose"],
    ["dispose", "event"],
    ["sendFail", "event", "close"],
    ["close", "sendFail"],
    ["event", "dispose", "close"],
    ["close", "event", "sendFail", "dispose"],
  ];

  it.each(sequences)("is idempotent for %s", async (...steps) => {
    const world = new ClientWorld({ ackIntervalMs: 10 });
    const socket = new MockSocket("a");
    const disconnect = vi.fn();
    world.attachSocket(socket);
    world.events.on("disconnect", disconnect);
    const calls = [track(world.invoke(101)), track(world.invoke(102))];

    const run: Record<Step, () => void> = {
      event: () => socket.disconnect(),
      close: () => world.close(),
      dispose: () => world.dispose(),
      sendFail: () => {
        socket.sendMode = "throw";
        world.send();
      },
    };
    expect(() => steps.forEach((step) => run[step]())).not.toThrow();
    await flush();

    // dispose's own close never emits `disconnect`; any other route emits it once.
    const expected = steps[0] === "dispose" ? 0 : 1;
    expect(disconnect).toHaveBeenCalledTimes(expected);
    calls.forEach((call) => {
      expect(call).toMatchObject({ resolved: 0, rejected: 1, codes: [RPC_CLOSED_CODE] });
    });

    const sentBefore = socket.sent.length;
    vi.advanceTimersByTime(100);
    expect(socket.sent.length).toBe(sentBefore);
  });
});

describe("ClientWorld stale sockets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores a late disconnect from a replaced socket", async () => {
    const world = new ClientWorld({ ackIntervalMs: 10 });
    const a = new MockSocket("a");
    const b = new MockSocket("b");
    const disconnect = vi.fn();
    world.attachSocket(a);
    world.attachSocket(b);
    world.events.on("disconnect", disconnect);
    const pending = track(world.invoke(101));

    a.disconnect();
    await flush();

    expect(disconnect).not.toHaveBeenCalled();
    expect(pending).toMatchObject({ resolved: 0, rejected: 0 });
    const sentBefore = b.sent.length;
    vi.advanceTimersByTime(10);
    expect(b.sent.length).toBeGreaterThan(sentBefore);
    const later = track(world.invoke(102));
    await flush();
    expect(later).toMatchObject({ resolved: 0, rejected: 0 });
    world.dispose();
  });

  it("ignores a rejected send from a replaced socket", async () => {
    const world = new ClientWorld({ ackIntervalMs: 10 });
    const a = new MockSocket("a");
    a.sendMode = "deferred-reject";
    const b = new MockSocket("b");
    const disconnect = vi.fn();
    world.attachSocket(a);
    world.events.on("disconnect", disconnect);
    world.send();
    world.attachSocket(b);
    const pending = track(world.invoke(101));

    a.rejectDeferred();
    await flush();

    expect(disconnect).not.toHaveBeenCalled();
    expect(pending).toMatchObject({ resolved: 0, rejected: 0 });
    world.dispose();
  });

  it("ignores a frame that arrives on a replaced socket", () => {
    const world = new ClientWorld({
      networkComponents: [Position],
      ackIntervalMs: 10,
      serverTickIntervalMs: 10,
    });
    const a = new MockSocket("a");
    const b = new MockSocket("b");
    world.attachSocket(a);
    world.attachSocket(b);

    // The old server session's baseline, delivered late on the old socket.
    a.receive(positionBaseline(1000, 7, 1, 1));
    world.apply(0);

    expect(world.getEntity(1000)).toBeUndefined();
    world.send();
    expect(ackedFrame(b)).toBe(0);

    // The same frame on the current socket is applied and acked.
    b.receive(positionBaseline(1000, 7, 1, 1));
    world.apply(0);

    expect(world.entity(1000).get(Position)).toMatchObject({ x: 1, y: 1 });
    world.send();
    expect(ackedFrame(b)).toBe(7);
    world.dispose();
  });

  it("does not let an undecodable frame on a replaced socket close the new connection", () => {
    const world = new ClientWorld({ networkComponents: [Position], ackIntervalMs: 10 });
    const a = new MockSocket("a");
    const b = new MockSocket("b");
    const disconnect = vi.fn();
    world.attachSocket(a);
    world.attachSocket(b);
    world.events.on("disconnect", disconnect);

    expect(() => a.receive(Uint8Array.of(0xde, 0xad, 0xbe, 0xef))).not.toThrow();

    expect(disconnect).not.toHaveBeenCalled();
    expect(a.closeCalls).toBe(0);
    expect(b.closeCalls).toBe(0);
    // The new connection keeps working.
    b.receive(positionBaseline(1000, 1, 3, 4));
    world.apply(0);
    expect(world.entity(1000).get(Position)).toMatchObject({ x: 3, y: 4 });
    world.dispose();
  });

  it("does not let a close notice retransmitted on a replaced socket disconnect the new one", () => {
    const world = new ClientWorld({ ackIntervalMs: 10 });
    const a = new MockSocket("a");
    const b = new MockSocket("b");
    const disconnect = vi.fn();
    world.events.on("disconnect", disconnect);
    world.attachSocket(a);
    // The old server session's close frame arrives, and the application reconnects.
    a.receive(encode(new Server2Client({ close: { code: 4003, reason: "superseded" } })));
    expect(disconnect).toHaveBeenCalledTimes(1);
    world.attachSocket(b);

    // The old session lingers and retransmits its close frame on the old socket.
    a.receive(encode(new Server2Client({ close: { code: 4003, reason: "superseded" } })));

    expect(disconnect).toHaveBeenCalledTimes(1);
    const sentBefore = b.sent.length;
    vi.advanceTimersByTime(10);
    expect(b.sent.length).toBeGreaterThan(sentBefore);
    world.dispose();
  });
});
