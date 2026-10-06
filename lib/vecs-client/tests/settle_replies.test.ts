import { describe, expect, it, vi } from "vitest";
import {
  Client2Server,
  RPC,
  RPC_CLOSED_CODE,
  RPC_RESPONSE_ID,
  RPCError,
  Server2Client,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { ClientWorld } from "../src/index.js";

const CALL_RPC = 101;
const SERVER_RPC = 202;
const WRONG_WORLD = 4001;

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  public readonly sent: Uint8Array[] = [];
  public closeCalls = 0;
  public sendImpl: (data: Uint8Array) => unknown = () => undefined;
  private readonly _handlers = new Map<string, SocketHandler[]>();

  public constructor(public readonly id: string) {}

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public send(data: Uint8Array): void {
    // ClientWorld encodes every frame into one reused buffer, so keep a copy.
    this.sent.push(data.slice());
    return this.sendImpl(data) as void;
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

function frame(...rpc: RPC[]): Uint8Array {
  const encoder = new Encoder(new Uint8Array(4096));
  encoder.write(new Server2Client({ rpc }));
  return encoder.getBuffer();
}

const errorReply = (callId: number) =>
  new RPC({ rpcId: RPC_RESPONSE_ID, callId, error: WRONG_WORLD, message: "wrong world" });
const successReply = (callId: number, ...params: unknown[]) =>
  new RPC({ rpcId: RPC_RESPONSE_ID, callId, params });

type Route = {
  name: string;
  disconnect: (client: ClientWorld, socket: MemorySocket) => void;
};

const routes: Route[] = [
  { name: "peer disconnect event", disconnect: (_c, socket) => socket.disconnect() },
  {
    name: "synchronous send throw",
    disconnect: (client, socket) => {
      socket.sendImpl = () => {
        throw new Error("peer closed");
      };
      client.send();
    },
  },
  {
    name: "rejected send",
    disconnect: (client, socket) => {
      socket.sendImpl = () => Promise.reject(new Error("peer closed"));
      client.send();
    },
  },
  { name: "close()", disconnect: (client) => client.close() },
];

function setup() {
  const client = new ClientWorld({ ackIntervalMs: 1_000_000 });
  const socket = new MemorySocket("server");
  client.attachSocket(socket);
  return { client, socket };
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

// Observe a call immediately, so a rejection is never left unhandled while the test waits.
const outcomeOf = (call: Promise<unknown>): Promise<Outcome> =>
  call.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error })
  );

// Records how a call settles, so a test can assert it already has instead of waiting on it.
function observe(call: Promise<unknown>): { outcome?: Outcome } {
  const seen: { outcome?: Outcome } = {};
  void outcomeOf(call).then((outcome) => {
    seen.outcome = outcome;
  });
  return seen;
}

// The `rpc` list of every frame the client sent, oldest first.
const sentRpc = (socket: MemorySocket): RPC[][] =>
  socket.sent.map((data) => new Decoder(data).read(Client2Server).rpc);

// A rejected send reaches _handleDisconnect on a microtask.
const settleMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// No test in this block calls apply() or progress(): nothing ever applies the world.
describe("replies settle on receipt", () => {
  it("resolves a call with the reply's params when the reply frame arrives", async () => {
    const { client, socket } = setup();
    const call = observe(client.invoke(CALL_RPC, ["hello"]));

    socket.receive(frame(successReply(0, "ok", 7)));
    await settleMicrotasks();

    expect(call.outcome).toEqual({ ok: true, value: ["ok", 7] });
  });

  it("rejects a call with the server's typed error when the reply frame arrives", async () => {
    const { client, socket } = setup();
    const call = observe(client.invoke(CALL_RPC));

    socket.receive(frame(errorReply(0)));
    await settleMicrotasks();

    expect(call.outcome).toMatchObject({ ok: false, error: { code: WRONG_WORLD } });
    expect((call.outcome as { error: unknown }).error).toBeInstanceOf(RPCError);
  });

  it("stops resending the request once its reply has arrived", () => {
    const { client, socket } = setup();
    observe(client.invoke(CALL_RPC, ["hello"]));

    client.send();
    client.send();
    socket.receive(frame(successReply(0, "ok")));
    client.send();

    const [first, second, afterReply] = sentRpc(socket);
    // Until its reply arrives, every ack carries the request again.
    expect(first).toMatchObject([{ rpcId: CALL_RPC, callId: 0, params: ["hello"] }]);
    expect(second).toMatchObject([{ rpcId: CALL_RPC, callId: 0, params: ["hello"] }]);
    expect(afterReply).toEqual([]);
  });
});

// Replies settle on receipt, but the handlers of server-to-client requests keep running
// from apply(), so they stay in the world's phase order.
describe("server requests wait for apply()", () => {
  it("settles a reply at once and keeps the request that shares its frame queued", async () => {
    const { client, socket } = setup();
    const handler = vi.fn();
    client.listen(SERVER_RPC, handler);
    const call = observe(client.invoke(CALL_RPC));

    socket.receive(frame(new RPC({ rpcId: SERVER_RPC, callId: 5 }), successReply(0, "ok")));
    await settleMicrotasks();

    expect(call.outcome).toEqual({ ok: true, value: ["ok"] });
    expect(handler).not.toHaveBeenCalled();
    client.apply(0);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("runs the handler on apply(), then answers on the next send()", async () => {
    const { client, socket } = setup();
    const handler = vi.fn(() => ["pong"]);
    client.listen(SERVER_RPC, handler);

    socket.receive(frame(new RPC({ rpcId: SERVER_RPC, callId: 5, params: ["ping"] })));
    await settleMicrotasks();
    client.send();

    expect(handler).not.toHaveBeenCalled();

    client.apply(0);
    await settleMicrotasks();
    client.send();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      ["ping"],
      expect.objectContaining({ callId: 5 }),
      undefined
    );
    const [beforeApply, afterApply] = sentRpc(socket);
    expect(beforeApply).toEqual([]);
    expect(afterApply).toMatchObject([
      { rpcId: RPC_RESPONSE_ID, callId: 5, params: ["pong"], error: 0 },
    ]);
  });
});

describe.each(routes)("replies received before disconnect via $name", ({ disconnect }) => {
  it("rejects with the server's typed error, not RPC_CLOSED_CODE", async () => {
    const { client, socket } = setup();
    const outcome = outcomeOf(client.invoke(CALL_RPC));

    socket.receive(frame(errorReply(0)));
    disconnect(client, socket);
    await settleMicrotasks();

    const result = await outcome;
    expect(result.ok).toBe(false);
    const error = (result as { error: unknown }).error;
    expect(error).toBeInstanceOf(RPCError);
    expect(error).toMatchObject({ code: WRONG_WORLD, message: "wrong world" });
  });

  it("resolves with the reply params for a success reply", async () => {
    const { client, socket } = setup();
    const pending = outcomeOf(client.invoke(CALL_RPC));

    socket.receive(frame(successReply(0, "ok", 7)));
    disconnect(client, socket);
    await settleMicrotasks();

    await expect(pending).resolves.toEqual({ ok: true, value: ["ok", 7] });
  });

  it("settles only the answered call and rejects the other with RPC_CLOSED_CODE", async () => {
    const { client, socket } = setup();
    const answered = outcomeOf(client.invoke(CALL_RPC));
    const unanswered = outcomeOf(client.invoke(CALL_RPC));

    socket.receive(frame(errorReply(0)));
    disconnect(client, socket);
    await settleMicrotasks();

    await expect(answered).resolves.toMatchObject({ ok: false, error: { code: WRONG_WORLD } });
    await expect(unanswered).resolves.toMatchObject({
      ok: false,
      error: { code: RPC_CLOSED_CODE },
    });
  });

  it("rejects a call with no reply with RPC_CLOSED_CODE, once", async () => {
    const { client, socket } = setup();
    const onDisconnect = vi.fn();
    client.events.on("disconnect", onDisconnect);
    const pending = outcomeOf(client.invoke(CALL_RPC));

    disconnect(client, socket);
    await settleMicrotasks();

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: RPC_CLOSED_CODE } });
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("does not run a server request left in the inbox, now or after a later attachSocket", async () => {
    const { client, socket } = setup();
    const handler = vi.fn();
    client.listen(SERVER_RPC, handler);
    const pending = outcomeOf(client.invoke(CALL_RPC));

    socket.receive(frame(new RPC({ rpcId: SERVER_RPC, callId: 5 }), successReply(0)));
    disconnect(client, socket);
    await settleMicrotasks();
    await expect(pending).resolves.toEqual({ ok: true, value: [] });
    client.apply(0);
    expect(handler).not.toHaveBeenCalled();

    client.attachSocket(new MemorySocket("replacement"));
    client.apply(1);
    await settleMicrotasks();
    expect(handler).not.toHaveBeenCalled();
  });

  it("settles replies before a disconnect listener can observe the disconnect", async () => {
    const { client, socket } = setup();
    const order: string[] = [];
    client.events.on("disconnect", () => {
      // The call is already settled here; its continuation runs as a microtask,
      // so a macrotask scheduled by the listener runs after it.
      setTimeout(() => order.push("listener-macrotask"), 0);
    });
    void client.invoke(CALL_RPC).catch(() => order.push("call-rejected"));

    socket.receive(frame(errorReply(0)));
    disconnect(client, socket);
    await settleMicrotasks();
    await settleMicrotasks();

    expect(order).toEqual(["call-rejected", "listener-macrotask"]);
  });
});

describe("dispose", () => {
  it("keeps a call a received reply already resolved and rejects the unanswered one", async () => {
    const { client, socket } = setup();
    const answered = observe(client.invoke(CALL_RPC));
    const unanswered = observe(client.invoke(CALL_RPC));

    socket.receive(frame(successReply(0, "ok")));
    client.dispose();
    await settleMicrotasks();

    expect(answered.outcome).toEqual({ ok: true, value: ["ok"] });
    expect(unanswered.outcome).toMatchObject({ ok: false, error: { code: RPC_CLOSED_CODE } });
  });

  it("drops a server request still queued for apply() without running it", () => {
    const { client, socket } = setup();
    const handler = vi.fn();
    client.listen(SERVER_RPC, handler);

    socket.receive(frame(new RPC({ rpcId: SERVER_RPC, callId: 5 })));
    client.dispose();
    client.apply(0);

    expect(handler).not.toHaveBeenCalled();
  });
});
