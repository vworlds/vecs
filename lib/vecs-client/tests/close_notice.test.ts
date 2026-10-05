import { describe, expect, it } from "vitest";
import { RPC_CLOSED_CODE, type VecsSocket, type VecsSocketListener } from "@vworlds/vecs-protocol";
import { NetworkClient, ServerWorld, View } from "@vworlds/vecs-server";
import { ClientWorld, type ClientWorldDisconnectEvent } from "../src/index.js";

// End to end: a real ServerWorld talking to a real ClientWorld over in-memory
// sockets. The server's graceful close (`closeSession`) must hand its code and
// reason to the client's `disconnect` event, behind any RPC reply it still owes.

const CLOSE_RPC = 101;
const SUPERSEDED = 4003;
const TICK_MS = 1000 / 30;

type SocketHandler = (arg?: unknown) => void;

/** One end of a paired in-memory connection; closing either end disconnects both. */
class Endpoint implements VecsSocket {
  public peer!: Endpoint;
  private readonly _handlers = new Map<string, SocketHandler[]>();
  private _closed = false;

  public constructor(public readonly id: string) {}

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public send(data: Uint8Array): void {
    this.peer._emit("receive", data);
  }

  public close(): void {
    if (this._closed) {
      return;
    }
    this._closed = true;
    this._emit("disconnect");
    this.peer.close();
  }

  private _emit(event: string, arg?: unknown): void {
    this._handlers.get(event)?.forEach((handler) => handler(arg));
  }
}

class Listener implements VecsSocketListener {
  private readonly _handlers: ((socket: VecsSocket) => void)[] = [];

  public on(event: "new", handler: (socket: VecsSocket) => void): this {
    if (event === "new") {
      this._handlers.push(handler);
    }
    return this;
  }

  public accept(socket: VecsSocket): void {
    this._handlers.forEach((handler) => handler(socket));
  }
}

interface Rig {
  server: ServerWorld;
  listener: Listener;
  client: ClientWorld;
  disconnects: Array<ClientWorldDisconnectEvent | undefined>;
  connect(id: string): Endpoint;
  tick(): void;
}

let nowMs = 0;

function createRig(onClose: (server: ServerWorld, connection: string) => void): Rig {
  const server = new ServerWorld({ name: "main", disconnectGraceMs: 1e9 });
  server.component(NetworkClient).on("set", (entity) => {
    entity.set(View, { dsl: true });
  });
  server.handleRpc(CLOSE_RPC, (_params, _request, ctx) => {
    onClose(server, ctx.connectionId);
    return ["bye"];
  });
  const listener = new Listener();
  server._attach(listener);
  const client = new ClientWorld({ serverTickIntervalMs: TICK_MS, ackIntervalMs: 1e9 });
  const disconnects: Rig["disconnects"] = [];
  client.events.on("disconnect", (event) => {
    disconnects.push(event);
  });
  const rig: Rig = {
    server,
    listener,
    client,
    disconnects,
    connect(id) {
      const clientEnd = new Endpoint("client");
      const serverEnd = new Endpoint(id);
      clientEnd.peer = serverEnd;
      serverEnd.peer = clientEnd;
      client.attachSocket(clientEnd);
      listener.accept(serverEnd);
      return clientEnd;
    },
    tick() {
      server.progress(nowMs, TICK_MS);
      nowMs += TICK_MS;
    },
  };
  return rig;
}

/** Let the server's async RPC handler finish and its reply reach the outbox. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("close notice delivery", () => {
  it("delivers the close code and reason to the disconnect payload", () => {
    const rig = createRig(() => undefined);
    rig.connect("client-1");
    rig.tick();

    expect(rig.server.closeSession("client-1", "superseded by client-2", SUPERSEDED)).toBe(true);
    rig.tick();

    expect(rig.disconnects).toEqual([{ code: SUPERSEDED, reason: "superseded by client-2" }]);
  });

  it("closes the server session once the client acks the close frame", () => {
    const rig = createRig(() => undefined);
    const socket = rig.connect("client-1");
    rig.tick();

    rig.server.closeSession("client-1", "maintenance", 4100);
    rig.tick();

    expect(rig.disconnects).toEqual([{ code: 4100, reason: "maintenance" }]);
    // The client's ack of the close frame lets the server finish on its next send.
    rig.tick();
    expect(rig.server.closeSession("client-1")).toBe(false);
    socket.close();
    expect(rig.disconnects).toHaveLength(1);
  });

  it("settles an owed RPC reply and then disconnects with the code", async () => {
    const rig = createRig((server, id) => {
      server.closeSession(id, "superseded", SUPERSEDED);
    });
    rig.connect("client-1");
    rig.tick();

    const outcome: string[] = [];
    const call = rig.client.invoke(CLOSE_RPC).then(
      (params) => outcome.push(`reply:${String(params[0])}`),
      (error: { code?: number }) => outcome.push(`rejected:${String(error.code)}`)
    );
    rig.client.send();
    await settle();
    rig.tick();
    await call;

    // The reply settles its call with the server's result rather than
    // RPC_CLOSED_CODE, and the disconnect still carries the code.
    expect(outcome).toEqual(["reply:bye"]);
    expect(outcome).not.toContain(`rejected:${RPC_CLOSED_CODE}`);
    expect(rig.disconnects).toEqual([{ code: SUPERSEDED, reason: "superseded" }]);
  });

  it("carries a code without a reason and a reason without a code", () => {
    const rig = createRig(() => undefined);
    rig.connect("client-1");
    rig.tick();
    rig.server.closeSession("client-1", undefined, SUPERSEDED);
    rig.tick();

    rig.connect("client-2");
    rig.tick();
    rig.server.closeSession("client-2", "just text");
    rig.tick();

    expect(rig.disconnects).toEqual([{ code: SUPERSEDED }, { reason: "just text" }]);
  });

  it("emits disconnect without a payload on transport loss", () => {
    const rig = createRig(() => undefined);
    const socket = rig.connect("client-1");
    rig.tick();

    socket.peer.close();

    expect(rig.disconnects).toEqual([undefined]);
  });

  it("emits disconnect without a payload for a failed send, close() and dispose()", () => {
    const failing = createRig(() => undefined);
    const socket = failing.connect("client-1");
    socket.send = () => {
      throw new Error("channel gone");
    };
    failing.client.send();
    expect(failing.disconnects).toEqual([undefined]);

    const closing = createRig(() => undefined);
    closing.connect("client-1");
    closing.client.close();
    expect(closing.disconnects).toEqual([undefined]);

    const disposing = createRig(() => undefined);
    disposing.connect("client-1");
    disposing.client.dispose();
    expect(disposing.disconnects).toEqual([]);
  });

  it("does not report a stale notice on a later transport loss", () => {
    const rig = createRig(() => undefined);
    rig.connect("client-1");
    rig.tick();
    rig.server.closeSession("client-1", "first", 4100);
    rig.tick();

    const second = rig.connect("client-2");
    rig.tick();
    second.peer.close();

    expect(rig.disconnects).toEqual([{ code: 4100, reason: "first" }, undefined]);
  });

  it("reconnects after a deliberate close", () => {
    const rig = createRig(() => undefined);
    rig.connect("client-1");
    rig.tick();
    rig.server.closeSession("client-1", "superseded", SUPERSEDED);
    rig.tick();
    expect(rig.disconnects).toHaveLength(1);

    rig.connect("client-2");
    rig.tick();
    rig.client.send();

    expect(rig.disconnects).toHaveLength(1);
    expect(rig.server.closeSession("client-2", "again", SUPERSEDED)).toBe(true);
    rig.tick();
    expect(rig.disconnects).toEqual([
      { code: SUPERSEDED, reason: "superseded" },
      { code: SUPERSEDED, reason: "again" },
    ]);
  });
});
