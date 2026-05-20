import { describe, expect, it } from "vitest";
import { ALL_COMPONENTS, type VecsSocket } from "@vworlds/vecs-protocol";
import { Decoder, Encoder, type IEncodable, type as wireType } from "@vworlds/vecs-wire";
import { World } from "@vworlds/vecs";
import {
  Client2Server,
  ComponentSnapshot,
  EncodedSnapshot,
  Server2Client,
  StateDiff,
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

function encodeMessage(message: IEncodable, size = 64 * 1024): Uint8Array {
  const encoder = new Encoder(new Uint8Array(size));
  encoder.write(message);
  return encoder.getBuffer();
}

function makeSnapshot(eid: number, type: number, payload: Uint8Array): EncodedSnapshot {
  return new EncodedSnapshot(
    encodeMessage(new ComponentSnapshot({ eid, type, payload })),
    eid,
    type
  );
}

function posSnapshot(eid: number, x: number, y: number): EncodedSnapshot {
  const p = new Position();
  p.x = x;
  p.y = y;
  return makeSnapshot(eid, 1, encodeComponent(p));
}

describe("VecsClient", () => {
  it("applies server snapshots into the client world", () => {
    const world = new World();
    world.setEntityIdRange(1000);
    world.registerComponent(Position, 1);
    const socket = new MemorySocket("server");
    const client = new VecsClient({ world, socket, serverTickIntervalMs: 10 });
    client.registerComponent(Position);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 0, toFrame: 1, snapshots: [posSnapshot(7, 4, 8)] }),
        })
      )
    );

    client.apply(0);

    expect(world.entity(7)?.get(Position)).toMatchObject({ x: 4, y: 8 });
  });

  it("keeps server entities after their last synchronized component is removed", () => {
    const world = new World();
    world.setEntityIdRange(1000);
    world.registerComponent(Position, 1);
    world.registerComponent(LocalEffect);
    const entity = world.getOrCreateEntity(7);
    entity.set(Position, { x: 1, y: 2 }).add(LocalEffect);
    const socket = new MemorySocket("server");
    const client = new VecsClient({ world, socket, serverTickIntervalMs: 10 });
    client.registerComponent(Position);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 2,
            removed: [[7, 1]],
          }),
        })
      )
    );
    client.apply(0);

    expect(world.entity(7)).toBe(entity);
    expect(entity.get(Position)).toBeUndefined();
    expect(entity.get(LocalEffect)).toBeDefined();
  });

  it("destroys server entities when the destruction component is removed", () => {
    const world = new World();
    world.setEntityIdRange(1000);
    world.registerComponent(Position, 1);
    world.registerComponent(LocalEffect);
    const entity = world.getOrCreateEntity(7);
    entity.set(Position, { x: 1, y: 2 }).add(LocalEffect);
    const socket = new MemorySocket("server");
    const client = new VecsClient({ world, socket, serverTickIntervalMs: 10 });
    client.registerComponent(Position);
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 2,
            removed: [[7, ALL_COMPONENTS]],
          }),
        })
      )
    );
    client.apply(0);

    expect(world.entity(7)).toBeUndefined();
  });

  it("acks the highest accepted server frame", () => {
    const world = new World();
    const socket = new MemorySocket("server");
    const client = new VecsClient({ world, socket });

    socket.receive(
      encodeMessage(new Server2Client({ diff: new StateDiff({ fromFrame: 0, toFrame: 9 }) }))
    );
    client.send();

    expect(new Decoder(socket.sent[0]).read(Client2Server).ackFrame).toBe(9);
  });

  it("applies out-of-order diffs in server frame order", () => {
    const world = new World();
    world.setEntityIdRange(1000);
    world.registerComponent(Position, 1);
    const socket = new MemorySocket("server");
    const client = new VecsClient({ world, socket, serverTickIntervalMs: 10 });
    client.registerComponent(Position);

    // First diff arrives first, but s3 arrives before s2.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 0, toFrame: 1, snapshots: [posSnapshot(7, 1, 1)] }),
        })
      )
    );
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 0, toFrame: 3, snapshots: [posSnapshot(7, 3, 3)] }),
        })
      )
    );
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 0, toFrame: 2, snapshots: [posSnapshot(7, 2, 2)] }),
        })
      )
    );

    client.apply(0);
    expect(world.entity(7)?.get(Position)).toMatchObject({ x: 1, y: 1 });

    client.apply(10);
    expect(world.entity(7)?.get(Position)).toMatchObject({ x: 2, y: 2 });

    client.apply(20);
    expect(world.entity(7)?.get(Position)).toMatchObject({ x: 3, y: 3 });
  });

  it("applies interpolated position frames between server ticks", () => {
    const world = new World();
    world.setEntityIdRange(1000);
    world.registerComponent(Position, 1);
    const socket = new MemorySocket("server");
    const client = new VecsClient({ world, socket, serverTickIntervalMs: 10 });
    client.registerComponent(Position);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 0, toFrame: 1, snapshots: [posSnapshot(7, 0, 0)] }),
        })
      )
    );
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 1, toFrame: 2, snapshots: [posSnapshot(7, 10, 20)] }),
        })
      )
    );

    client.apply(100);
    client.apply(105);

    expect(world.entity(7)?.get(Position)).toMatchObject({ x: 5, y: 10 });
  });

  it("drops diffs whose frames have already left the bucket window", () => {
    const world = new World();
    world.setEntityIdRange(1000);
    world.registerComponent(Position, 1);
    const socket = new MemorySocket("server");
    const client = new VecsClient({ world, socket, serverTickIntervalMs: 10 });
    client.registerComponent(Position);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 0, toFrame: 5, snapshots: [posSnapshot(7, 50, 50)] }),
        })
      )
    );
    // s1 is older than what the bucket can hold relative to frame 5; must be dropped.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 0, toFrame: 1, snapshots: [posSnapshot(7, 1, 1)] }),
        })
      )
    );

    client.apply(0);
    expect(world.entity(7)?.get(Position)).toMatchObject({ x: 50, y: 50 });
  });

  it("merges retransmitted diffs without applying them twice", () => {
    const world = new World();
    world.setEntityIdRange(1000);
    world.registerComponent(Position, 1);
    const socket = new MemorySocket("server");
    const client = new VecsClient({ world, socket, serverTickIntervalMs: 10 });
    client.registerComponent(Position);

    const diffBytes = encodeMessage(
      new Server2Client({
        diff: new StateDiff({ fromFrame: 0, toFrame: 1, snapshots: [posSnapshot(7, 7, 7)] }),
      })
    );

    socket.receive(diffBytes);
    // identical retransmit
    socket.receive(diffBytes);

    client.apply(0);
    // additional pulls should not move the world to anything else
    client.apply(10);
    client.apply(20);

    expect(world.entity(7)?.get(Position)).toMatchObject({ x: 7, y: 7 });
    client.send();
    expect(new Decoder(socket.sent[0]).read(Client2Server).ackFrame).toBe(1);
  });
});
