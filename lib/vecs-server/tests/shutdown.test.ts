import { describe, expect, it, vi } from "vitest";
import {
  Client2Server,
  RPC,
  Server2Client,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, type IEncodable } from "@vworlds/vecs-wire";
import { NetworkClient, ServerWorld, VecsListener } from "../src/index.js";

type SocketHandler = (arg?: unknown) => void;

/** A client transport that records frames and, when `autoAck` is set, acks each numbered frame. */
class MemorySocket implements VecsSocket {
  public readonly sent: Uint8Array[] = [];
  public readonly events: string[] = [];
  public closeCalls = 0;
  public autoAck = true;
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
    this.events.push("frame");
    const frame = new Decoder(data).read(Server2Client);
    if (this.autoAck && frame.diff) {
      const toFrame = frame.diff.toFrame;
      queueMicrotask(() => this.receive(encode(new Client2Server({ ackFrame: toFrame }))));
    }
  }

  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }

  public close(): void {
    this.closeCalls++;
    this.events.push("close");
  }

  public get closed(): boolean {
    return this.closeCalls > 0;
  }

  public replies(): RPC[] {
    return this.sent.flatMap((bytes) => new Decoder(bytes).read(Server2Client).rpc);
  }
}

class MockListener implements VecsSocketListener {
  public closeCalls = 0;
  private readonly _handlers: ((socket: VecsSocket) => void)[] = [];

  public on(event: "new", handler: (socket: VecsSocket) => void): this {
    if (event === "new") {
      this._handlers.push(handler);
    }
    return this;
  }

  public async close(): Promise<void> {
    this.closeCalls++;
  }

  public connect(socket: VecsSocket): void {
    this._handlers.forEach((handler) => handler(socket));
  }
}

function encode(message: IEncodable): Uint8Array {
  const encoder = new Encoder(new Uint8Array(64 * 1024));
  encoder.write(message);
  return encoder.getBuffer();
}

const PING_RPC = 101;

function setup(options: ConstructorParameters<typeof ServerWorld>[0] = {}) {
  const world = new ServerWorld({ name: "main", networkComponents: [], ...options });
  const listener = new MockListener();
  world._attach(listener);
  world.handleRpc(PING_RPC, () => "pong");
  return { world, listener };
}

/** Queue a ping whose reply is owed (handled but not yet sent) when this resolves. */
async function owePing(socket: MemorySocket, callId: number): Promise<void> {
  socket.receive(
    encode(
      new Client2Server({ ackFrame: 0, rpc: [new RPC({ rpcId: PING_RPC, callId, params: [] })] })
    )
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function connect(world: ServerWorld, listener: MockListener, id: string): MemorySocket {
  const socket = new MemorySocket(id);
  listener.connect(socket);
  return socket;
}

function liveClients(world: ServerWorld): number {
  let count = 0;
  world
    .query("test:clients")
    .with(NetworkClient)
    .track()
    .build()
    .forEach(() => count++);
  return count;
}

describe("ServerWorld.shutdown", () => {
  it("flushes owed replies before closing every session, without a tick loop", async () => {
    const { world, listener } = setup();
    const a = connect(world, listener, "a");
    const b = connect(world, listener, "b");
    await owePing(a, 7);
    await owePing(b, 8);
    expect(a.sent).toHaveLength(0);

    await world.shutdown();

    for (const [socket, callId] of [
      [a, 7],
      [b, 8],
    ] as const) {
      expect(socket.replies().find((reply) => reply.callId === callId)?.error).toBe(0);
      expect(socket.events[socket.events.length - 1]).toBe("close");
      expect(socket.events.indexOf("frame")).toBeLessThan(socket.events.indexOf("close"));
      expect(socket.closeCalls).toBe(1);
    }
    expect(liveClients(world)).toBe(0);
  });

  it("closes sessions with nothing owed and records the close reason", async () => {
    const { world, listener } = setup();
    const socket = connect(world, listener, "a");
    let reason: string | undefined;
    world.component(NetworkClient).on("remove", (_entity, client) => {
      reason = client.closeReason;
    });

    await world.shutdown({ reason: "maintenance" });

    expect(socket.sent).toHaveLength(0);
    expect(socket.closeCalls).toBe(1);
    expect(reason).toBe("maintenance");
  });

  it("keeps flushing until the linger ends for a client that never acks", async () => {
    const { world, listener } = setup({ closeLingerMs: 40 });
    const socket = connect(world, listener, "a");
    socket.autoAck = false;
    await owePing(socket, 1);

    const started = performance.now();
    await world.shutdown({ timeoutMs: 5000 });

    expect(socket.closeCalls).toBe(1);
    // The flush frame is retransmitted every poll until the linger ends.
    expect(socket.replies().length).toBeGreaterThan(1);
    expect(socket.replies().every((reply) => reply.callId === 1)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("destroys sessions still present at the timeout", async () => {
    const { world, listener } = setup({ closeLingerMs: 60_000 });
    const socket = connect(world, listener, "a");
    socket.autoAck = false;
    await owePing(socket, 1);

    await world.shutdown({ timeoutMs: 50 });

    expect(socket.closeCalls).toBe(1);
    expect(liveClients(world)).toBe(0);
  });

  it("is idempotent and returns one promise", async () => {
    const { world, listener } = setup();
    const socket = connect(world, listener, "a");

    const first = world.shutdown();
    const second = world.shutdown({ timeoutMs: 1 });
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await world.shutdown();

    expect(socket.closeCalls).toBe(1);
    expect(listener.closeCalls).toBe(1);
  });

  it("closes the listener and refuses connections that arrive afterwards", async () => {
    const { world, listener } = setup();
    await world.shutdown();

    const late = connect(world, listener, "late");

    expect(listener.closeCalls).toBe(1);
    expect(late.closeCalls).toBe(1);
    expect(liveClients(world)).toBe(0);
  });

  it("resolves even when a listener's close rejects", async () => {
    const { world, listener } = setup();
    vi.spyOn(listener, "close").mockRejectedValue(new Error("boom"));

    await expect(world.shutdown()).resolves.toBeUndefined();
  });
});

describe("VecsListener.close", () => {
  it("shuts down every registered world and is idempotent", async () => {
    const vecs = new VecsListener();
    const first = vecs.registerWorld(new ServerWorld({ name: "one", networkComponents: [] }));
    const second = vecs.registerWorld(new ServerWorld({ name: "two", networkComponents: [] }));
    const listenerOne = new MockListener();
    const listenerTwo = new MockListener();
    first._attach(listenerOne);
    second._attach(listenerTwo);
    const socketOne = connect(first, listenerOne, "a");
    const socketTwo = connect(second, listenerTwo, "b");

    const closing = vecs.close();
    await vecs.close();
    await closing;

    expect(socketOne.closeCalls).toBe(1);
    expect(socketTwo.closeCalls).toBe(1);
    expect(listenerOne.closeCalls).toBe(1);
    expect(listenerTwo.closeCalls).toBe(1);
  });
});
