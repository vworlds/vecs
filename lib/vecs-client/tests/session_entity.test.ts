import { describe, expect, it } from "vitest";
import {
  Client2Server,
  RPC,
  RPC_RESPONSE_ID,
  Server2Client,
  SESSION_ENTITY_RPC_ID,
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
    this.sent.push(data);
  }

  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }

  public close(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

function encodeMessage(message: IEncodable, size = 64 * 1024): Uint8Array {
  const encoder = new Encoder(new Uint8Array(size));
  encoder.write(message);
  return encoder.getBuffer();
}

describe("ClientWorld.sessionEntity", () => {
  it("resolves the session entity through the system RPC and caches the promise", async () => {
    const world = new ClientWorld({ networkComponents: [Position] });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);

    const promise = world.sessionEntity();
    expect(world.sessionEntity()).toBe(promise);

    world.send();
    const outgoing = new Decoder(socket.sent[0]).read(Client2Server);
    expect(outgoing.rpc).toHaveLength(1);
    expect(outgoing.rpc[0].rpcId).toBe(SESSION_ENTITY_RPC_ID);

    socket.receive(
      encodeMessage(
        new Server2Client({
          rpc: [
            new RPC({
              rpcId: RPC_RESPONSE_ID,
              callId: outgoing.rpc[0].callId,
              params: [1234],
            }),
          ],
        })
      )
    );
    world.progress(0, 0);

    const entity = await promise;
    expect(entity.eid).toBe(1234);
    expect(entity.alive).toBe(true);
    world.close();
  });

  it("rejects on a malformed session entity id", async () => {
    const world = new ClientWorld({ networkComponents: [Position] });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);

    const promise = world.sessionEntity();
    world.send();
    const outgoing = new Decoder(socket.sent[0]).read(Client2Server);
    socket.receive(
      encodeMessage(
        new Server2Client({
          rpc: [
            new RPC({
              rpcId: RPC_RESPONSE_ID,
              callId: outgoing.rpc[0].callId,
              params: ["not-an-eid"],
            }),
          ],
        })
      )
    );
    world.progress(0, 0);

    await expect(promise).rejects.toThrow(/Invalid session entity id/);
    world.close();
  });
});
