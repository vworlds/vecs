import { afterEach, describe, expect, it, vi } from "vitest";
import { Client2Server, type VecsSocket } from "@vworlds/vecs-protocol";
import { Decoder } from "@vworlds/vecs-wire";
import { Module } from "@vworlds/vecs";
import { ClientWorld, createDgramSocket } from "../src/index.js";

type SocketHandler = (arg?: unknown) => void;

const sockets: ConnectGatedSocket[] = [];
let connectFailure: Error | undefined;

/** Mimics dgram 1.0.10: `send` rejects until `connect()` has resolved. */
class ConnectGatedSocket implements VecsSocket {
  public readonly id = "gated";
  public readonly sent: Uint8Array[] = [];
  public closeCalls = 0;
  public connectCalls = 0;
  public rejectedSends = 0;
  private _connected = false;
  private readonly _handlers = new Map<string, SocketHandler[]>();

  public constructor() {
    sockets.push(this);
  }

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public async connect(): Promise<void> {
    this.connectCalls += 1;
    // Give any eagerly started ack timer a chance to fire before the channel opens.
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (connectFailure) {
      throw connectFailure;
    }
    this._connected = true;
  }

  public send(data: Uint8Array): Promise<void> {
    if (!this._connected) {
      this.rejectedSends += 1;
      return Promise.reject(new Error("DATA_CHANNEL_NOT_CREATED"));
    }
    this.sent.push(data);
    return Promise.resolve();
  }

  public close(): void {
    this.closeCalls += 1;
  }
}

vi.mock("@vworlds/dgram-client", () => ({ ClientSocket: ConnectGatedSocket }));

const connectOptions = { host: "localhost", port: 1, worldName: "w", ackIntervalMs: 5 };

afterEach(() => {
  sockets.length = 0;
  connectFailure = undefined;
});

describe("ClientWorld.connectDgram", () => {
  it("does not disconnect on acks that would precede the data channel", async () => {
    const world = await ClientWorld.connectDgram(connectOptions);
    const onDisconnect = vi.fn();
    world.events.on("disconnect", onDisconnect);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(sockets[0]!.rejectedSends).toBe(0);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(sockets[0]!.sent.length).toBeGreaterThan(0);
    world.dispose();
  });

  it("sends acks after connect and lets invoke reach the server", async () => {
    const world = await ClientWorld.connectDgram(connectOptions);
    void world.invoke(101).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 40));

    const frames = sockets[0]!.sent.map((data) => new Decoder(data).read(Client2Server));
    expect(frames.some((frame) => frame.rpc.length > 0)).toBe(true);
    world.dispose();
  });

  it("leaves no timer or half-attached world behind when connect fails", async () => {
    connectFailure = new Error("connect failed");

    await expect(ClientWorld.connectDgram(connectOptions)).rejects.toThrow("connect failed");
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(sockets[0]!.rejectedSends).toBe(0);
    expect(sockets[0]!.closeCalls).toBe(1);
  });

  it("runs setup on the unattached world before connect() is called", async () => {
    const seen: Array<{ connectCalls: number; connected: boolean; sent: number }> = [];
    class Game extends Module {
      public init(): void {
        const socket = sockets[0]!;
        seen.push({
          connectCalls: socket.connectCalls,
          connected: this.world instanceof ClientWorld && this.world.connected,
          sent: socket.sent.length + socket.rejectedSends,
        });
      }
    }
    let installed: Game | undefined;

    const world = await ClientWorld.connectDgram({
      ...connectOptions,
      setup: (client) => {
        installed = client.module(Game);
      },
    });

    expect(seen).toEqual([{ connectCalls: 0, connected: false, sent: 0 }]);
    expect(world.module(Game)).toBe(installed);
    expect(world.connected).toBe(true);
    expect(sockets[0]!.connectCalls).toBe(1);
    world.dispose();
  });

  it("disposes the world and closes the socket when setup throws", async () => {
    let created: ClientWorld | undefined;

    await expect(
      ClientWorld.connectDgram({
        ...connectOptions,
        setup: (client) => {
          created = client;
          throw new Error("setup failed");
        },
      })
    ).rejects.toThrow("setup failed");

    expect(created?.disposed).toBe(true);
    expect(sockets[0]!.connectCalls).toBe(0);
    expect(sockets[0]!.closeCalls).toBe(1);
  });

  it("rejects with the abort reason and releases everything when aborted during connect()", async () => {
    const controller = new AbortController();
    const reason = new Error("left the lobby");
    const disposed: string[] = [];
    class Game extends Module {
      public init(): void {}
      public override dispose(): void {
        disposed.push("Game");
      }
    }
    let created: ClientWorld | undefined;

    const pending = ClientWorld.connectDgram({
      ...connectOptions,
      signal: controller.signal,
      setup: (client) => {
        created = client;
        client.module(Game);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets[0]!.connectCalls).toBe(1);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(created?.disposed).toBe(true);
    expect(disposed).toEqual(["Game"]);
    expect(sockets[0]!.closeCalls).toBe(1);
    // connect() resolving later attaches nothing and sends nothing.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sockets[0]!.sent).toEqual([]);
    expect(sockets[0]!.rejectedSends).toBe(0);
  });

  it("rejects without creating a socket or world when the signal is already aborted", async () => {
    const reason = new Error("cancelled");
    const setup = vi.fn();

    await expect(
      ClientWorld.connectDgram({ ...connectOptions, signal: AbortSignal.abort(reason), setup })
    ).rejects.toBe(reason);

    expect(sockets).toEqual([]);
    expect(setup).not.toHaveBeenCalled();
  });

  it("does not call connect() when setup aborts the signal", async () => {
    const controller = new AbortController();
    let created: ClientWorld | undefined;

    await expect(
      ClientWorld.connectDgram({
        ...connectOptions,
        signal: controller.signal,
        setup: (client) => {
          created = client;
          controller.abort(new Error("aborted in setup"));
        },
      })
    ).rejects.toThrow("aborted in setup");

    expect(created?.disposed).toBe(true);
    expect(sockets[0]!.connectCalls).toBe(0);
    expect(sockets[0]!.closeCalls).toBe(1);
  });

  it("ignores an abort after the connection is established", async () => {
    const controller = new AbortController();
    const world = await ClientWorld.connectDgram({ ...connectOptions, signal: controller.signal });

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(world.connected).toBe(true);
    expect(world.disposed).toBe(false);
    expect(sockets[0]!.closeCalls).toBe(0);
    world.dispose();
  });
});

describe("createDgramSocket", () => {
  it("returns an unconnected socket that attachSocket accepts once connected", async () => {
    const socket = await createDgramSocket(connectOptions);
    expect(sockets).toEqual([socket]);
    expect(sockets[0]!.connectCalls).toBe(0);

    await socket.connect();
    const world = new ClientWorld({ ackIntervalMs: 5 });
    world.attachSocket(socket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(world.connected).toBe(true);
    expect(sockets[0]!.sent.length).toBeGreaterThan(0);
    expect(sockets[0]!.rejectedSends).toBe(0);
    world.dispose();
  });
});
