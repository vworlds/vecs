import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_COMPONENTS,
  cid_pack,
  Client2Server,
  RPC,
  Server2Client,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, wireType } from "@vworlds/vecs-wire";
import type { Entity } from "@vworlds/vecs";
import { ClientWorld } from "../../vecs-client/src/index.js";
import {
  NetworkClient,
  Networked,
  ServerWorld,
  View,
  type ServerWorldOptions,
} from "../src/index.js";

// The keepalive (`ServerWorldOptions.keepAliveFrames`): a session that holds an acked baseline and
// has not been sent a frame with a diff for K frames is sent one whose diff is empty, from the base
// the frame would have had anyway. Time is mocked, so a round trip is whatever the test says it is.

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

class MockListener implements VecsSocketListener {
  private readonly _handlers: ((socket: VecsSocket) => void)[] = [];

  public on(event: "new", handler: (socket: VecsSocket) => void): this {
    if (event === "new") {
      this._handlers.push(handler);
    }
    return this;
  }

  public connect(socket: VecsSocket): void {
    this._handlers.forEach((handler) => handler(socket));
  }
}

/** Milliseconds between server frames. Frame `n` runs at `(n - 1) * TICK_MS`. */
const TICK_MS = 40;

/**
 * How many frames the simulated client's acks trail behind. The ack of a frame reaches the server
 * `LAG + 1` frame times after the frame was sent, so the smoothed round trip is 240 ms and a frame
 * may go unacked for 480 ms before it is presumed lost.
 */
const LAG = 5;

let nowMs = 0;

beforeEach(() => {
  nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Rig {
  world: ServerWorld;
  socket: MemorySocket;
  /** The entity that moves in most tests. */
  entity: Entity;
  /** An entity that only moves when a test says so. */
  other: Entity;
  /** The frames the client received, and when the server sent them. */
  received: Array<{ frame: number; sentAtMs: number }>;
  /** The newest ack delivered to the server. */
  acked: number;
}

/** A world with two replicated entities and one client connected to it. */
function createRig(options: ServerWorldOptions = {}): Rig {
  const world = new ServerWorld({ name: "main", networkComponents: [Position], ...options });
  world.component(NetworkClient).on("set", (entity) => {
    entity.set(View, { dsl: true });
  });
  const listener = new MockListener();
  world._attach(listener);
  const socket = new MemorySocket("client-1");
  listener.connect(socket);
  const entity = world.entity().add(Networked).set(Position, { x: 0, y: 0 });
  const other = world.entity().add(Networked).set(Position, { x: 100, y: 0 });
  return { world, socket, entity, other, received: [], acked: 0 };
}

/** Run one server frame at the current time, then move the clock on to the next one. */
function step(rig: Rig): Server2Client[] {
  const before = rig.socket.sent.length;
  rig.world.progress(nowMs, TICK_MS);
  nowMs += TICK_MS;
  return rig.socket.sent.slice(before).map((bytes) => new Decoder(bytes).read(Server2Client));
}

/** Run `count` frames; every frame the server sent is returned, in order. */
function steps(rig: Rig, count: number): Server2Client[] {
  const frames: Server2Client[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(...step(rig));
  }
  return frames;
}

/** Deliver a client message to the server at the current time. */
function ack(rig: Rig, ackFrame: number, options: { gap?: boolean; rpc?: RPC[] } = {}): void {
  const encoder = new Encoder(new Uint8Array(64 * 1024));
  encoder.write(new Client2Server({ ackFrame, gap: options.gap ?? false, rpc: options.rpc ?? [] }));
  rig.socket.receive(encoder.getBuffer());
  rig.acked = Math.max(rig.acked, ackFrame);
}

/**
 * Run one frame for a client whose acks trail by {@link LAG} frames: `change` happens first, then
 * the frame is sent, then the newest frame the client has received that is at least `LAG + 1` frame
 * times old is acked. Every frame with a diff reaches the client, as on a link that loses nothing,
 * unless `lost` says it does not: the client then never acks it.
 */
function advance(rig: Rig, change?: () => void, lost = false): Server2Client[] {
  change?.();
  const sentAtMs = nowMs;
  const frames = step(rig);
  if (!lost) {
    frames.forEach((frame) => {
      rig.received.push({ frame: frame.diff!.toFrame, sentAtMs });
    });
  }
  const due = rig.received.filter(({ sentAtMs: at }) => at <= nowMs - (LAG + 1) * TICK_MS);
  const newest = due.length === 0 ? 0 : due[due.length - 1].frame;
  if (newest > rig.acked) {
    ack(rig, newest);
  }
  return frames;
}

/** Run `count` frames of {@link advance} in which nothing changes. */
function advanceQuietly(rig: Rig, count: number): Server2Client[] {
  const frames: Server2Client[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(...advance(rig));
  }
  return frames;
}

/**
 * A rig whose baseline (frame 1) has been acked, `LAG + 1` frame times after it was sent. Frames 2
 * to 6 were withheld while it was in flight. The next frame is 7.
 */
function connect(options: ServerWorldOptions): Rig {
  const rig = createRig(options);
  expect(advance(rig)[0].diff).toMatchObject({ fromFrame: 0, toFrame: 1 });
  expect(advanceQuietly(rig, LAG)).toEqual([]);
  expect(rig.acked).toBe(1);
  expect(rig.world.frame).toBe(LAG + 2);
  return rig;
}

function move(entity: Entity, x: number): void {
  entity.set(Position, { x, y: 0 });
}

/** The frame number a server frame was sent as. */
function toFrameOf(frame: Server2Client): number {
  return frame.diff!.toFrame;
}

function fromFrameOf(frame: Server2Client): number {
  return frame.diff!.fromFrame;
}

/** The frame holds no state: it is an empty diff. */
function isEmptyDiff(frame: Server2Client): boolean {
  return (
    frame.diff!.snapshots.length === 0 &&
    frame.diff!.removed.length === 0 &&
    frame.diff!.resets.length === 0
  );
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("keepAliveFrames", () => {
  it.each([false, true])(
    "delivers a reset-only change exactly once with R=2 K=1 (first send lost: %s)",
    (lost) => {
      const rig = createRig({ redundancyFrames: 2, keepAliveFrames: 1 });
      const clientSocket = new MemorySocket("server");
      const client = new ClientWorld({
        networkComponents: [Position],
        socket: clientSocket,
        serverTickIntervalMs: TICK_MS,
      });
      let removals = 0;
      client.component(Position).on("remove", (entity) => {
        if (entity.eid === rig.entity.eid) {
          removals++;
        }
      });
      const receive = () => {
        clientSocket.receive(rig.socket.sent[rig.socket.sent.length - 1]);
        client.progress(nowMs + 1000, TICK_MS);
      };
      try {
        step(rig);
        receive();
        ack(rig, 1);
        rig.entity.destroy();
        const first = step(rig)[0];
        expect(first.diff).toMatchObject({
          snapshots: [],
          removed: [],
          resets: [[rig.entity.eid, 2]],
        });
        if (!lost) {
          receive();
        }
        const repeat = step(rig)[0];
        expect(repeat.diff).toMatchObject({
          snapshots: [],
          removed: [],
          resets: [[rig.entity.eid, 2]],
        });
        receive();
        const keepalive = step(rig)[0];
        expect(keepalive.diff?.fromFrame).toBe(2);
        expect(isEmptyDiff(keepalive)).toBe(true);
        expect(keepalive.optimistic).toBe(true);
        receive();
        ack(rig, 2);
        // The reset was a state change, so its repeat and the following keepalive name state frame 2.
        // A lost repeat and a lost keepalive must not move the base to an empty send frame.
        expect(step(rig)[0].diff?.fromFrame).toBe(2);
        receive();
        expect(client.getEntity(rig.entity.eid)).toBeUndefined();
        expect(client.getEntity(rig.other.eid)?.get(Position)?.x).toBe(100);
        expect(removals).toBe(1);
        client.send();
        expect(
          new Decoder(clientSocket.sent[clientSocket.sent.length - 1]).read(Client2Server).gap
        ).toBe(false);
      } finally {
        client.dispose();
      }
    }
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (keepAliveFrames) => {
    expect(() => new ServerWorld({ keepAliveFrames })).toThrow(
      `keepAliveFrames must be an integer of at least 1, got ${String(keepAliveFrames)}`
    );
  });

  it.each([1, 2, 30])("accepts %i and exposes it on the world", (keepAliveFrames) => {
    expect(new ServerWorld({ keepAliveFrames }).keepAliveFrames).toBe(keepAliveFrames);
  });

  it("is undefined on a world that does not set it", () => {
    expect(new ServerWorld().keepAliveFrames).toBeUndefined();
  });
});

describe("an idle session", () => {
  it("is sent a frame with an empty diff on every frame at keepAliveFrames 1", () => {
    const rig = connect({ keepAliveFrames: 1 });

    const frames = advanceQuietly(rig, 20);

    expect(frames.map(toFrameOf)).toEqual(Array.from({ length: 20 }, (_, i) => 7 + i));
    expect(frames.every(isEmptyDiff)).toBe(true);
    expect(frames.every((frame) => frame.rpc.length === 0)).toBe(true);
    // Without redundancyFrames each starts at the ack, which trails by LAG + 1 frames, and none is
    // marked optimistic.
    expect(frames.every((frame) => !frame.optimistic)).toBe(true);
    expect(frames.every((frame) => fromFrameOf(frame) < toFrameOf(frame))).toBe(true);
  });

  it("is sent one every other frame at keepAliveFrames 2", () => {
    const rig = connect({ keepAliveFrames: 2 });

    const frames = advanceQuietly(rig, 20);

    expect(frames.map(toFrameOf)).toEqual([7, 9, 11, 13, 15, 17, 19, 21, 23, 25]);
    expect(frames.every(isEmptyDiff)).toBe(true);
  });

  it("is sent one every third frame at keepAliveFrames 3", () => {
    const rig = connect({ keepAliveFrames: 3 });

    expect(advanceQuietly(rig, 20).map(toFrameOf)).toEqual([7, 10, 13, 16, 19, 22, 25]);
  });

  it("is sent the first one keepAliveFrames after its baseline, counting from the frame the baseline was sent", () => {
    const rig = connect({ keepAliveFrames: 30 });

    expect(advanceQuietly(rig, 24)).toEqual([]);
    expect(advanceQuietly(rig, 1).map(toFrameOf)).toEqual([31]);
    expect(advanceQuietly(rig, 29)).toEqual([]);
    expect(advanceQuietly(rig, 1).map(toFrameOf)).toEqual([61]);
  });

  it("is sent nothing when the option is unset", () => {
    const rig = connect({});

    expect(advanceQuietly(rig, 40)).toEqual([]);
  });

  it("is sent a frame of 5 bytes: a header, and no state", () => {
    const rig = connect({ keepAliveFrames: 1 });

    advanceQuietly(rig, 3);

    // A diff tag, `toFrame` and `fromFrame` (a byte each below frame 128), and the counts of
    // snapshots and removals.
    expect(rig.socket.sent.slice(-3).map((bytes) => bytes.length)).toEqual([5, 5, 5]);
  });

  it("is sent a frame one byte longer when it is marked optimistic", () => {
    const rig = connect({ keepAliveFrames: 1, redundancyFrames: 2 });
    // A change in frame 7, sent in 7 and 8, so the keepalives that follow start at it, past the
    // ack, until the ack reaches it: an idle view has nothing to presume, but just after a change
    // the client may not have it yet.
    advance(rig, () => move(rig.entity, 1));
    advance(rig);
    const sentBefore = rig.socket.sent.length;

    const frames = advanceQuietly(rig, 10);

    const marked = frames.filter((frame) => frame.optimistic);
    const plain = frames.filter((frame) => !frame.optimistic);
    expect(marked.length).toBeGreaterThanOrEqual(3);
    expect(plain.length).toBeGreaterThanOrEqual(3);
    expect(rig.socket.sent.slice(sentBefore).map((bytes) => bytes.length)).toEqual(
      frames.map((frame) => (frame.optimistic ? 6 : 5))
    );
  });

  it("is acked by the client like any frame, which moves its base on", () => {
    const rig = connect({ keepAliveFrames: 1 });

    const frames = advanceQuietly(rig, 20);

    // The ack follows the keepalives the client received, so the base moves up with it instead of
    // staying at the baseline: the last one starts at the ack of the frame before it.
    const last = frames[frames.length - 1];
    expect(rig.acked).toBe(toFrameOf(last) - LAG);
    expect(fromFrameOf(last)).toBe(toFrameOf(last) - (LAG + 1));
  });
});

describe("a session with traffic", () => {
  /** The bytes of every frame sent while the entity moves on each of 40 frames. */
  function movingEveryFrame(options: ServerWorldOptions): Uint8Array[] {
    const rig = connect(options);
    for (let x = 1; x <= 40; x++) {
      advance(rig, () => move(rig.entity, x));
    }
    return rig.socket.sent;
  }

  it.each([1, 2, 5])(
    "is sent exactly the frames it is sent without the option, at keepAliveFrames %i",
    (keepAliveFrames) => {
      const withOption = movingEveryFrame({ keepAliveFrames });
      const without = movingEveryFrame({});

      expect(withOption).toHaveLength(without.length);
      expect(withOption).toEqual(without);
    }
  );

  it("restarts the count at every frame with content", () => {
    const rig = connect({ keepAliveFrames: 3 });

    // The change in frame 7 is sent in every frame until its ack arrives, which is LAG + 1 frames:
    // 7 to 12. The idle session is then sent a keepalive three frames after the last of them.
    const frames = [...advance(rig, () => move(rig.entity, 1)), ...advanceQuietly(rig, 11)];

    expect(frames.map(toFrameOf)).toEqual([7, 8, 9, 10, 11, 12, 15, 18]);
    expect(frames.map(isEmptyDiff)).toEqual([false, false, false, false, false, false, true, true]);
  });

  it("counts a frame that carries an RPC reply with an empty diff as a frame with a diff", async () => {
    const rig = createRig({ keepAliveFrames: 2 });
    rig.world.handleRpc(7, () => "pong");
    expect(step(rig)[0].diff).toMatchObject({ fromFrame: 0, toFrame: 1 });
    ack(rig, 1);
    expect(step(rig)).toEqual([]);

    ack(rig, 1, { rpc: [new RPC({ rpcId: 7, callId: 3, params: [] })] });
    await settlePromises();
    const frames = steps(rig, 4);

    // Frame 3 carries the reply and an empty diff, so the next keepalive is two frames after it,
    // not at frame 3 (two after the baseline) and 5.
    expect(frames.map(toFrameOf)).toEqual([3, 5]);
    expect(frames[0].rpc).toHaveLength(1);
    expect(frames[1].rpc).toHaveLength(0);
  });
});

describe("a session that waits for a baseline", () => {
  it("is sent nothing while the first baseline is in flight, then a keepalive once it is acked", () => {
    const rig = createRig({ keepAliveFrames: 1 });

    expect(step(rig)[0].diff).toMatchObject({ fromFrame: 0, toFrame: 1 });
    expect(steps(rig, 10)).toEqual([]);

    ack(rig, 1);
    const [keepalive] = step(rig);

    expect(keepalive.diff).toMatchObject({ fromFrame: 1, toFrame: 12, snapshots: [], removed: [] });
  });

  it("is sent no keepalive before it has acked a baseline, because it has none to build on", () => {
    // A view with nothing in it is sent no baseline, and so nothing: the client holds nothing, and
    // there is no render frame to keep moving.
    const world = new ServerWorld({
      name: "main",
      networkComponents: [Position],
      keepAliveFrames: 1,
    });
    world.component(NetworkClient).on("set", (entity) => {
      entity.set(View, { dsl: true });
    });
    const listener = new MockListener();
    world._attach(listener);
    const socket = new MemorySocket("client-1");
    listener.connect(socket);

    for (let i = 0; i < 10; i++) {
      world.progress(nowMs, TICK_MS);
      nowMs += TICK_MS;
    }

    expect(socket.sent).toEqual([]);
  });

  it("is sent nothing while a resynchronization baseline is in flight", () => {
    // A window of 4 frames: the change in frame 3, never acked, leaves it at frame 7, so the client
    // can no longer be caught up with a delta and is sent a baseline.
    const rig = createRig({ keepAliveFrames: 1, historyFrames: 4 });
    expect(step(rig)[0].diff).toMatchObject({ fromFrame: 0, toFrame: 1 });
    ack(rig, 1);
    expect(step(rig).map(toFrameOf)).toEqual([2]);
    move(rig.entity, 1);
    const frames = steps(rig, 5);
    expect(frames.map(toFrameOf)).toEqual([3, 4, 5, 6, 7]);
    expect(frames.slice(0, 4).every((frame) => fromFrameOf(frame) === 1)).toBe(true);
    expect(frames[4].diff).toMatchObject({ fromFrame: 0, toFrame: 7 });

    // 80 ms later the baseline is still in flight, within the 100 ms it is given: no frame at all.
    expect(steps(rig, 2)).toEqual([]);

    // Acked, the session is sent keepalives again.
    ack(rig, 7);
    expect(step(rig)[0].diff).toMatchObject({ fromFrame: 7, toFrame: 10, snapshots: [] });
  });

  it("does not count a frame with RPC traffic and no diff as a frame with a diff", async () => {
    const rig = createRig({ keepAliveFrames: 2 });
    rig.world.handleRpc(7, () => "pong");
    expect(step(rig)[0].diff).toMatchObject({ fromFrame: 0, toFrame: 1 });

    // The baseline is in flight, so frame 2 carries the reply and no diff.
    ack(rig, 0, { rpc: [new RPC({ rpcId: 7, callId: 3, params: [] })] });
    await settlePromises();
    const [replyOnly] = step(rig);
    expect(replyOnly.diff).toBeUndefined();
    expect(replyOnly.rpc).toHaveLength(1);

    // Frame 3 is two frames after the baseline, the last frame with a diff, so it is a keepalive.
    // Had the reply-only frame counted, it would have been one frame after it, and not.
    ack(rig, 1);
    const [keepalive] = step(rig);
    expect(keepalive.diff).toMatchObject({ fromFrame: 1, toFrame: 3, snapshots: [], removed: [] });
  });
});

describe("with redundancyFrames", () => {
  it("starts an idle session's keepalives at its ack, plain, since there is nothing it could lack", () => {
    const rig = connect({ keepAliveFrames: 1, redundancyFrames: 2 });

    const frames = advanceQuietly(rig, 30);

    // The baseline is the only content the session has ever been sent, and it is acked, so past the
    // first frames the base is the ack, which trails by LAG + 1 frames, and none is marked. A base
    // taken from the frames sent would run ahead of the ack as it does in a busy view, and a lost
    // keepalive would read as a gap.
    const steady = frames.filter((frame) => toFrameOf(frame) >= 14);
    expect(steady).toHaveLength(23);
    expect(steady.every((frame) => toFrameOf(frame) - fromFrameOf(frame) === LAG + 1)).toBe(true);
    expect(frames.every((frame) => !frame.optimistic)).toBe(true);
    expect(frames.every(isEmptyDiff)).toBe(true);
  });

  it.each([
    { keepAliveFrames: 1, redundancyFrames: 1 },
    { keepAliveFrames: 1, redundancyFrames: 2 },
    { keepAliveFrames: 1, redundancyFrames: 3 },
    { keepAliveFrames: 2, redundancyFrames: 2 },
    { keepAliveFrames: 3, redundancyFrames: 2 },
  ])(
    "starts every keepalive after a change at the change, or at the ack once that is past it: %o",
    ({ keepAliveFrames, redundancyFrames }) => {
      const rig = connect({ keepAliveFrames, redundancyFrames });
      // A change in frame 7, which is sent in R frames in a row; the keepalives follow.
      advance(rig, () => move(rig.entity, 1));
      for (let i = 1; i < redundancyFrames; i++) {
        advance(rig);
      }

      let keepalives = 0;
      let marked = 0;
      for (let i = 0; i < 40; i++) {
        const ackedBefore = rig.acked;
        for (const frame of advance(rig)) {
          expect(isEmptyDiff(frame)).toBe(true);
          // The state frame of the sends since the change is 7, whichever send the base is taken
          // from, so the base is 7 until the ack passes it. The frame sent R sends ago would be
          // later than that, and a client that lost it would not hold it.
          expect(fromFrameOf(frame)).toBe(Math.max(7, ackedBefore));
          expect(frame.optimistic).toBe(7 > ackedBefore);
          keepalives++;
          marked += frame.optimistic ? 1 : 0;
        }
      }

      expect(keepalives).toBeGreaterThan(10);
      expect(marked).toBeGreaterThan(0);
    }
  );

  it.each([
    { keepAliveFrames: 1, redundancyFrames: 1 },
    { keepAliveFrames: 1, redundancyFrames: 2 },
    { keepAliveFrames: 1, redundancyFrames: 3 },
    { keepAliveFrames: 2, redundancyFrames: 2 },
    { keepAliveFrames: 3, redundancyFrames: 2 },
  ])(
    "bases every keepalive on a frame the client holds, on a link that loses nothing: %o",
    (options) => {
      const rig = connect(options);
      // The client holds the baseline and every frame it was sent since.
      const held = new Set<number>([1]);

      for (let i = 0; i < 60; i++) {
        // A change now and then, so keepalives and frames with content alternate.
        const frames = advance(rig, i % 11 === 5 ? () => move(rig.entity, i) : undefined);
        frames.forEach((frame) => {
          expect(held.has(fromFrameOf(frame))).toBe(true);
          held.add(toFrameOf(frame));
        });
      }

      expect(held.size).toBeGreaterThan(20);
    }
  );

  it("keeps a client that stops acking on plain keepalives, with no content to chase", () => {
    const rig = connect({ keepAliveFrames: 1, redundancyFrames: 2 });

    // The client stops acking, for 1.2 s: far longer than the 480 ms a frame with content is given.
    // Keepalives hold no content and the baseline is acked, so there is nothing to chase and
    // nothing to presume: every keepalive starts at the ack, which is the baseline.
    const frames = steps(rig, 30);

    expect(frames).toHaveLength(30);
    expect(frames.every((frame) => fromFrameOf(frame) === 1)).toBe(true);
    expect(frames.every((frame) => !frame.optimistic)).toBe(true);
  });

  it("still chases a lost change with the ack timeout, and falls back to the ack", () => {
    const rig = connect({ keepAliveFrames: 1, redundancyFrames: 2 });

    // A change goes out and is never acked. Once it has gone unacked for the timeout, the session
    // falls back to deltas from the ack, which is the frame of the baseline.
    const [first] = advance(rig, () => move(rig.entity, 1));
    const frames = steps(rig, 30);

    expect(first.diff!.snapshots).toHaveLength(1);
    const last = frames[frames.length - 1];
    expect(fromFrameOf(last)).toBe(rig.acked);
    expect(last.optimistic).toBe(false);
  });

  it("falls back to the ack on a gap report, and keepalives follow the fallback", () => {
    const rig = connect({ keepAliveFrames: 1, redundancyFrames: 2 });
    advanceQuietly(rig, 10);

    const ackedBefore = rig.acked;
    ack(rig, ackedBefore, { gap: true });
    const [during] = advance(rig);

    // The fallback starts at the next frame: deltas from the ack, as without redundancyFrames.
    expect(fromFrameOf(during)).toBe(ackedBefore);
    expect(during.optimistic).toBe(false);
    expect(isEmptyDiff(during)).toBe(true);
  });

  it("ends a fallback once the client has acked the last change, not the latest keepalive", () => {
    const rig = connect({ keepAliveFrames: 1, redundancyFrames: 2 });
    // A change in frame 7, sent in 7 and 8, then keepalives; the client has acked far past it.
    advance(rig, () => move(rig.entity, 1));
    advanceQuietly(rig, 12);
    expect(rig.acked).toBeGreaterThan(8);

    // A (stale) gap report starts a fallback, but the client holds the only change there is, so it
    // ends at once. Every keepalive since is newer than the ack, and waiting for the client to ack
    // the latest of them would keep the session on plain deltas for a round trip.
    ack(rig, rig.acked, { gap: true });
    const [during] = advance(rig);
    expect(during.optimistic).toBe(false);
    const [change] = advance(rig, () => move(rig.entity, 2));
    const [repeat] = advance(rig);
    const [keepalive] = advance(rig);

    // The change is sent in two frames, and the keepalive after them starts at it, ahead of the
    // ack: the session is optimistic again, with no fallback in the way.
    expect(isEmptyDiff(change)).toBe(false);
    expect(isEmptyDiff(repeat)).toBe(false);
    expect(isEmptyDiff(keepalive)).toBe(true);
    expect(fromFrameOf(keepalive)).toBe(toFrameOf(change));
    expect(keepalive.optimistic).toBe(true);
  });
});

describe("an unset keepAliveFrames", () => {
  // #242 adds a frame offset to each whole-entity removal. Pin the resulting wire and also check
  // that stripping only those offsets reproduces the pre-reset fingerprints below.
  const PINNED_SHA256 = "79a75c0253a7cf72db92897e1eb48406319c01aeb7bedcc9d439d0784a5ed345";
  const PRE_RESET_SHA256 = "a0ffe2f16f184be75a2f4e7dc565d8e01507a7a2949396f02447392136a070f5";
  // The same, with redundancyFrames 2, recorded when the base became the state frame of the send R
  // sends ago. That change moved the wire of this script on purpose: the repeats of a change and the
  // fallback after the gap report now start at the frame of the change (the frame labels differ and
  // the bodies are the same), and the fallback ends once the client has acked the last change
  // instead of the last frame sent. The keepalive option must not move it again.
  const PINNED_REDUNDANT_SHA256 =
    "b51d9af02319a3888359309d1b891ab204e9827575dbd295649ddfe4d8cf068a";
  const PRE_RESET_REDUNDANT_SHA256 =
    "28158df1b4decf33be9aec10adac2d2dde5dea4bc21e0371daef0e81ac4c01fd";

  /**
   * A lagging client on a lossy link: acks trail by five frames, every ninth frame is lost, one
   * ack reports a gap, and the view is busy, then quiet, then busy again, then loses an entity.
   */
  function script(options: ServerWorldOptions, stripResetOffsets = false): string {
    const rig = createRig(options);
    for (let frame = 1; frame <= 120; frame++) {
      const busy = frame <= 40 || (frame >= 80 && frame <= 100);
      advance(
        rig,
        () => {
          if (busy && frame % 3 !== 0) {
            move(rig.entity, frame);
          }
          if (frame % 7 === 0) {
            move(rig.other, frame * 2);
          }
          if (frame === 110) {
            rig.other.destroy();
          }
        },
        frame % 9 === 0
      );
      if (frame === 60) {
        ack(rig, rig.acked, { gap: true });
      }
    }
    const hash = createHash("sha256");
    rig.socket.sent.forEach((bytes) => {
      if (!stripResetOffsets) {
        hash.update(bytes);
        return;
      }
      const message = new Decoder(bytes).read(Server2Client);
      const diff = message.diff!;
      // This script emits only diff fields and the optional optimistic marker. Reconstruct
      // the previous layout solely for the fingerprint assertion, never for client decoding.
      expect(message.rpc).toEqual([]);
      expect(message.rpcSettledBelow).toBe(0);
      expect(message.close).toBeUndefined();
      const encoder = new Encoder(new Uint8Array(64 * 1024));
      encoder.write_u8(1);
      encoder.write_u32(diff.toFrame);
      encoder.write_u32(diff.fromFrame);
      encoder.write_u32(diff.snapshots.length);
      diff.snapshots.forEach((snapshot) => encoder.write_buffer(snapshot.bytes));
      encoder.write_u32(diff.removed.length + diff.resets.length);
      diff.removed.forEach(([eid, wireType]) => encoder.write_u32(cid_pack(eid, wireType)));
      diff.resets.forEach(([eid]) => encoder.write_u32(cid_pack(eid, ALL_COMPONENTS)));
      if (message.optimistic) {
        encoder.write_u8(6);
      }
      hash.update(encoder.getBuffer());
    });
    return hash.digest("hex");
  }

  it("sends exactly the frames it sent before the option existed", () => {
    expect(script({})).toBe(PINNED_SHA256);
    nowMs = 0;
    expect(script({}, true)).toBe(PRE_RESET_SHA256);
  });

  it("sends exactly the frames it sent without the option, with redundancyFrames", () => {
    expect(script({ redundancyFrames: 2 })).toBe(PINNED_REDUNDANT_SHA256);
    nowMs = 0;
    expect(script({ redundancyFrames: 2 }, true)).toBe(PRE_RESET_REDUNDANT_SHA256);
  });

  it("is the same as an explicit undefined", () => {
    expect(script({ keepAliveFrames: undefined })).toBe(script({}));
    expect(script({ keepAliveFrames: undefined, redundancyFrames: 2 })).toBe(
      script({ redundancyFrames: 2 })
    );
  });

  it("is not the wire of a world that sets it, so the pins above can tell", () => {
    expect(script({ keepAliveFrames: 1 })).not.toBe(PINNED_SHA256);
  });
});
