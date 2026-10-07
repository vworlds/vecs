import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_COMPONENTS,
  Client2Server,
  ComponentSnapshot,
  RPC,
  Server2Client,
  type SessionRPC,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, wireType } from "@vworlds/vecs-wire";
import type { Entity } from "@vworlds/vecs";
import { performance } from "node:perf_hooks";
import {
  NetworkClient,
  Networked,
  ServerWorld,
  View,
  type ServerWorldOptions,
} from "../src/index.js";

// How the server decides what a session is sent: a baseline for a client that holds nothing it can
// build a delta on, a delta from the newest ack otherwise, and nothing while a baseline waits to be
// acked. Time is mocked, so a round trip is whatever the test says it is.

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

/** Milliseconds between server frames unless a test sets `tickMs`. */
const DEFAULT_TICK_MS = 40;

/** Milliseconds between server frames. Frame `n` runs at `(n - 1) * tickMs`. */
let tickMs = DEFAULT_TICK_MS;
let nowMs = 0;

beforeEach(() => {
  tickMs = DEFAULT_TICK_MS;
  nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Rig {
  world: ServerWorld;
  socket: MemorySocket;
  /** The one replicated entity, or `undefined` for a rig built without one. */
  entity: Entity | undefined;
}

interface RigConfig {
  /** Give the world an entity before the client connects. Default `true`. */
  entity?: boolean;
  /** Let the client see every entity. Default `true`; without it nothing is visible. */
  view?: boolean;
}

/** A world and one client connected to it. */
function createRig(options: ServerWorldOptions = {}, config: RigConfig = {}): Rig {
  const world = new ServerWorld({ name: "main", networkComponents: [Position], ...options });
  if (config.view !== false) {
    world.component(NetworkClient).on("set", (entity) => {
      entity.set(View, { dsl: true });
    });
  }
  const listener = new MockListener();
  world._attach(listener);
  const socket = new MemorySocket("client-1");
  listener.connect(socket);
  const entity =
    config.entity === false
      ? undefined
      : world.entity().add(Networked).set(Position, { x: 0, y: 0 });
  return { world, socket, entity };
}

/** Run one server frame at the current time, then move the clock on to the next one. */
function step(rig: Rig): Server2Client[] {
  const before = rig.socket.sent.length;
  rig.world.progress(nowMs, tickMs);
  nowMs += tickMs;
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

/** Deliver a client message with `ackFrame` to the server at the current time. */
function ack(rig: Rig, ackFrame: number, rpc: RPC[] = []): void {
  const encoder = new Encoder(new Uint8Array(64 * 1024));
  encoder.write(new Client2Server({ ackFrame, rpc }));
  rig.socket.receive(encoder.getBuffer());
}

function move(rig: Rig, x: number): void {
  rig.entity!.set(Position, { x, y: 0 });
}

/**
 * Run `count` frames, each followed by the ack of `ackedFrame` that an idle client keeps sending,
 * so the session is not closed as silent however long the run is.
 */
function stepsAcking(rig: Rig, count: number, ackedFrame: number): Server2Client[] {
  const frames: Server2Client[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(...step(rig));
    ack(rig, ackedFrame);
  }
  return frames;
}

/** Run `count` frames in which the entity moves on every one, so every frame has something in it. */
function stepsMoving(rig: Rig, count: number, firstX = 1): Server2Client[] {
  const frames: Server2Client[] = [];
  for (let i = 0; i < count; i++) {
    move(rig, firstX + i);
    frames.push(...step(rig));
  }
  return frames;
}

/** The RPC channel of the session the rig's client is connected on. */
function sessionRpc(rig: Rig): SessionRPC {
  const sessions = (rig.world as unknown as { _sessions: Map<string, { rpc: SessionRPC }> })
    ._sessions;
  return sessions.get("client-1")!.rpc;
}

function isBaseline(frame: Server2Client): boolean {
  return frame.diff?.fromFrame === 0;
}

/** The `toFrame` of every baseline among `frames`. */
function baselineFrames(frames: Server2Client[]): number[] {
  return frames.filter(isBaseline).map((frame) => frame.diff!.toFrame);
}

function positionIn(frame: Server2Client): Position {
  const snapshot = new Decoder(frame.diff!.snapshots[0].bytes).read(ComponentSnapshot);
  return new Decoder(snapshot.payload).read(Position);
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("historyFrames", () => {
  // A client can be caught up while nothing it is missing has left the history. Here the client
  // acks frame 1, the entity moves in frame 2, and the client never acks frame 2, so it is missing
  // frame 2. That frame is still in the window at frame `window + 1` and leaves it at the next.
  it.each([
    { option: undefined, window: 64 },
    { option: 8, window: 8 },
    { option: 2, window: 2 },
  ])(
    "serves a delta until a frame the client lacks is $window frames old, and a baseline after",
    ({ option, window }) => {
      const inside = createRig({ historyFrames: option });
      step(inside);
      ack(inside, 1);
      move(inside, 5);
      const insideFrames = [...step(inside), ...steps(inside, window - 1)];

      expect(insideFrames.filter(isBaseline)).toEqual([]);
      const delta = insideFrames[insideFrames.length - 1];
      expect(delta.diff).toMatchObject({ fromFrame: 1, toFrame: window + 1 });
      expect(positionIn(delta)).toMatchObject({ x: 5 });

      const outside = createRig({ historyFrames: option });
      step(outside);
      ack(outside, 1);
      move(outside, 5);
      const outsideFrames = [...step(outside), ...steps(outside, window)];

      expect(baselineFrames(outsideFrames)).toEqual([window + 2]);
      const baseline = outsideFrames[outsideFrames.length - 1];
      expect(baseline.diff).toMatchObject({ fromFrame: 0, toFrame: window + 2 });
      expect(positionIn(baseline)).toMatchObject({ x: 5 });
    }
  );

  it.each([0, 1, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects %s, which is not an integer of at least 2",
    (value) => {
      expect(() => new ServerWorld({ historyFrames: value })).toThrow(
        /historyFrames must be an integer of at least 2/
      );
    }
  );

  it("accepts the smallest window", () => {
    expect(() => new ServerWorld({ historyFrames: 2 })).not.toThrow();
  });
});

describe("a baseline in flight", () => {
  it("is the only state a new session is sent until the client acks it", () => {
    const rig = createRig();
    const frames: Server2Client[] = [];
    for (let i = 0; i < 20; i++) {
      move(rig, i);
      frames.push(...step(rig));
    }

    expect(frames).toHaveLength(1);
    expect(frames[0].diff).toMatchObject({ fromFrame: 0, toFrame: 1 });
    expect(positionIn(frames[0])).toMatchObject({ x: 0 });
  });

  it("is not released by the ack of 0 that a client with nothing sends", () => {
    const rig = createRig();
    step(rig);

    ack(rig, 0);
    move(rig, 4);

    expect(steps(rig, 3)).toEqual([]);
  });

  it("is released by the ack of the baseline, and the next delta starts there", () => {
    const rig = createRig();
    step(rig);
    steps(rig, 3);
    move(rig, 7);
    steps(rig, 1);

    ack(rig, 1);
    const [delta] = step(rig);

    expect(delta.diff).toMatchObject({ fromFrame: 1, toFrame: 6 });
    expect(positionIn(delta)).toMatchObject({ x: 7 });
  });

  it("is released by an ack newer than the baseline, since the client holds something newer", () => {
    const rig = createRig();
    step(rig);
    steps(rig, 4);

    ack(rig, 5);
    move(rig, 9);
    const [delta] = step(rig);

    expect(delta.diff).toMatchObject({ fromFrame: 5, toFrame: 6 });
  });

  it("never sends a delta from a frame the client has not acked", () => {
    const rig = createRig();
    const baselines: number[] = [];
    let delivered = 0; // the newest ack the server has been sent
    let received = 0; // the newest frame the client has received
    let pending = 0; // the ack on its way, which reaches the server after the next frame

    for (let i = 0; i < 60; i++) {
      move(rig, i);
      for (const frame of step(rig)) {
        const diff = frame.diff!;
        if (diff.fromFrame === 0) {
          baselines.push(diff.toFrame);
        } else {
          expect(diff.fromFrame).toBeLessThanOrEqual(delivered);
        }
        received = diff.toFrame;
      }
      ack(rig, pending);
      delivered = pending;
      pending = received;
    }

    expect(baselines).toEqual([1]);
    expect(delivered).toBeGreaterThan(50);
  });

  it("keeps recording history, so a removal made meanwhile reaches the client after the ack", () => {
    const rig = createRig();
    const doomed = rig.entity!;
    step(rig);
    doomed.destroy();
    expect(steps(rig, 3)).toEqual([]);

    ack(rig, 1);
    const [delta] = step(rig);

    expect(delta.diff).toMatchObject({ fromFrame: 1, toFrame: 5 });
    expect(delta.diff!.removed).toContainEqual([doomed.eid, ALL_COMPONENTS]);
  });

  it("still carries RPC replies, in frames with no state", async () => {
    const rig = createRig();
    rig.world.handleRpc(7, () => "pong");
    step(rig);

    ack(rig, 0, [new RPC({ rpcId: 7, callId: 3, params: [] })]);
    await settlePromises();
    move(rig, 5);
    const frames = step(rig);

    expect(frames).toHaveLength(1);
    expect(frames[0].diff).toBeUndefined();
    expect(frames[0].rpc).toHaveLength(1);
    expect(frames[0].rpc[0]).toMatchObject({ callId: 3, error: 0, params: ["pong"] });

    // Once the baseline is acked, a reply rides with the (here empty) diff from the ack again.
    ack(rig, 1);
    const [delta] = step(rig);
    ack(rig, delta.diff!.toFrame, [new RPC({ rpcId: 7, callId: 4, params: [] })]);
    await settlePromises();
    const [rpcFrame] = step(rig);
    expect(rpcFrame.diff).toMatchObject({ fromFrame: 3, toFrame: 4, snapshots: [], removed: [] });
    expect(rpcFrame.rpc[0]).toMatchObject({ callId: 4, params: ["pong"] });
  });
});

describe("a frame without state", () => {
  it("still carries the RPC watermark, so the client can drop the replies it kept", async () => {
    const rig = createRig();
    rig.world.handleRpc(7, () => "pong");
    step(rig); // the baseline is now in flight

    // The channel's watermark is 1 once its first call has settled.
    const rpc = sessionRpc(rig);
    const call = rpc.invoke(101, []);
    rpc.process([new RPC({ rpcId: 0, callId: 0, params: [] })]);
    await call;
    expect(rpc.settledBelow).toBe(1);
    ack(rig, 0, [new RPC({ rpcId: 7, callId: 3, params: [] })]);
    await settlePromises();
    const frames = step(rig);

    expect(frames).toHaveLength(1);
    expect(frames[0].diff).toBeUndefined();
    expect(frames[0].rpc[0]).toMatchObject({ callId: 3, params: ["pong"] });
    expect(frames[0].rpcSettledBelow).toBe(1);
  });
});

describe("a session with nothing visible", () => {
  it("is sent no baseline, so the first thing it can see goes out at once", () => {
    const rig = createRig({}, { entity: false });
    expect(steps(rig, 5)).toEqual([]);

    rig.entity = rig.world.entity().add(Networked).set(Position, { x: 3, y: 3 });
    const [baseline] = step(rig);

    expect(baseline.diff).toMatchObject({ fromFrame: 0, toFrame: 6 });
    expect(positionIn(baseline)).toMatchObject({ x: 3 });
  });

  it("gets an RPC reply with no diff rather than an empty baseline", async () => {
    const rig = createRig({}, { entity: false });
    rig.world.handleRpc(7, () => "pong");

    ack(rig, 0, [new RPC({ rpcId: 7, callId: 1, params: [] })]);
    await settlePromises();
    const frames = step(rig);

    expect(frames).toHaveLength(1);
    expect(frames[0].diff).toBeUndefined();
    expect(frames[0].rpc[0]).toMatchObject({ callId: 1, params: ["pong"] });

    // The reply did not start a baseline that would hold the first entity back.
    rig.entity = rig.world.entity().add(Networked).set(Position, { x: 1, y: 1 });
    const [baseline] = step(rig);
    expect(baseline.diff).toMatchObject({ fromFrame: 0 });
  });
});

describe("a session whose view is quiet", () => {
  // The server sends nothing for an empty diff, so the client's ack stops advancing while nothing
  // changes. That is no reason to resync it: the frames that left the history held nothing.
  it.each([
    { option: undefined, window: 64 },
    { option: 8, window: 8 },
  ])(
    "is sent nothing for ten windows, then the change as a delta from its old ack ($window)",
    ({ option, window }) => {
      const rig = createRig({ historyFrames: option });
      step(rig);

      // The client keeps acking the frame it holds on every tick, as a real one does.
      expect(stepsAcking(rig, window * 10, 1)).toEqual([]);
      move(rig, 5);
      const frames = step(rig);

      expect(frames).toHaveLength(1);
      expect(frames[0].diff).toMatchObject({ fromFrame: 1, toFrame: window * 10 + 2 });
      expect(positionIn(frames[0])).toMatchObject({ x: 5 });

      // And it goes on: acked, the client is quiet again and the next change starts from there.
      ack(rig, window * 10 + 2);
      expect(stepsAcking(rig, window * 10, window * 10 + 2)).toEqual([]);
      move(rig, 6);
      const [next] = step(rig);
      expect(next.diff).toMatchObject({ fromFrame: window * 10 + 2, toFrame: window * 20 + 3 });
      expect(positionIn(next)).toMatchObject({ x: 6 });
    }
  );

  it("is not resynced by changes that come further apart than the window", () => {
    const window = 8;
    const rig = createRig({ historyFrames: window });
    const sent = [...step(rig)];
    ack(rig, 1);
    let acked = 1;

    // One change every window + 3 frames, each acked as soon as it is received.
    for (let change = 1; change <= 6; change++) {
      expect(steps(rig, window + 2)).toEqual([]);
      move(rig, change);
      const [frame] = step(rig);
      sent.push(frame);
      expect(frame.diff).toMatchObject({ fromFrame: acked, toFrame: acked + window + 3 });
      acked = frame.diff!.toFrame;
      ack(rig, acked);
    }

    expect(baselineFrames(sent)).toEqual([1]);
  });

  it("is still sent a baseline for a change that left the window unacked, quiet or not", () => {
    const window = 8;
    const rig = createRig({ historyFrames: window });
    step(rig);
    ack(rig, 1);
    move(rig, 5);
    step(rig); // frame 2: the change, which this client never acks

    // Frames 3 to window + 1 are quiet, but the client still lacks frame 2, which is in the window.
    const quiet = steps(rig, window - 1);
    expect(baselineFrames(quiet)).toEqual([]);
    expect(quiet[quiet.length - 1].diff).toMatchObject({ fromFrame: 1, toFrame: window + 1 });

    // One frame later, frame 2 has left the window with the client still lacking it.
    const [baseline] = step(rig);
    expect(baseline.diff).toMatchObject({ fromFrame: 0, toFrame: window + 2 });
    expect(positionIn(baseline)).toMatchObject({ x: 5 });
  });
});

describe("a client that stops acking", () => {
  const window = 8;

  it("is sent one baseline once a frame it lacks leaves the window, then deltas again", () => {
    const rig = createRig({ historyFrames: window });
    step(rig);
    ack(rig, 1);

    // The entity changes on every frame and nothing is acked, so frame 2 leaves the window
    // unacked after the push of frame window + 2.
    const frames = stepsMoving(rig, window + 1, 2);

    expect(baselineFrames(frames)).toEqual([window + 2]);
    frames.slice(0, -1).forEach((frame) => {
      expect(frame.diff).toMatchObject({ fromFrame: 1 });
    });

    // The baseline is in flight: nothing more until it is acked, however much changes. (Its ack
    // is awaited for 2 x 40 ms, the 100 ms floor, so two frames is within the wait.)
    expect(stepsMoving(rig, 2, 50)).toEqual([]);
    ack(rig, window + 2);
    const [delta] = stepsMoving(rig, 1, 60);
    expect(delta.diff).toMatchObject({ fromFrame: window + 2, toFrame: window + 5 });
  });

  it("is served a delta if its ack arrives just before the frame it lacked leaves the window", () => {
    const rig = createRig({ historyFrames: window });
    step(rig);
    ack(rig, 1);

    // Frames 2 to window + 1 are never acked; then the client acks frame 2, the frame that was
    // about to leave. Frame 3 is still in the window, so a delta from frame 2 is possible.
    const frames = stepsMoving(rig, window, 2);
    ack(rig, 2);
    frames.push(...stepsMoving(rig, 1, 100));

    expect(baselineFrames(frames)).toEqual([]);
    expect(frames[frames.length - 1].diff).toMatchObject({
      fromFrame: 2,
      toFrame: window + 2,
    });
  });
});

describe("a baseline presumed lost", () => {
  it("is sent again after a second when no round trip has been measured", () => {
    const rig = createRig({ historyFrames: 4 });

    const frames = steps(rig, 80);

    // Sent at t=0 (frame 1), then once more than 1000 ms have passed with no ack: the first
    // frame strictly later than t=1000 is frame 27 (t=1040), and so on every 26 frames.
    // Nothing was ever acked, so nothing could be measured, and the history window plays no part.
    expect(baselineFrames(frames)).toEqual([1, 27, 53, 79]);
  });

  it("waits that second whatever the tick rate, rather than a number of frames", () => {
    tickMs = 8; // 125 Hz
    const rig = createRig({ historyFrames: 4 });

    const frames = steps(rig, 300);

    // t=1000 is frame 126 (125 x 8 ms); the first frame strictly later is 127, then 253.
    expect(baselineFrames(frames)).toEqual([1, 127, 253]);
  });

  it("is sent again after twice the smoothed round trip once one has been measured", () => {
    const rig = createRig({ historyFrames: 4 });
    const frames = [...step(rig), ...stepsMoving(rig, 1)];
    // Frame 1 went out at t=0 and its ack arrives at t=80: a round trip of 80 ms.
    ack(rig, 1);
    frames.push(...stepsMoving(rig, 10, 2));

    // Frame 2 holds a change the client never acks. It leaves the 4-frame window at frame 6
    // (t=200), which sends a second baseline. That is presumed lost once 2 x 80 ms = 160 ms have
    // passed without an ack: the first frame strictly later than t=360 is frame 11 (t=400).
    expect(baselineFrames(frames)).toEqual([1, 6, 11]);
  });

  it("waits at least 100 ms however short the round trip is", () => {
    const rig = createRig({ historyFrames: 4 });
    const frames = step(rig);
    // A 40 ms round trip, so twice it is only 80 ms.
    ack(rig, 1);
    frames.push(...stepsMoving(rig, 10));

    // Second baseline at frame 6 (t=200); strictly more than 100 ms later is frame 9 (t=320).
    expect(baselineFrames(frames)).toEqual([1, 6, 9]);
  });

  it("is sent again at that pace, not every frame, and does not back off", () => {
    const rig = createRig({ historyFrames: 8 });

    const frames = steps(rig, 200);

    // A baseline that is never acked is offered again every 26 frames (1040 ms), however many
    // times it has gone unanswered: recovering a baseline the link lost sooner matters more
    // than the rebuilds an ack path that stays dead costs.
    const sentAt = baselineFrames(frames);
    expect(sentAt).toEqual([1, 27, 53, 79, 105, 131, 157, 183]);
  });

  it("carries the whole view as it is now, including what changed while it was lost", () => {
    const rig = createRig({ historyFrames: 4 });
    const [first] = step(rig);
    move(rig, 11);
    const retried = steps(rig, 26);

    expect(positionIn(first)).toMatchObject({ x: 0 });
    expect(retried).toHaveLength(1);
    expect(retried[0].diff).toMatchObject({ fromFrame: 0, toFrame: 27 });
    expect(positionIn(retried[0])).toMatchObject({ x: 11 });
  });

  it("is not released by a late ack of the baseline it replaced", () => {
    const rig = createRig({ historyFrames: 4 });
    const frames = steps(rig, 27);
    expect(baselineFrames(frames)).toEqual([1, 27]);

    // The first baseline was only late: its ack is older than the baseline now in flight.
    ack(rig, 1);
    move(rig, 2);
    expect(steps(rig, 3)).toEqual([]);

    ack(rig, 27);
    const [delta] = step(rig);
    expect(delta.diff).toMatchObject({ fromFrame: 27, toFrame: 31 });
    expect(positionIn(delta)).toMatchObject({ x: 2 });
  });
});

describe("a round trip longer than the history window", () => {
  // 20 frames of ack lag against a 4-frame window: the window lasts 160 ms, the round trip 800 ms.
  // The estimator remembers send times for 256 frames, whatever the window, so it can still
  // measure it, and the baseline is waited for as long as that takes instead of being re-sent
  // every few frames.
  it("measures it, and waits for each baseline as long as it takes", () => {
    const rig = createRig({ historyFrames: 4 });
    const frames = step(rig);
    frames.push(...stepsMoving(rig, 19)); // frames 2..20, t=40..760: B1 is still in flight

    // B1's ack arrives 800 ms after it was sent: a measured round trip of 800 ms. Its content
    // frames have left the 4-frame window by then, so B2 follows at once.
    ack(rig, 1);
    frames.push(...stepsMoving(rig, 1, 20)); // frame 21, t=800
    expect(baselineFrames(frames)).toEqual([1, 21]);

    // B2's ack takes another 800 ms. The world has gone quiet, so nothing is sent while it
    // travels, and nothing is sent once it arrives either.
    frames.push(...steps(rig, 19)); // frames 22..40, t=840..1560
    ack(rig, 21);
    frames.push(...steps(rig, 60));

    expect(baselineFrames(frames)).toEqual([1, 21]);
  });

  it("presumes a baseline lost after twice the measured round trip, not sooner", () => {
    const rig = createRig({ historyFrames: 4 });
    const frames = step(rig);
    frames.push(...stepsMoving(rig, 19));
    ack(rig, 1); // 800 ms
    frames.push(...stepsMoving(rig, 90, 20)); // frames 21..110, t=800..4360

    // B2 at frame 21 (t=800), presumed lost at 2 x 800 = 1600 ms: the first frame strictly later
    // than t=2400 is frame 62 (t=2440). The world keeps changing, so B2's own frame, which the
    // client never acks, sends B3 there, and the next presumption falls at frame 103.
    expect(baselineFrames(frames)).toEqual([1, 21, 62, 103]);
  });
});

describe("a stalled client whose view emptied", () => {
  it("is sent an empty baseline, which is what clears the entities it still holds", () => {
    const rig = createRig({ historyFrames: 4 });
    step(rig);
    ack(rig, 1);
    const entity = rig.entity!;

    // The client stalls: it never sees frame 2, where the only entity it holds is destroyed.
    entity.destroy();
    const frames = steps(rig, 5);

    // Frame 2 leaves the 4-frame window at frame 6, with the client still lacking it, and the
    // view is empty: there is nothing to send but the order to forget everything.
    const baselines = frames.filter(isBaseline);
    expect(baselines).toHaveLength(1);
    expect(baselines[0].diff).toMatchObject({
      fromFrame: 0,
      toFrame: 6,
      snapshots: [],
      removed: [],
    });
  });

  it("goes quiet once the client has acked it", () => {
    const rig = createRig({ historyFrames: 4 });
    step(rig);
    ack(rig, 1);
    rig.entity!.destroy();
    steps(rig, 5);

    ack(rig, 6);

    expect(steps(rig, 30)).toEqual([]);
  });

  it("is not sent to a client that never acked a baseline, which holds nothing to clear", () => {
    const rig = createRig({ historyFrames: 4 });
    step(rig);
    // The baseline is in flight and presumed lost; meanwhile the entity is destroyed.
    rig.entity!.destroy();

    // Past the presumption timeout the view is empty, and nothing is sent.
    expect(baselineFrames(steps(rig, 60))).toEqual([]);
  });
});
