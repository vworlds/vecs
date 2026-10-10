import { afterEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { Client2Server, Server2Client, type VecsSocket } from "@vworlds/vecs-protocol";
import { Decoder, Encoder, wireType } from "@vworlds/vecs-wire";
import { NetworkClient, Networked, ServerWorld, View } from "../src/index.js";

class Value {
  @wireType("i32")
  public x = 0;
}

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  public readonly id = "tail-probe";
  public readonly sent: Uint8Array[] = [];
  private readonly _handlers = new Map<string, SocketHandler[]>();

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    this._handlers.set(event, [...(this._handlers.get(event) ?? []), handler]);
    return this;
  }

  public send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }

  public receive(ackFrame: number): void {
    const encoder = new Encoder(new Uint8Array(128));
    encoder.write(new Client2Server({ ackFrame }));
    this._handlers.get("receive")?.forEach((handler) => handler(encoder.getBuffer()));
  }

  public close(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

afterEach(() => vi.restoreAllMocks());

// Port of PR #249's read-only review reproduction. Delivery and ACKs are controlled
// independently: only A is delivered; B and all its optimistic repeats are lost.
function start(redundancyFrames: number, keepAliveFrames?: number) {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const world = new ServerWorld({ networkComponents: [Value], redundancyFrames, keepAliveFrames });
  world.component(NetworkClient).on("set", (entity) => entity.set(View, { dsl: true }));
  const socket = new MemorySocket();
  world._attach({
    on(_event, handler) {
      handler(socket);
      return this;
    },
  });
  const entity = world.entity().add(Networked).add(Value);
  const step = (atMs: number) => {
    now = atMs;
    socket.sent.length = 0;
    world.progress(now, 40);
    return socket.sent.map((bytes) => new Decoder(bytes).read(Server2Client));
  };
  const ack = (frame: number, atMs: number) => {
    now = atMs;
    socket.receive(frame);
  };
  expect(step(0)[0].diff).toMatchObject({ fromFrame: 0, toFrame: 1 });
  ack(1, 200);
  return { world, entity, step, ack };
}

describe.each([1, 2])("partial ACK liveness, R=%i", (redundancyFrames) => {
  it.each([false, true])("protects the newer unacknowledged tail (reset-only=%s)", (resetOnly) => {
    const run = start(redundancyFrames);
    run.entity.set(Value, { x: 1 });
    expect(run.step(200)[0].diff?.toFrame).toBe(2);
    if (resetOnly) {
      run.entity.destroy();
    } else {
      run.entity.set(Value, { x: 2 });
    }
    const tail = run.step(240)[0].diff!;
    expect(tail.toFrame).toBe(3);
    if (resetOnly) {
      expect(tail.snapshots).toEqual([]);
      expect(tail.removed).toEqual([]);
      expect(tail.resets).toEqual([[run.entity.eid, 3]]);
    }
    if (redundancyFrames === 2) {
      expect(run.step(280)[0].diff?.toFrame).toBe(4);
    }
    run.ack(2, 400);
    expect(run.step(400)).toEqual([]);
    expect(run.step(800)).toEqual([]);
    const retry = run.step(801);
    expect(retry).toHaveLength(1);
    expect(retry[0].optimistic).toBe(false);
    expect(retry[0].diff).toMatchObject({ fromFrame: 2 });
    if (resetOnly) {
      expect(retry[0].diff!.resets).toEqual([[run.entity.eid, 3]]);
    } else {
      expect(retry[0].diff!.snapshots).toHaveLength(1);
    }
  });

  it("stale and duplicate older ACKs neither disarm nor postpone the tail probe", () => {
    const run = start(redundancyFrames);
    run.entity.set(Value, { x: 1 });
    run.step(200);
    run.entity.set(Value, { x: 2 });
    run.step(240);
    if (redundancyFrames === 2) {
      run.step(280);
    }
    run.ack(2, 400);
    run.ack(1, 600);
    run.ack(2, 700);
    expect(run.step(800)).toEqual([]);
    expect(run.step(801)[0].diff).toMatchObject({ fromFrame: 2 });
  });

  it.each([undefined, 1])(
    "fully acked quiet sessions never chase lost keepalives (K=%s)",
    (keepAliveFrames) => {
      const run = start(redundancyFrames, keepAliveFrames);
      for (let atMs = 240; atMs <= 4000; atMs += 40) {
        const frames = run.step(atMs);
        if (keepAliveFrames === undefined) {
          expect(frames).toEqual([]);
        } else {
          expect(frames).toHaveLength(1);
          expect(frames[0].optimistic).toBe(false);
          expect(frames[0].diff).toMatchObject({
            fromFrame: 1,
            snapshots: [],
            removed: [],
          });
        }
      }
    }
  );

  it("recovers through the probe when keepalives expose a gap but every gap report is lost", () => {
    const run = start(redundancyFrames, 1);
    run.entity.set(Value, { x: 1 });
    run.step(200);
    run.entity.set(Value, { x: 2 });
    run.step(240);
    if (redundancyFrames === 2) {
      run.step(280);
    }
    run.ack(2, 400);
    // These keepalives start past the client's frame 2. No gap report reaches the server.
    for (let atMs = 400; atMs <= 800; atMs += 40) {
      const frame = run.step(atMs)[0];
      expect(frame.optimistic).toBe(true);
      expect(frame.diff).toMatchObject({ fromFrame: 3, snapshots: [], removed: [] });
      expect(frame.diff?.resets).toBeUndefined();
    }
    const retry = run.step(801)[0];
    expect(retry.optimistic).toBe(false);
    expect(retry.diff).toMatchObject({ fromFrame: 2 });
    expect(retry.diff!.snapshots).toHaveLength(1);
  });
});
