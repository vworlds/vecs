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

const connectOptions = { host: "localhost", port: 1, worldName: "w" };
const worldOptions = { ackIntervalMs: 5 };

afterEach(() => {
  sockets.length = 0;
  connectFailure = undefined;
});

describe("ClientWorld.connectDgram", () => {
  it("does not disconnect on acks that would precede the data channel", async () => {
    const world = new ClientWorld(worldOptions);
    await world.connectDgram(connectOptions);
    const onDisconnect = vi.fn();
    world.events.on("disconnect", onDisconnect);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(sockets[0]!.rejectedSends).toBe(0);
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(sockets[0]!.sent.length).toBeGreaterThan(0);
    world.dispose();
  });

  it("sends acks after connect and lets invoke reach the server", async () => {
    const world = new ClientWorld(worldOptions);
    await world.connectDgram(connectOptions);
    void world.invoke(101).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 40));

    const frames = sockets[0]!.sent.map((data) => new Decoder(data).read(Client2Server));
    expect(frames.some((frame) => frame.rpc.length > 0)).toBe(true);
    world.dispose();
  });

  it("closes the socket and leaves the world unattached and undisposed when connect fails", async () => {
    connectFailure = new Error("connect failed");
    const world = new ClientWorld(worldOptions);

    await expect(world.connectDgram(connectOptions)).rejects.toThrow("connect failed");
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(sockets[0]!.rejectedSends).toBe(0);
    expect(sockets[0]!.closeCalls).toBe(1);
    expect(world.connected).toBe(false);
    expect(world.disposed).toBe(false);
    world.dispose();
  });

  it("sends nothing while connecting a world whose modules were installed first", async () => {
    class Game extends Module {
      public init(): void {}
    }
    const world = new ClientWorld(worldOptions);
    const game = world.module(Game);

    const pending = world.connectDgram(connectOptions);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets[0]!.connectCalls).toBe(1);
    expect(sockets[0]!.sent).toEqual([]);
    expect(sockets[0]!.rejectedSends).toBe(0);
    expect(world.connected).toBe(false);

    await pending;
    expect(world.connected).toBe(true);
    expect(world.module(Game)).toBe(game);
    world.dispose();
  });

  it("rejects with the abort reason and leaves the world usable when aborted during connect()", async () => {
    const controller = new AbortController();
    const reason = new Error("left the lobby");
    const removed: string[] = [];
    class Game extends Module {
      public init(): void {
        this.entity.on("remove", () => removed.push("Game"));
      }
    }
    const world = new ClientWorld(worldOptions);
    world.module(Game);

    const pending = world.connectDgram({ ...connectOptions, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets[0]!.connectCalls).toBe(1);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(sockets[0]!.closeCalls).toBe(1);
    expect(world.disposed).toBe(false);
    expect(world.connected).toBe(false);
    expect(removed).toEqual([]);
    // connect() resolving later attaches nothing and sends nothing.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sockets[0]!.sent).toEqual([]);
    expect(sockets[0]!.rejectedSends).toBe(0);

    await world.connectDgram(connectOptions);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.connected).toBe(true);
    expect(sockets[1]!.sent.length).toBeGreaterThan(0);
    expect(sockets[1]!.rejectedSends).toBe(0);
    world.dispose();
    expect(removed).toEqual(["Game"]);
  });

  it("rejects without creating a socket when the signal is already aborted", async () => {
    const reason = new Error("cancelled");
    const world = new ClientWorld(worldOptions);

    await expect(
      world.connectDgram({ ...connectOptions, signal: AbortSignal.abort(reason) })
    ).rejects.toBe(reason);

    expect(sockets).toEqual([]);
    expect(world.disposed).toBe(false);
    world.dispose();
  });

  it("does not miss an abort raised synchronously while connect starts", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during transport startup");
    const connect = vi.spyOn(ConnectGatedSocket.prototype, "connect").mockImplementationOnce(() => {
      controller.abort(reason);
      return new Promise<void>(() => undefined);
    });
    const world = new ClientWorld(worldOptions);
    let outcome: unknown = "pending";
    const pending = world.connectDgram({ ...connectOptions, signal: controller.signal }).then(
      () => {
        outcome = "connected";
      },
      (error: unknown) => {
        outcome = error;
      }
    );
    try {
      await vi.waitFor(() => expect(outcome).toBe(reason), { timeout: 1000 });
      await pending;
      expect(sockets[0]!.closeCalls).toBe(1);
      expect(world.connected).toBe(false);
      expect(world.disposed).toBe(false);
      await world.connectDgram(connectOptions);
      expect(world.connected).toBe(true);
    } finally {
      connect.mockRestore();
      world.dispose();
    }
  });

  it("rejects without creating a socket while connected or connecting", async () => {
    const world = new ClientWorld(worldOptions);
    const pending = world.connectDgram(connectOptions);

    await expect(world.connectDgram(connectOptions)).rejects.toThrow("call close() first");
    await pending;
    await expect(world.connectDgram(connectOptions)).rejects.toThrow("call close() first");

    expect(sockets).toHaveLength(1);
    expect(world.connected).toBe(true);
    world.dispose();
  });

  it("rejects without creating a socket on a disposed world", async () => {
    const world = new ClientWorld(worldOptions);
    world.dispose();

    await expect(world.connectDgram(connectOptions)).rejects.toThrow("ClientWorld is disposed");
    expect(sockets).toEqual([]);
  });

  it("reconnects the same world after close()", async () => {
    const world = new ClientWorld(worldOptions);
    await world.connectDgram(connectOptions);
    world.close();
    expect(world.connected).toBe(false);
    expect(sockets[0]!.closeCalls).toBe(1);

    await world.connectDgram({ ...connectOptions, worldName: "next" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(world.connected).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.sent.length).toBeGreaterThan(0);
    world.dispose();
  });

  it("ignores an abort after the connection is established", async () => {
    const controller = new AbortController();
    const world = new ClientWorld(worldOptions);
    await world.connectDgram({ ...connectOptions, signal: controller.signal });

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
    const world = new ClientWorld(worldOptions);
    world.attachSocket(socket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(world.connected).toBe(true);
    expect(sockets[0]!.sent.length).toBeGreaterThan(0);
    expect(sockets[0]!.rejectedSends).toBe(0);
    world.dispose();
  });
});
