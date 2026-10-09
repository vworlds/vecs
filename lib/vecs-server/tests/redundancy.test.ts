import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Client2Server,
  ComponentSnapshot,
  Server2Client,
  type VecsSocket,
  type VecsSocketListener,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, wireType } from "@vworlds/vecs-wire";
import type { Entity } from "@vworlds/vecs";
import {
  NetworkClient,
  Networked,
  ServerWorld,
  View,
  type ServerWorldOptions,
} from "../src/index.js";

// The optimistic base (`ServerWorldOptions.redundancyFrames`): a healthy session is sent each frame as
// a delta from `max(ack, min(frame - R, sentFrame))` instead of from its ack, marked optimistic when
// that is past the ack; a gap report or an overdue ack drops it back to deltas from the ack until the
// client has caught up. Time is mocked, so a round trip is whatever the test says it is.

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

/** Deliver a client message to the server at the current time. */
function ack(rig: Rig, ackFrame: number, gap = false): void {
  const encoder = new Encoder(new Uint8Array(64 * 1024));
  encoder.write(new Client2Server({ ackFrame, gap }));
  rig.socket.receive(encoder.getBuffer());
  rig.acked = Math.max(rig.acked, ackFrame);
}

/**
 * Run one frame for a client whose acks trail by {@link LAG} frames: `change` happens first, then
 * the frame is sent, then the newest frame the client has received that is at least `LAG + 1` frame
 * times old is acked. `lost` frames never reach the client, so it never acks them.
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
 * to 6 held nothing and were not sent. The next frame is 7.
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

/** The entities that have a snapshot in the frame. */
function eidsIn(frame: Server2Client): number[] {
  return frame.diff!.snapshots.map(
    (snapshot) => new Decoder(snapshot.bytes).read(ComponentSnapshot).eid
  );
}

function xOf(frame: Server2Client, eid: number): number | undefined {
  for (const snapshot of frame.diff!.snapshots) {
    const decoded = new Decoder(snapshot.bytes).read(ComponentSnapshot);
    if (decoded.eid === eid) {
      return new Decoder(decoded.payload).read(Position).x;
    }
  }
  return undefined;
}

describe("redundancyFrames", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 64, 65])(
    "rejects %s with the default history window of 64, since it is not an integer in [1, 63]",
    (value) => {
      expect(() => new ServerWorld({ redundancyFrames: value })).toThrow(
        /redundancyFrames must be an integer of at least 1 and less than historyFrames \(64\)/
      );
    }
  );

  it("must be less than the history window it works in", () => {
    expect(() => new ServerWorld({ historyFrames: 8, redundancyFrames: 8 })).toThrow(
      /less than historyFrames \(8\), got 8/
    );
    expect(() => new ServerWorld({ historyFrames: 8, redundancyFrames: 7 })).not.toThrow();
    expect(() => new ServerWorld({ historyFrames: 2, redundancyFrames: 1 })).not.toThrow();
  });

  it("is off when unset, and accepts 1 and the largest allowed value", () => {
    expect(() => new ServerWorld({})).not.toThrow();
    expect(() => new ServerWorld({ redundancyFrames: undefined })).not.toThrow();
    expect(() => new ServerWorld({ redundancyFrames: 1 })).not.toThrow();
    expect(() => new ServerWorld({ redundancyFrames: 63 })).not.toThrow();
  });
});

describe("the base of a healthy session's delta", () => {
  // The entity moves in every frame and the client's acks trail by LAG frames, so the ack is always
  // far behind. Frame 7 is the first after the baseline's ack: the baseline is the only thing the
  // client holds, so it is a plain delta from it. From frame 8 on the base is frame - R.
  it.each([1, 2, 3])(
    "starts %i frame(s) before the frame being sent, as long as that is past the ack",
    (redundancy) => {
      const rig = connect({ redundancyFrames: redundancy });
      const frames: Server2Client[] = [];
      for (let x = 1; x <= 8; x++) {
        frames.push(...advance(rig, () => move(rig.entity, x)));
      }

      expect(frames.map(toFrameOf)).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
      expect(frames.map(fromFrameOf)).toEqual([
        1,
        ...[8, 9, 10, 11, 12, 13, 14].map((frame) => frame - redundancy),
      ]);
      expect(frames.map((frame) => frame.optimistic)).toEqual([
        false,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ]);
    }
  );

  it.each([1, 2, 3])(
    "sends a change in exactly %i frame(s), however far behind the ack is",
    (R) => {
      const rig = connect({ redundancyFrames: R });
      const carrying: number[] = [];
      for (let frame = 7; frame <= 20; frame++) {
        const [sent] = advance(rig, () => {
          move(rig.entity, frame);
          if (frame === 12) {
            move(rig.other, 777);
          }
        });
        if (eidsIn(sent).includes(rig.other.eid)) {
          carrying.push(toFrameOf(sent));
          expect(xOf(sent, rig.other.eid)).toBe(777);
        }
      }

      // The frame the change was made in, and the R - 1 after it.
      expect(carrying).toEqual(Array.from({ length: R }, (_, i) => 12 + i));
    }
  );

  it("sends nothing once a change has left the redundancy window, as it sends nothing for an empty delta without the option", () => {
    const rig = connect({ redundancyFrames: 2 });
    const [first] = advance(rig, () => move(rig.entity, 5));
    const [second] = advance(rig);

    expect([first, second].map(toFrameOf)).toEqual([7, 8]);
    expect(xOf(second, rig.entity.eid)).toBe(5);
    expect(advanceQuietly(rig, 3)).toEqual([]);
  });

  it("never starts past an ack that is up to date, which leaves nothing to presume", () => {
    // The client acks every frame as soon as it is sent: one frame time of lag.
    const rig = createRig({ redundancyFrames: 2 });
    step(rig);
    ack(rig, 1);
    const frames: Server2Client[] = [];
    for (let x = 1; x <= 5; x++) {
      move(rig.entity, x);
      const [frame] = step(rig);
      frames.push(frame);
      ack(rig, toFrameOf(frame));
    }

    expect(frames.map(fromFrameOf)).toEqual([1, 2, 3, 4, 5]);
    expect(frames.map((frame) => frame.optimistic)).toEqual([false, false, false, false, false]);
  });

  it("does not start past the last frame that sent anything, so a quiet stretch is not a gap", () => {
    // R = 1 is the most exposed: its base is always the frame before. The entity moves in frame 7,
    // nothing happens for four frames, and it moves again in frame 12, before frame 7 is acked.
    const rig = connect({ redundancyFrames: 1 });
    const [first] = advance(rig, () => move(rig.entity, 1));
    expect(advanceQuietly(rig, 4)).toEqual([]);
    expect(rig.acked).toBe(1);
    const [second] = advance(rig, () => move(rig.entity, 2));

    expect(first.diff).toMatchObject({ fromFrame: 1, toFrame: 7 });
    // A base of 11 would name a frame the client never received. It holds frame 7.
    expect(second.diff).toMatchObject({ fromFrame: 7, toFrame: 12 });
    expect(second.optimistic).toBe(true);
    expect(xOf(second, rig.entity.eid)).toBe(2);
  });

  it("starts a quiet view's first change from its ack, unmarked, once the older frames were acked", () => {
    const rig = connect({ redundancyFrames: 2 });
    // The change goes out in frames 7 and 8, so the newest frame sent is 8.
    advance(rig, () => move(rig.entity, 1));
    advanceQuietly(rig, 8);
    expect(rig.acked).toBe(8);
    const [change] = advance(rig, () => move(rig.entity, 2));

    expect(change.diff).toMatchObject({ fromFrame: 8, toFrame: 16 });
    expect(change.optimistic).toBe(false);
  });
});

describe("a session that is not healthy", () => {
  it("is never sent an optimistic delta while its first baseline is in flight", () => {
    const rig = createRig({ redundancyFrames: 2 });
    const frames: Server2Client[] = [];
    for (let x = 1; x <= 10; x++) {
      move(rig.entity, x);
      frames.push(...step(rig));
    }

    // Only the baseline: the server sends no state while it is awaited.
    expect(frames).toHaveLength(1);
    expect(frames[0].diff).toMatchObject({ fromFrame: 0, toFrame: 1 });
    expect(frames[0].optimistic).toBe(false);
  });

  it("ends the wait with a delta from the baseline's ack that carries everything withheld meanwhile", () => {
    const rig = createRig({ redundancyFrames: 2 });
    const spawned: Entity[] = [];
    advance(rig);
    for (let frame = 2; frame <= LAG + 1; frame++) {
      expect(
        advance(rig, () => {
          move(rig.entity, frame);
          if (frame === 3) {
            spawned.push(rig.world.entity().add(Networked).set(Position, { x: 9, y: 0 }));
          }
        })
      ).toEqual([]);
    }
    expect(rig.acked).toBe(1);

    // Frame 7 is next. A base of 5 would hold back everything that changed in frames 2 to 4.
    const [delta] = advance(rig, () => move(rig.entity, 7));

    expect(delta.diff).toMatchObject({ fromFrame: 1, toFrame: 7 });
    expect(delta.optimistic).toBe(false);
    expect(eidsIn(delta).sort()).toEqual([rig.entity.eid, spawned[0].eid].sort());
    expect(xOf(delta, rig.entity.eid)).toBe(7);
  });

  it("is optimistic again from the very next frame, which presumes the delta that ended the wait", () => {
    const rig = connect({ redundancyFrames: 2 });
    const [catchUp, next, afterThat] = [7, 8, 9].map(
      (x) => advance(rig, () => move(rig.entity, x))[0]
    );

    expect(catchUp.diff).toMatchObject({ fromFrame: 1, toFrame: 7 });
    expect(catchUp.optimistic).toBe(false);
    expect(next.diff).toMatchObject({ fromFrame: 6, toFrame: 8 });
    expect(next.optimistic).toBe(true);
    expect(afterThat.diff).toMatchObject({ fromFrame: 7, toFrame: 9 });
  });

  it("is sent a baseline again, not an optimistic delta, once frames it has not acked leave the history", () => {
    const rig = connect({ redundancyFrames: 2, historyFrames: 8 });
    // The ack stays at 1: from here on the client receives nothing.
    const frames: Server2Client[] = [];
    for (let x = 1; x <= 10; x++) {
      frames.push(...advance(rig, () => move(rig.entity, x), true));
    }

    // Frame 7, the first with content, leaves the 8-frame window as frame 15 is pushed.
    const baselines = frames.filter((frame) => fromFrameOf(frame) === 0);
    expect(baselines.map(toFrameOf)).toEqual([15]);
    expect(baselines[0].optimistic).toBe(false);
    // No state follows the baseline while it is awaited.
    expect(frames.filter((frame) => toFrameOf(frame) > 15)).toEqual([]);
    expect(frames.slice(0, -2).every((frame) => fromFrameOf(frame) > 0)).toBe(true);
  });
});

describe("a gap report", () => {
  /** Frames 7 to 12 go out, each with a move; the client received them all. */
  function reportAfterSixFrames(options: ServerWorldOptions = { redundancyFrames: 2 }): Rig {
    const rig = connect(options);
    for (let x = 7; x <= 12; x++) {
      advance(rig, () => move(rig.entity, x));
    }
    expect(rig.acked).toBe(7);
    return rig;
  }

  it("drops the session to deltas from its ack until the client has caught up, then restores the optimism", () => {
    const rig = reportAfterSixFrames();
    ack(rig, rig.acked, true);

    // The fallback begins at frame 13, the next frame, and lasts until the ack reaches it. The ack
    // of frame 13 is sent LAG + 1 frame times after it, so frame 18 is the last that falls back.
    const frames: Server2Client[] = [];
    for (let frame = 13; frame <= 20; frame++) {
      frames.push(...advance(rig, () => move(rig.entity, frame)));
    }

    expect(frames.map(toFrameOf)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
    expect(frames.map(fromFrameOf)).toEqual([7, 8, 9, 10, 11, 12, 17, 18]);
    expect(frames.map((frame) => frame.optimistic)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("is not extended by repeats while the fallback runs", () => {
    const rig = reportAfterSixFrames();
    ack(rig, rig.acked, true);
    const frames: Server2Client[] = [];
    for (let frame = 13; frame <= 19; frame++) {
      frames.push(...advance(rig, () => move(rig.entity, frame)));
      // The client reports again before it has seen a frame of the fallback, once per ack.
      if (frame < 16) {
        ack(rig, rig.acked, true);
      }
    }

    // It still ends when the ack reaches frame 13, as the first report set it.
    expect(frames.map((frame) => frame.optimistic)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("is a no-op with nothing unacked, so the next change does not wait for a fallback frame to be acked", () => {
    const rig = connect({ redundancyFrames: 2 });
    advance(rig, () => move(rig.entity, 1));
    advanceQuietly(rig, 8);
    expect(rig.acked).toBe(8);
    advanceQuietly(rig, 2);

    // A late report about a gap that closed long ago: nothing to resend, so the frame the fallback
    // begins at (18) sends nothing, and the ack, which only follows frames that were sent, never
    // reaches it.
    ack(rig, rig.acked, true);
    expect(advance(rig)).toEqual([]);
    const [first] = advance(rig, () => move(rig.entity, 2));
    const [second] = advance(rig, () => move(rig.entity, 3));

    // The first change goes out from the ack, as it has nothing newer to presume. The second repeats
    // the first, so the fallback is over: it starts one redundancy window back, not at the ack.
    expect(first.diff).toMatchObject({ fromFrame: 8, toFrame: 19 });
    expect(first.optimistic).toBe(false);
    expect(second.diff).toMatchObject({ fromFrame: 18, toFrame: 20 });
    expect(second.optimistic).toBe(true);
  });

  it("changes nothing while the session's baseline is in flight, since the client resets on it", () => {
    const rig = createRig({ redundancyFrames: 2 });
    advance(rig);
    ack(rig, 0, true);
    advanceQuietly(rig, LAG);
    expect(rig.acked).toBe(1);

    const [catchUp, next] = [7, 8].map((x) => advance(rig, () => move(rig.entity, x))[0]);

    expect(catchUp.diff).toMatchObject({ fromFrame: 1, toFrame: 7 });
    expect(next.diff).toMatchObject({ fromFrame: 6, toFrame: 8 });
    expect(next.optimistic).toBe(true);
  });

  it("is ignored when redundancyFrames is unset", () => {
    const run = (gap: boolean): Uint8Array[] => {
      const rig = connect({});
      for (let x = 7; x <= 14; x++) {
        advance(rig, () => move(rig.entity, x));
        ack(rig, rig.acked, gap);
      }
      return rig.socket.sent;
    };

    expect(run(true)).toEqual(run(false));
  });
});

describe("an ack that is overdue", () => {
  // The smoothed round trip is 240 ms, so a frame may go unacked for 480 ms before it is presumed
  // lost. The entity moves in frame 7 (t = 240 ms) and nothing else ever changes. The client never
  // receives the change, so it never acks it and never learns of it: there is no later frame to show
  // it a gap.
  const RTO_MS = 2 * (LAG + 1) * TICK_MS;

  function lostChange(): { rig: Rig; sentAtMs: number } {
    const rig = connect({ redundancyFrames: 2 });
    const sentAtMs = nowMs;
    expect(advance(rig, () => move(rig.entity, 7), true)).toHaveLength(1);
    expect(advance(rig, undefined, true)).toHaveLength(1);
    return { rig, sentAtMs };
  }

  it("sends the change again from the ack, unmarked, as soon as it has gone unacked for longer than the timeout", () => {
    const { rig, sentAtMs } = lostChange();

    let resent: { frame: Server2Client; atMs: number } | undefined;
    while (resent === undefined && nowMs <= sentAtMs + 3 * RTO_MS) {
      const atMs = nowMs;
      const [frame] = advance(rig, undefined, true);
      resent = frame === undefined ? undefined : { frame, atMs };
    }

    // Not before the timeout, and within a frame of it.
    expect(resent).toBeDefined();
    expect(resent!.atMs - sentAtMs).toBeGreaterThan(RTO_MS);
    expect(resent!.atMs - sentAtMs).toBeLessThanOrEqual(RTO_MS + TICK_MS);
    expect(resent!.frame.diff).toMatchObject({ fromFrame: 1 });
    expect(resent!.frame.optimistic).toBe(false);
    expect(xOf(resent!.frame, rig.entity.eid)).toBe(7);
  });

  it("keeps sending from the ack until the client acks, as the fallback does", () => {
    const { rig } = lostChange();
    let resent: Server2Client | undefined;
    while (resent === undefined) {
      [resent] = advance(rig, undefined, true);
    }

    const [next] = advance(rig, () => move(rig.entity, 8), true);

    expect(next.diff).toMatchObject({ fromFrame: 1, toFrame: toFrameOf(resent) + 1 });
    expect(next.optimistic).toBe(false);
  });

  it("is not triggered while acks keep arriving within the timeout", () => {
    const rig = connect({ redundancyFrames: 2 });
    const frames: Server2Client[] = [];
    for (let x = 7; x <= 60; x++) {
      frames.push(...advance(rig, () => move(rig.entity, x)));
    }

    // Past the catch-up, every delta starts one redundancy window back, never at the lagging ack.
    expect(frames).toHaveLength(54);
    expect(frames.slice(1).every((frame) => frame.optimistic)).toBe(true);
    expect(frames.slice(1).every((frame) => toFrameOf(frame) - fromFrameOf(frame) === 2)).toBe(
      true
    );
  });
});

describe("an unset redundancyFrames", () => {
  // The sha256 of every byte the server sent on the script below, recorded from the code before the
  // option existed (commit 53bd300): the wire must stay byte for byte what it was.
  const PINNED_SHA256 = "afa075eb96027651e14d44602011d59fe528ea20170de28fc60d6c419eee1b3e";

  /** A lagging, lossy client: acks trail by four frames, every fifth never arrives, one reports a gap. */
  function script(options: ServerWorldOptions): string {
    const rig = createRig(options);
    const sentFrames: number[] = [];
    for (let frame = 1; frame <= 60; frame++) {
      if (frame % 3 !== 0) {
        move(rig.entity, frame);
      }
      if (frame % 7 === 0) {
        move(rig.other, frame * 2);
      }
      if (frame === 40) {
        rig.other.destroy();
      }
      for (const message of step(rig)) {
        sentFrames.push(message.diff?.toFrame ?? 0);
      }
      const newest = sentFrames.length > 4 ? sentFrames[sentFrames.length - 5] : 0;
      if (frame % 5 !== 0) {
        ack(rig, newest, frame === 30);
      }
    }
    const hash = createHash("sha256");
    rig.socket.sent.forEach((bytes) => hash.update(bytes));
    return hash.digest("hex");
  }

  it("sends exactly the frames it sent before the option existed", () => {
    expect(script({})).toBe(PINNED_SHA256);
  });

  it("is the same as an explicit undefined", () => {
    expect(script({ redundancyFrames: undefined })).toBe(script({}));
  });

  it("never marks a frame optimistic, however far behind the ack is", () => {
    const rig = connect({});
    const frames: Server2Client[] = [];
    for (let x = 7; x <= 30; x++) {
      frames.push(...advance(rig, () => move(rig.entity, x)));
    }

    expect(frames.every((frame) => !frame.optimistic)).toBe(true);
    // Every delta starts at the ack, which trails by LAG + 1 frames in steady state.
    expect(fromFrameOf(frames[frames.length - 1])).toBe(
      toFrameOf(frames[frames.length - 1]) - (LAG + 1)
    );
  });
});
