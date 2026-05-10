import { describe, expect, it } from "vitest";
import { type VecsSocket } from "@vworlds/vecs-protocol";
import { Decoder, Encoder, type as wireType } from "@vworlds/vecs-wire";
import { World } from "@vworlds/vecs";
import {
  Client2Server,
  ComponentSnapshot,
  RemovedComponent,
  Server2Client,
  StateDiff,
  encodeMessage,
} from "@vworlds/vecs-protocol";
import { VecsClient } from "../src/index.js";

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

class LocalEffect {
  public value = 0;
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

function encodeComponent(component: object): Uint8Array {
  const encoder = new Encoder(new Uint8Array(1024));
  encoder.write(component);
  return encoder.getBuffer();
}

describe("VecsClient", () => {
  it("applies server snapshots into the client world", () => {
    const world = new World();
    world.setEntityIdRange(1000);
    world.registerComponent(Position, 1);
    const socket = new MemorySocket("server");
    const client = new VecsClient({ world, socket });
    client.registerComponent(Position);

    const position = new Position();
    position.x = 4;
    position.y = 8;
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            toFrame: 1,
            snapshots: [
              encodeMessage(
                new ComponentSnapshot({ eid: 7, type: 1, payload: encodeComponent(position) })
              ),
            ],
          }),
        })
      )
    );

    client.apply();

    expect(world.entity(7)?.get(Position)).toMatchObject({ x: 4, y: 8 });
  });

  it("destroys server entities after their last synchronized component is removed", () => {
    const world = new World();
    world.setEntityIdRange(1000);
    world.registerComponent(Position, 1);
    world.registerComponent(LocalEffect);
    const entity = world.getOrCreateEntity(7);
    entity.set(Position, { x: 1, y: 2 }).add(LocalEffect);
    const socket = new MemorySocket("server");
    const client = new VecsClient({ world, socket });
    client.registerComponent(Position);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ toFrame: 2, removed: [new RemovedComponent({ eid: 7, type: 1 })] }),
        })
      )
    );
    client.apply();

    expect(world.entity(7)).toBeUndefined();
  });

  it("sends ack frames even without input", () => {
    const world = new World();
    const socket = new MemorySocket("server");
    const client = new VecsClient({ world, socket });

    socket.receive(encodeMessage(new Server2Client({ diff: new StateDiff({ toFrame: 9 }) })));
    client.send();

    expect(new Decoder(socket.sent[0]).read(Client2Server).ackFrame).toBe(9);
  });
});
