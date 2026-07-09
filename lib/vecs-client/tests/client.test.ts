import { describe, expect, it, vi } from "vitest";
import {
  ALL_COMPONENTS,
  Client2Server,
  ComponentSnapshot,
  EncodedSnapshot,
  Server2Client,
  StateDiff,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import type { EID } from "@vworlds/vecs";
import { ClientWorld, interpolatePosition, type ClientWorldOptions } from "../src/index.js";

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

function makeSnapshot(eid: EID, wireType: number, payload: Uint8Array): EncodedSnapshot {
  return new EncodedSnapshot(
    encodeMessage(new ComponentSnapshot({ eid, wireType, payload })),
    eid,
    wireType
  );
}

function posSnapshot(eid: EID, x: number, y: number): EncodedSnapshot {
  const p = new Position();
  p.x = x;
  p.y = y;
  return makeSnapshot(eid, 1, encodeComponent(p));
}

function createClientWorld(options: ClientWorldOptions = {}): ClientWorld {
  return new ClientWorld({
    networkComponents: [Position],
    interpolators: [[Position, interpolatePosition]],
    ...options,
  });
}

describe("ClientWorld", () => {
  it("applies server snapshots into the client world", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    const client = world;
    client.attachSocket(socket);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 0, toFrame: 1, snapshots: [posSnapshot(1000, 4, 8)] }),
        })
      )
    );

    client.apply(0);

    expect(world.entity(1000).get(Position)).toMatchObject({ x: 4, y: 8 });
  });

  it("applies repeated server snapshots for a new entity through the apply system", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(1085, 4, 8), posSnapshot(1085, 5, 9)],
          }),
        })
      )
    );

    expect(() => world.progress(0, 0)).not.toThrow();
    expect(world.entity(1085).get(Position)).toMatchObject({ x: 5, y: 9 });
  });

  it("keeps server entities after their last synchronized component is removed", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    world.component(LocalEffect);
    const entity = world.getOrCreateEntity(1000);
    entity.set(Position, { x: 1, y: 2 }).add(LocalEffect);
    const socket = new MemorySocket("server");
    const client = world;
    client.attachSocket(socket);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 2,
            removed: [[1000, 1]],
          }),
        })
      )
    );
    client.apply(0);

    expect(world.entity(1000)).toBe(entity);
    expect(entity.get(Position)).toBeUndefined();
    expect(entity.get(LocalEffect)).toBeDefined();
  });

  it("destroys server entities when the destruction component is removed", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    world.component(LocalEffect);
    const entity = world.getOrCreateEntity(1000);
    entity.set(Position, { x: 1, y: 2 }).add(LocalEffect);
    const socket = new MemorySocket("server");
    const client = world;
    client.attachSocket(socket);
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 2,
            removed: [[1000, ALL_COMPONENTS]],
          }),
        })
      )
    );
    client.apply(0);

    expect(() => world.entity(1000)).toThrow();
  });

  it("applies compressed create-then-remove diffs without materializing the entity", () => {
    const world = createClientWorld({ interpolatorBucketLength: 2, serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    const client = world;
    client.attachSocket(socket);
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 0,
            snapshots: [posSnapshot(1012, 1, 2)],
          }),
        })
      )
    );
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 1,
            removed: [[1012, 1]],
          }),
        })
      )
    );
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 1,
            toFrame: 2,
          }),
        })
      )
    );

    expect(() => client.apply(0)).not.toThrow();
    expect(world.getEntity(1012)).toBeUndefined();
  });

  it("recreates server-owned ids immediately when the server reuses them", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const entity = world.getOrCreateEntity(1000);
    entity.set(Position, { x: 1, y: 2 });
    const socket = new MemorySocket("server");
    const client = world;
    client.attachSocket(socket);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 1,
            removed: [[1000, ALL_COMPONENTS]],
          }),
        })
      )
    );
    client.apply(0);
    expect(() => world.entity(1000)).toThrow();

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 1, toFrame: 2, snapshots: [posSnapshot(1000, 9, 9)] }),
        })
      )
    );
    client.apply(10);

    expect(world.entity(1000).get(Position)).toMatchObject({ x: 9, y: 9 });
  });

  it("acks the highest accepted server frame", () => {
    const client = new ClientWorld();
    const socket = new MemorySocket("server");
    client.attachSocket(socket);

    socket.receive(
      encodeMessage(new Server2Client({ diff: new StateDiff({ fromFrame: 0, toFrame: 9 }) }))
    );
    client.send();

    expect(new Decoder(socket.sent[0]).read(Client2Server).ackFrame).toBe(9);
  });

  it("sends acks on an internal interval instead of progress", () => {
    vi.useFakeTimers();
    try {
      const client = new ClientWorld({ ackIntervalMs: 10 });
      const socket = new MemorySocket("server");
      client.attachSocket(socket);

      expect(socket.sent).toHaveLength(0);
      vi.advanceTimersByTime(30);

      expect(socket.sent.length).toBeGreaterThanOrEqual(3);
      client.close();
      const sentAfterClose = socket.sent.length;
      vi.advanceTimersByTime(30);
      expect(socket.sent).toHaveLength(sentAfterClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not install progress-driven sending", () => {
    const client = new ClientWorld();
    const socket = new MemorySocket("server");
    client.attachSocket(socket);

    client.progress(0, 16);

    expect(socket.sent).toHaveLength(0);
    client.close();
  });

  it("emits reset events so applications can clean up on full baselines", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    world.component(LocalEffect);
    const socket = new MemorySocket("server");
    const client = world;
    client.attachSocket(socket);
    const resets: Array<{ initial: boolean; fromFrame: number; toFrame: number }> = [];
    client.events.on("reset", (event) => {
      resets.push(event);
      if (!event.initial) {
        world.getEntity(1001)?.destroy();
      }
    });

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(1000, 1, 1), posSnapshot(1001, 2, 2)],
          }),
        })
      )
    );
    client.apply(0);
    const local = world.entity().add(LocalEffect);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 1,
            toFrame: 2,
            snapshots: [posSnapshot(1000, 3, 3)],
          }),
        })
      )
    );

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({
            fromFrame: 0,
            toFrame: 3,
            snapshots: [posSnapshot(1000, 9, 9)],
          }),
        })
      )
    );
    client.apply(10);

    expect(resets).toEqual([
      { initial: true, fromFrame: 0, toFrame: 1 },
      { initial: false, fromFrame: 0, toFrame: 3 },
    ]);
    expect(world.entity(1000).get(Position)).toMatchObject({ x: 9, y: 9 });
    expect(world.getEntity(1001)).toBeUndefined();
    expect(world.getEntity(local.eid)).toBe(local);
    expect(local.get(LocalEffect)).toBeDefined();
    client.close();
  });

  it("emits reset after reconnect even when the new baseline frame is lower", () => {
    const client = createClientWorld({ serverTickIntervalMs: 10 });
    const firstSocket = new MemorySocket("server-1");
    const resets: Array<{ initial: boolean; toFrame: number }> = [];
    client.events.on("reset", (event) =>
      resets.push({ initial: event.initial, toFrame: event.toFrame })
    );
    client.attachSocket(firstSocket);

    firstSocket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 0, toFrame: 9, snapshots: [posSnapshot(1000, 1, 1)] }),
        })
      )
    );
    client.apply(0);
    firstSocket.close();

    const secondSocket = new MemorySocket("server-2");
    client.attachSocket(secondSocket);
    secondSocket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 0, toFrame: 1, snapshots: [posSnapshot(1000, 2, 2)] }),
        })
      )
    );
    client.apply(10);

    expect(resets).toEqual([
      { initial: true, toFrame: 9 },
      { initial: false, toFrame: 1 },
    ]);
    expect(client.entity(1000).get(Position)).toMatchObject({ x: 2, y: 2 });
    client.close();
  });

  it("notifies when the socket disconnects", () => {
    const client = new ClientWorld();
    const socket = new MemorySocket("server");
    client.attachSocket(socket);
    let disconnected = false;

    client.events.on("disconnect", () => {
      disconnected = true;
    });
    socket.close();

    expect(disconnected).toBe(true);
  });

  it("applies out-of-order diffs in server frame order", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    const client = world;
    client.attachSocket(socket);

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
          diff: new StateDiff({ fromFrame: 1, toFrame: 3, snapshots: [posSnapshot(7, 3, 3)] }),
        })
      )
    );
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff({ fromFrame: 1, toFrame: 2, snapshots: [posSnapshot(7, 2, 2)] }),
        })
      )
    );

    client.apply(0);
    expect(world.entity(7).get(Position)).toMatchObject({ x: 1, y: 1 });

    client.apply(10);
    expect(world.entity(7).get(Position)).toMatchObject({ x: 2, y: 2 });

    client.apply(20);
    expect(world.entity(7).get(Position)).toMatchObject({ x: 3, y: 3 });
  });

  it("applies interpolated position frames between server ticks", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    const client = world;
    client.attachSocket(socket);

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

    expect(world.entity(7).get(Position)).toMatchObject({ x: 5, y: 10 });
  });

  it("drops diffs whose frames have already left the bucket window", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    const client = world;
    client.attachSocket(socket);

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
    expect(world.entity(7).get(Position)).toMatchObject({ x: 50, y: 50 });
  });

  it("merges retransmitted diffs without applying them twice", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    const client = world;
    client.attachSocket(socket);

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

    expect(world.entity(7).get(Position)).toMatchObject({ x: 7, y: 7 });
    client.send();
    expect(new Decoder(socket.sent[0]).read(Client2Server).ackFrame).toBe(1);
  });
});
