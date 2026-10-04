import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client2Server, RPC, Server2Client, type VecsSocket } from "@vworlds/vecs-protocol";
import { Decoder, Encoder, wireType } from "@vworlds/vecs-wire";
import { NetworkClient, ServerWorld, VecsListener, type ServerRPCContext } from "../src/index.js";

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

/**
 * Stand-in for the dgram `SocketListener`, recorded so the test can drive each
 * per-world listener `VecsListener.listen` creates.
 */
interface RecordedListener {
  options: Record<string, unknown>;
  connect(socket: VecsSocket): void;
}

const recorded = vi.hoisted(() => [] as RecordedListener[]);

vi.mock("@vworlds/dgram-server", () => ({
  SocketListener: class {
    public options: Record<string, unknown> = {};
    private readonly _handlers: Array<(socket: VecsSocket) => void> = [];

    public constructor(_app: unknown, options: Record<string, unknown>) {
      this.options = options;
      recorded.push(this);
    }

    public on(_event: "new", handler: (socket: VecsSocket) => void): this {
      this._handlers.push(handler);
      return this;
    }

    public connect(socket: VecsSocket): void {
      this._handlers.forEach((handler) => handler(socket));
    }
  },
}));

class MemorySocket implements VecsSocket {
  public readonly sent: Uint8Array[] = [];
  public closed = false;
  private readonly _handlers = new Map<string, Array<(arg?: unknown) => void>>();

  public constructor(public readonly id: string) {}

  public on(event: "connect" | "disconnect" | "receive", handler: (arg?: unknown) => void): this {
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

function encode(message: Client2Server): Uint8Array {
  const encoder = new Encoder(new Uint8Array(64 * 1024));
  encoder.write(message);
  return encoder.getBuffer();
}

async function callRpc(socket: MemorySocket, world: ServerWorld): Promise<RPC> {
  socket.receive(
    encode(new Client2Server({ ackFrame: 0, rpc: [new RPC({ rpcId: 101, callId: 0 })] }))
  );
  await Promise.resolve();
  await Promise.resolve();
  world.progress(0, 16);
  const replies = socket.sent.flatMap((bytes) => new Decoder(bytes).read(Server2Client).rpc);
  const reply = replies.find((candidate) => candidate.callId === 0);
  if (!reply) {
    throw new Error(`no RPC reply for ${socket.id}`);
  }
  return reply;
}

describe("VecsListener", () => {
  beforeEach(() => {
    recorded.length = 0;
  });

  it("gives each named world under one listener its own RPC caller context", async () => {
    const alpha = new ServerWorld({ name: "alpha", networkComponents: [Position] });
    const beta = new ServerWorld({ name: "beta", networkComponents: [Position] });
    const seen: ServerRPCContext[] = [];
    const handler = (_params: unknown[], _request: RPC, ctx: ServerRPCContext) => {
      seen.push(ctx);
      return [ctx.world.name, ctx.connectionId, ctx.caller.get(NetworkClient)?.id];
    };
    alpha.handleRpc(101, handler);
    beta.handleRpc(101, handler);

    const listener = new VecsListener();
    listener.registerWorld(alpha);
    listener.registerWorld(beta);
    await listener.listen({});

    expect(recorded.map((entry) => entry.options.apiBasePath)).toEqual([
      "/rtc/v1/world/alpha",
      "/rtc/v1/world/beta",
    ]);

    const alphaSocket = new MemorySocket("alpha-client");
    const betaSocket = new MemorySocket("beta-client");
    recorded[0].connect(alphaSocket);
    recorded[1].connect(betaSocket);

    const alphaReply = await callRpc(alphaSocket, alpha);
    const betaReply = await callRpc(betaSocket, beta);

    expect(alphaReply.params).toEqual(["alpha", "alpha-client", "alpha-client"]);
    expect(betaReply.params).toEqual(["beta", "beta-client", "beta-client"]);
    expect(seen.map((ctx) => ctx.world)).toEqual([alpha, beta]);
    expect(seen[0].caller).not.toBe(seen[1].caller);
    expect(seen[0].caller.world).toBe(alpha);
    expect(seen[1].caller.world).toBe(beta);
    expect(alpha.getEntity(seen[0].caller.eid)?.get(NetworkClient)?.id).toBe("alpha-client");
    expect(beta.getEntity(seen[1].caller.eid)?.get(NetworkClient)?.id).toBe("beta-client");
  });

  it("closes sessions only on the world that owns them", async () => {
    const alpha = new ServerWorld({ name: "alpha", networkComponents: [Position] });
    const beta = new ServerWorld({ name: "beta", networkComponents: [Position] });
    alpha.handleRpc(101, (_params, _request, ctx) => [ctx.world.name]);

    const listener = new VecsListener();
    listener.registerWorld(alpha);
    listener.registerWorld(beta);
    await listener.listen({});

    const alphaSocket = new MemorySocket("alpha-client");
    const betaSocket = new MemorySocket("beta-client");
    recorded[0].connect(alphaSocket);
    recorded[1].connect(betaSocket);

    expect(beta.closeSession("alpha-client")).toBe(false);
    expect(alpha.closeSession("beta-client")).toBe(false);
    expect(alpha.closeSession("alpha-client")).toBe(true);
    // Scheduled, not immediate: `send` completes the close on the next tick.
    expect(alphaSocket.closed).toBe(false);
    alpha.progress(0, 16);
    expect(alphaSocket.closed).toBe(true);
    expect(betaSocket.closed).toBe(false);
    expect(beta.closeSession("beta-client")).toBe(true);
    beta.progress(0, 16);
    expect(betaSocket.closed).toBe(true);
  });
});
