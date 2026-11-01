import { CidLayout } from "@vworlds/vecs-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  Client2Server,
  ComponentSnapshot,
  EncodedSnapshot,
  RPC_CLOSED_CODE,
  Server2Client,
  StateDiff,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import type { EID } from "@vworlds/vecs";
import { ClientWorld, interpolatePosition, type ClientWorldOptions } from "../src/index.js";

const testCid = new CidLayout(2);

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

class LocalEffect {
  public value = 0;
}

/** A client-local render resource, released by its component's `remove` hook. */
class LocalResource {
  public released = false;
}

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  public readonly sent: Uint8Array[] = [];
  public closeCalls = 0;
  public closed = false;
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
    this.closeCalls += 1;
    this.closed = true;
    this.disconnect();
  }

  public disconnect(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

class ThrowingSocket extends MemorySocket {
  public sendCalls = 0;

  public override send(_data: Uint8Array): void {
    this.sendCalls += 1;
    throw new Error("peer closed");
  }
}

class RejectingSocket extends MemorySocket {
  public sendCalls = 0;

  public override send(_data: Uint8Array): void {
    this.sendCalls += 1;
    return Promise.reject(new Error("peer closed")) as never;
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
    encodeMessage(new ComponentSnapshot(testCid, { eid, wireType, payload })),
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

/** The ids of every entity in `world`, sorted. */
function entityIds(world: ClientWorld): EID[] {
  return world.entities
    .values()
    .map((entity) => entity.eid)
    .sort((a, b) => a - b);
}

describe("ClientWorld", () => {
  it("emits connect synchronously once per attachment and exposes connection/disposal state", () => {
    const world = createClientWorld();
    const first = new MemorySocket("first");
    const second = new MemorySocket("second");
    const events: boolean[] = [];
    world.events.on("connect", () => events.push(world.connected));
    expect(world.connected).toBe(false);
    expect(world.disposed).toBe(false);
    world.attachSocket(first);
    expect(events).toEqual([true]);
    world.progress(0, 16);
    world.apply(16);
    expect(events).toEqual([true]);
    first.disconnect();
    expect(world.connected).toBe(false);
    world.attachSocket(second);
    first.disconnect();
    expect(world.connected).toBe(true);
    expect(events).toEqual([true, true]);
    world.dispose();
    expect(world.connected).toBe(false);
    expect(world.disposed).toBe(true);
    expect(() => world.attachSocket(first)).toThrow("disposed");
    expect(events).toEqual([true, true]);
  });

  it.each([201, "client/inspect"])(
    "unlisten removes only the same handler reference for %s",
    (key) => {
      const world = createClientWorld();
      const old = () => "old";
      const replacement = () => "new";
      world.listen(key, old);
      world.listen(key, replacement);
      expect(world.unlisten(key, old)).toBe(false);
      expect(world.unlisten(key, replacement)).toBe(true);
      expect(world.unlisten(key, replacement)).toBe(false);
      world.dispose();
    }
  );
  it("honours moduleIdCount", () => {
    const client = new ClientWorld({ moduleIdCount: 300 });
    expect(client.pools.find((pool) => pool.name === "module")).toEqual({
      name: "module",
      min: 700,
      max: 999,
    });
    client.dispose();
  });

  it("applies server snapshots into the client world", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    const client = world;
    client.attachSocket(socket);

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(1000, 4, 8)],
          }),
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
          diff: new StateDiff(testCid, {
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
          diff: new StateDiff(testCid, {
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
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 2,
            resets: [[1000, 2]],
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
          diff: new StateDiff(testCid, {
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
          diff: new StateDiff(testCid, {
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
          diff: new StateDiff(testCid, {
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
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 1,
            resets: [[1000, 1]],
          }),
        })
      )
    );
    client.apply(0);
    expect(() => world.entity(1000)).toThrow();

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff(testCid, {
            fromFrame: 1,
            toFrame: 2,
            snapshots: [posSnapshot(1000, 9, 9)],
          }),
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
      encodeMessage(
        new Server2Client({ diff: new StateDiff(testCid, { fromFrame: 0, toFrame: 9 }) })
      )
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
          diff: new StateDiff(testCid, {
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
          diff: new StateDiff(testCid, {
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
          diff: new StateDiff(testCid, {
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
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 9,
            snapshots: [posSnapshot(1000, 1, 1)],
          }),
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
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(1000, 2, 2)],
          }),
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

  it("rejects pending calls and emits disconnect only once when the socket disconnects", async () => {
    const client = new ClientWorld();
    const socket = new MemorySocket("server");
    const disconnect = vi.fn();
    client.attachSocket(socket);
    client.events.on("disconnect", disconnect);
    const pending = client.invoke(101);

    socket.disconnect();
    socket.disconnect();

    await expect(pending).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("treats a synchronous ack send failure as a disconnect", async () => {
    vi.useFakeTimers();
    try {
      const client = new ClientWorld({ ackIntervalMs: 10 });
      const socket = new ThrowingSocket("server");
      const disconnect = vi.fn();
      client.attachSocket(socket);
      client.events.on("disconnect", disconnect);
      const pending = client.invoke(101);

      expect(() => client.send()).not.toThrow();
      await expect(pending).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
      vi.advanceTimersByTime(30);

      expect(disconnect).toHaveBeenCalledOnce();
      expect(socket.sendCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles rejected ack sends when the socket never emits disconnect", async () => {
    vi.useFakeTimers();
    try {
      const client = new ClientWorld({ ackIntervalMs: 10 });
      const socket = new RejectingSocket("server");
      const disconnect = vi.fn();
      client.attachSocket(socket);
      client.events.on("disconnect", disconnect);
      const pending = client.invoke(101);

      client.send();
      await Promise.resolve();
      await expect(pending).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
      vi.advanceTimersByTime(30);

      expect(disconnect).toHaveBeenCalledOnce();
      expect(socket.sendCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes pending calls without disposing the world", async () => {
    const client = new ClientWorld();
    const socket = new MemorySocket("server");
    client.attachSocket(socket);
    const pending = client.invoke(101);

    client.close();

    await expect(pending).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
    expect(socket.closeCalls).toBe(1);
    expect(() => client.attachSocket(new MemorySocket("replacement"))).not.toThrow();
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
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(7, 1, 1)],
          }),
        })
      )
    );
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff(testCid, {
            fromFrame: 1,
            toFrame: 3,
            snapshots: [posSnapshot(7, 3, 3)],
          }),
        })
      )
    );
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff(testCid, {
            fromFrame: 1,
            toFrame: 2,
            snapshots: [posSnapshot(7, 2, 2)],
          }),
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
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(7, 0, 0)],
          }),
        })
      )
    );
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff(testCid, {
            fromFrame: 1,
            toFrame: 2,
            snapshots: [posSnapshot(7, 10, 20)],
          }),
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
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 5,
            snapshots: [posSnapshot(7, 50, 50)],
          }),
        })
      )
    );
    // s1 is older than what the bucket can hold relative to frame 5; must be dropped.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(7, 1, 1)],
          }),
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
        diff: new StateDiff(testCid, {
          fromFrame: 0,
          toFrame: 1,
          snapshots: [posSnapshot(7, 7, 7)],
        }),
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

describe("ClientWorld.dispose", () => {
  it("rejects pending calls with a closed error and destroys network and local entities", async () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(1000, 4, 8)],
          }),
        })
      )
    );
    world.apply(0);
    // Never networked, so a baseline reset would leave it alone, but disposal does not.
    world.getOrCreateEntity(1001);

    const pending = world.invoke(101, ["a"]);
    world.dispose();

    await expect(pending).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
    expect(socket.closed).toBe(true);
    expect(() => world.entity(1000)).toThrow();
    expect(() => world.entity(1001)).toThrow();
  });

  it("releases client-local resources through their remove hooks, after the network entities", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const removals: string[] = [];
    world.component(Position).on("remove", (entity) => removals.push(`network:${entity.eid}`));
    world.component(LocalResource).on("remove", (entity, resource) => {
      resource.released = true;
      removals.push(`local:${entity.eid}`);
    });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(1000, 4, 8)],
          }),
        })
      )
    );
    world.apply(0);
    const resource = new LocalResource();
    const effect = world.entity("spark").attach(resource);

    world.dispose();

    expect(resource.released).toBe(true);
    expect(effect.destroyed).toBe(true);
    expect(world.getEntity("spark")).toBeUndefined();
    // Each hook fires once; the network entity goes first, as the documented order has it.
    expect(removals).toEqual(["network:1000", `local:${effect.eid}`]);
  });

  it("destroys client-local entities on a world that never connected", () => {
    const world = createClientWorld();
    const resource = new LocalResource();
    world.component(LocalResource).on("remove", (_entity, released) => {
      released.released = true;
    });
    world.entity().attach(resource);

    world.dispose();

    expect(resource.released).toBe(true);
  });

  it("destroys the client's own query, system and component entities", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(1000, 4, 8)],
          }),
        })
      )
    );
    world.apply(0);
    world.entity();

    world.dispose();

    expect(entityIds(world)).toEqual([]);
  });

  it("disposes from a disconnect handler after progress finishes the tick", () => {
    const world = createClientWorld();
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    const calls: string[] = [];
    const resource = world.component(LocalResource).on("remove", () => calls.push("resource"));
    world.set(LocalResource, {});
    world.events.on("disconnect", () => {
      calls.push("disconnect");
      world.dispose();
      world.dispose();
    });
    // A malformed component payload is consumed by ClientWorld:Apply in ON_LOAD.
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 1,
            snapshots: [makeSnapshot(1000, 1, new Uint8Array([255]))],
          }),
        })
      )
    );
    world.system("later").run(() => {
      calls.push("later");
      expect(resource.alive).toBe(true);
    });
    expect(() => world.progress(0, 0)).not.toThrow();
    expect(calls).toEqual(["later", "disconnect", "resource"]);
    expect(socket.closed).toBe(true);
    expect(entityIds(world)).toEqual([]);
  });

  it("refuses new calls, sends, and socket attachments after disposal", async () => {
    const world = createClientWorld();
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    world.dispose();
    const sent = socket.sent.length;

    await expect(world.invoke(101)).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
    expect(() => world.attachSocket(new MemorySocket("other"))).toThrow("ClientWorld is disposed");
    expect(() => world.send()).not.toThrow();
    expect(socket.sent.length).toBe(sent);
  });

  it("is idempotent", () => {
    const world = createClientWorld();
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    world.dispose();

    expect(() => {
      world.dispose();
      world.dispose();
    }).not.toThrow();
    expect(socket.closeCalls).toBe(1);
  });

  it("ignores frames that arrive after disposal", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 1,
            snapshots: [posSnapshot(1000, 4, 8)],
          }),
        })
      )
    );
    world.dispose();

    socket.receive(
      encodeMessage(
        new Server2Client({
          diff: new StateDiff(testCid, {
            fromFrame: 0,
            toFrame: 2,
            snapshots: [posSnapshot(1002, 1, 1)],
          }),
        })
      )
    );
    world.apply(10);

    expect(() => world.entity(1002)).toThrow();
  });
});

describe("ClientWorld disconnect boundaries", () => {
  it.each([
    "transport close",
    "local close",
    "hook close",
    "failed send",
    "ack timer failed send",
    "malformed frame",
    "server close",
    "rejected diff",
  ])("holds %s until the outer progress completes", async (cause) => {
    vi.useFakeTimers();
    const world = createClientWorld({ ackIntervalMs: 10 });
    const socket = cause.includes("failed send")
      ? new ThrowingSocket("server")
      : new MemorySocket("server");
    world.attachSocket(socket);
    const calls: string[] = [];
    world.component(LocalResource);
    const resource = world.entity().add(LocalResource);
    const pending = world.invoke(101).catch((error: unknown) => error);
    world.events.on("disconnect", () => {
      calls.push("disconnect");
      expect(world.deferred).toBe(false);
      world.dispose();
      world.dispose();
    });
    if (cause === "hook close") {
      world.component(LocalEffect).on("add", () => world.close());
    }
    world.system("disconnect cause").run(() => {
      switch (cause) {
        case "transport close":
          socket.close();
          break;
        case "local close":
          world.close();
          break;
        case "hook close":
          resource.add(LocalEffect);
          break;
        case "failed send":
          world.send();
          break;
        case "ack timer failed send":
          vi.advanceTimersByTime(10);
          break;
        case "malformed frame":
          socket.receive(Uint8Array.of(0xde));
          break;
        case "server close":
          socket.receive(encodeMessage(new Server2Client({ close: { code: 7, reason: "done" } })));
          break;
        case "rejected diff":
          socket.receive(
            encodeMessage(
              new Server2Client({ diff: new StateDiff(testCid, { fromFrame: 5, toFrame: 6 }) })
            )
          );
          break;
      }
      expect(calls).toEqual([]);
    });
    world.system("after disconnect").run(() => {
      calls.push("later");
      expect(resource.alive).toBe(true);
      world.apply(0);
      expect(calls).toEqual(["later"]);
      // Repeated closure does not queue a duplicate event.
      world.close();
    });
    try {
      expect(() => world.progress(0, 0)).not.toThrow();
      expect(calls).toEqual(["later", "disconnect"]);
      expect(resource.destroyed).toBe(true);
      expect(entityIds(world)).toEqual([]);
      expect(await pending).toMatchObject({ code: RPC_CLOSED_CODE });
    } finally {
      world.dispose();
      vi.useRealTimers();
    }
  });

  it("emits a rejected send immediately when its promise rejects after progress", async () => {
    const world = createClientWorld();
    const socket = new RejectingSocket("server");
    world.attachSocket(socket);
    const calls: string[] = [];
    world.system("send").run(() => world.send());
    world.events.on("disconnect", () => {
      calls.push("disconnect");
      world.dispose();
    });
    world.progress(0, 0);
    expect(calls).toEqual([]);
    // Promise rejection cannot run while the synchronous progress stack is active.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["disconnect"]);
    expect(entityIds(world)).toEqual([]);
  });

  it("emits a top-level transport close immediately", () => {
    const world = createClientWorld();
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    let calls = 0;
    world.events.on("disconnect", () => {
      calls++;
      world.dispose();
    });
    socket.close();
    expect(calls).toBe(1);
    expect(entityIds(world)).toEqual([]);
    world.dispose();
  });

  it("emits a held disconnect even when a later system throws", () => {
    const world = createClientWorld();
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    let calls = 0;
    world.events.on("disconnect", () => {
      calls++;
      world.dispose();
    });
    world.system("close").run(() => world.close());
    world.system("throw").run(() => {
      throw new Error("application failure");
    });
    expect(() => world.progress(0, 0)).toThrow("application failure");
    expect(calls).toBe(1);
    expect(entityIds(world)).toEqual([]);
  });

  it("refuses disposal before changing client state, then disposes at top level", async () => {
    const world = createClientWorld();
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    world.component(LocalResource);
    const resource = world.entity().add(LocalResource);
    const pending = world.invoke(101).catch((error: unknown) => error);
    const error =
      "dispose() must be called outside progress(), defer, a command drain or an entity's destroy";
    world.system("refused").run(() => expect(() => world.dispose()).toThrow(error));
    world.progress(0, 0);
    world.defer(() => expect(() => world.dispose()).toThrow(error));
    expect(resource.alive).toBe(true);
    expect(socket.closeCalls).toBe(0);
    world.send();
    expect(socket.sent).toHaveLength(1);
    world.dispose();
    expect(await pending).toMatchObject({ code: RPC_CLOSED_CODE });
    expect(resource.destroyed).toBe(true);
    expect(socket.closeCalls).toBe(1);
    expect(entityIds(world)).toEqual([]);
  });
});

describe("ClientWorld.renderFrame", () => {
  function frame(fromFrame: number, toFrame: number, x: number): Uint8Array {
    return encodeMessage(
      new Server2Client({
        diff: new StateDiff(testCid, { fromFrame, toFrame, snapshots: [posSnapshot(1000, x, 0)] }),
      })
    );
  }

  it("is 0 until the first baseline is applied, then the server frame the world renders", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    expect(world.renderFrame).toBe(0);
    world.apply(0);
    expect(world.renderFrame).toBe(0);

    socket.receive(frame(0, 9, 90));
    socket.receive(frame(9, 10, 100));
    expect(world.renderFrame).toBe(0);

    world.apply(100);
    expect(world.renderFrame).toBe(9);
    world.apply(105);
    expect(world.renderFrame).toBeCloseTo(9.5, 9);
    expect(world.entity(1000).get(Position)).toMatchObject({ x: 95, y: 0 });
    world.apply(110);
    expect(world.renderFrame).toBe(10);
    world.close();
  });

  it("starts over at a baseline: 0 when the reset destroys the replicated entities, then the baseline's frame", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const first = new MemorySocket("server-1");
    world.attachSocket(first);
    first.receive(frame(0, 9, 90));
    first.receive(frame(9, 10, 100));
    world.apply(100);
    world.apply(110);
    first.close();
    expect(world.renderFrame).toBe(10);

    // A reconnect lands on a server whose frame counter restarted.
    const second = new MemorySocket("server-2");
    world.attachSocket(second);
    second.receive(frame(0, 1, 10));
    expect(world.renderFrame).toBe(0);
    expect(world.getEntity(1000)?.get(Position)).toBeUndefined();

    world.apply(200);
    expect(world.renderFrame).toBe(1);
    expect(world.entity(1000).get(Position)).toMatchObject({ x: 10, y: 0 });
    world.close();
  });

  it("is 0 after dispose", () => {
    const world = createClientWorld({ serverTickIntervalMs: 10 });
    const socket = new MemorySocket("server");
    world.attachSocket(socket);
    socket.receive(frame(0, 9, 90));
    world.apply(100);
    expect(world.renderFrame).toBe(9);

    world.dispose();

    expect(world.renderFrame).toBe(0);
  });
});
