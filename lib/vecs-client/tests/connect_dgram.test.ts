import { afterEach, describe, expect, it, vi } from "vitest";
import { Client2Server, type VecsSocket } from "@vworlds/vecs-protocol";
import { Decoder } from "@vworlds/vecs-wire";
import { ClientWorld } from "../src/index.js";

type SocketHandler = (arg?: unknown) => void;

const sockets: ConnectGatedSocket[] = [];
let connectFailure: Error | undefined;

/** Mimics dgram 1.0.10: `send` rejects until `connect()` has resolved. */
class ConnectGatedSocket implements VecsSocket {
  public readonly id = "gated";
  public readonly sent: Uint8Array[] = [];
  public closeCalls = 0;
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
});
