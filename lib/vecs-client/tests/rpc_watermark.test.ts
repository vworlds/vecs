import { describe, expect, it, vi } from "vitest";
import {
  Client2Server,
  RPC,
  RPC_RESPONSE_ID,
  Server2Client,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { ClientWorld } from "../src/index.js";

const CALL_RPC = 101;
const SERVER_RPC = 202;

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
    // ClientWorld encodes every frame into one reused buffer, so keep a copy.
    this.sent.push(data.slice());
  }

  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }

  public close(): void {
    this.disconnect();
  }

  public disconnect(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

/** A frame from the server: replies and requests plus, optionally, its own watermark. */
function serverFrame(frame: Partial<Server2Client>): Uint8Array {
  const encoder = new Encoder(new Uint8Array(4096));
  encoder.write(new Server2Client(frame));
  return encoder.getBuffer();
}

const serverRequest = (callId: number, ...params: unknown[]) =>
  new RPC({ rpcId: SERVER_RPC, callId, params });
const reply = (callId: number, ...params: unknown[]) =>
  new RPC({ rpcId: RPC_RESPONSE_ID, callId, params });

/** The frames the client sent, decoded, oldest first. */
const framesSent = (socket: MemorySocket): Client2Server[] =>
  socket.sent.map((data) => new Decoder(data).read(Client2Server));

// Handlers answer on a microtask, and a rejected call settles on one too.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  const client = new ClientWorld({ ackIntervalMs: 1_000_000 });
  const socket = new MemorySocket("server");
  client.attachSocket(socket);
  return { client, socket };
}

describe("ClientWorld sends its RPC watermark", () => {
  it("sends frames byte-identical to the old encoding while it has made no calls", () => {
    const { client, socket } = setup();

    client.send();
    client.send();

    // Just the ack frame number: no input, no requests and no watermark field.
    expect(socket.sent).toEqual([Uint8Array.of(0), Uint8Array.of(0)]);
    expect(framesSent(socket).map((frame) => frame.rpcSettledBelow)).toEqual([0, 0]);
  });

  it("holds the watermark at the lowest pending call, then advances it once the calls settle", async () => {
    const { client, socket } = setup();
    const first = client.invoke(CALL_RPC, ["first"]);
    const second = client.invoke(CALL_RPC, ["second"]);

    client.send();
    socket.receive(serverFrame({ rpc: [reply(1, "second reply")] })); // answered out of order
    client.send();
    socket.receive(serverFrame({ rpc: [reply(0, "first reply")] }));
    client.send();
    await settle();

    const [bothPending, firstPending, allSettled] = framesSent(socket);
    expect(bothPending.rpc.map((request) => request.callId)).toEqual([0, 1]);
    expect(bothPending.rpcSettledBelow).toBe(0);
    expect(firstPending.rpc.map((request) => request.callId)).toEqual([0]);
    expect(firstPending.rpcSettledBelow).toBe(0);
    expect(allSettled.rpc).toEqual([]);
    expect(allSettled.rpcSettledBelow).toBe(2);
    // Ack frame 0, then the watermark field: tag 5 and the value 2.
    expect(socket.sent[2]).toEqual(Uint8Array.of(0, 5, 2));
    await expect(first).resolves.toEqual(["first reply"]);
    await expect(second).resolves.toEqual(["second reply"]);
  });

  it("keeps sending the advanced watermark with every later frame", async () => {
    const { client, socket } = setup();
    const call = client.invoke(CALL_RPC);
    socket.receive(serverFrame({ rpc: [reply(0)] }));
    await call;

    client.send();
    client.send();

    expect(framesSent(socket).map((frame) => frame.rpcSettledBelow)).toEqual([1, 1]);
  });
});

describe("ClientWorld runs a server request once", () => {
  it("runs the handler once for copies that arrive between two apply() calls", async () => {
    const { client, socket } = setup();
    const handler = vi.fn(() => ["pong"]);
    client.listen(SERVER_RPC, handler);

    // The server re-sends its pending request with every frame until it is answered.
    for (let copy = 0; copy < 3; copy++) {
      socket.receive(serverFrame({ rpc: [serverRequest(5, "ping")] }));
    }
    client.apply(0);
    await settle();
    client.send();

    expect(handler).toHaveBeenCalledOnce();
    expect(framesSent(socket)[0].rpc).toMatchObject([
      { rpcId: RPC_RESPONSE_ID, callId: 5, params: ["pong"] },
    ]);
  });

  it("ignores a server request below the server's watermark", async () => {
    const { client, socket } = setup();
    const handler = vi.fn(() => ["pong"]);
    client.listen(SERVER_RPC, handler);

    socket.receive(
      serverFrame({ rpcSettledBelow: 10, rpc: [serverRequest(3), serverRequest(10)] })
    );
    client.apply(0);
    await settle();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith([], expect.objectContaining({ callId: 10 }), undefined);
  });
});

describe("ClientWorld after a disconnect and a re-attach", () => {
  it("processes a low call id from the new server session instead of treating it as stale", async () => {
    const { client, socket: first } = setup();
    const handler = vi.fn((params: unknown[]) => [`handled ${String(params[0])}`]);
    client.listen(SERVER_RPC, handler);

    // The first server session settled its calls 0 to 9, so its watermark is 10.
    first.receive(serverFrame({ rpcSettledBelow: 10, rpc: [serverRequest(3, "stale")] }));
    client.apply(0);
    expect(handler).not.toHaveBeenCalled();

    first.disconnect();
    const second = new MemorySocket("replacement");
    client.attachSocket(second);
    // A new server session numbers its calls from 0 again.
    second.receive(serverFrame({ rpc: [serverRequest(3, "fresh")] }));
    client.apply(1);
    await settle();
    client.send();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      ["fresh"],
      expect.objectContaining({ callId: 3 }),
      undefined
    );
    expect(framesSent(second)[0].rpc).toMatchObject([
      { rpcId: RPC_RESPONSE_ID, callId: 3, params: ["handled fresh"] },
    ]);
  });

  it("does not answer a reused call id with the previous server session's cached reply", async () => {
    const { client, socket: first } = setup();
    const handler = vi.fn((params: unknown[]) => [`handled ${String(params[0])}`]);
    client.listen(SERVER_RPC, handler);
    first.receive(serverFrame({ rpc: [serverRequest(3, "first session")] }));
    client.apply(0);
    await settle();

    first.disconnect();
    const second = new MemorySocket("replacement");
    client.attachSocket(second);
    second.receive(serverFrame({ rpc: [serverRequest(3, "second session")] }));
    client.apply(1);
    await settle();
    client.send();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(framesSent(second)[0].rpc).toMatchObject([
      { rpcId: RPC_RESPONSE_ID, callId: 3, params: ["handled second session"] },
    ]);
  });
});
