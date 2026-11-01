import { CidLayout } from "@vworlds/vecs-protocol";
import { describe, expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import type { EID } from "@vworlds/vecs";
import {
  EncodedSnapshot,
  StateDiff,
  type EntityReset,
  type RemovedComponent,
} from "@vworlds/vecs-protocol";
import { HISTORY_LENGTH, History, validateHistoryFrames } from "../src/history.js";

const testCid = new CidLayout(256);

function diff(toFrame: number): StateDiff {
  const snapshotBytes = new Uint8Array([toFrame]);

  return new StateDiff(testCid, {
    fromFrame: toFrame - 1,
    toFrame,
    snapshots: [new EncodedSnapshot(snapshotBytes, 123, 1)],
    removed: [[toFrame, 1]],
  });
}

function snapshot(eid: EID, type: number, value = type): EncodedSnapshot {
  return new EncodedSnapshot(new Uint8Array([eid, type, value]), eid, type);
}

function stateDiff(
  toFrame: number,
  snapshots: EncodedSnapshot[] = [],
  removed: RemovedComponent[] = [],
  resets: EntityReset[] = []
): StateDiff {
  return new StateDiff(testCid, { fromFrame: toFrame - 1, toFrame, snapshots, removed, resets });
}

describe("History", () => {
  it("counts a reset-only frame as content for state bases, the pull shortcut and eviction", () => {
    const history = new History(testCid, 4, 0);
    history.push(stateDiff(1, [snapshot(123, 1)]));
    history.push(stateDiff(2, [], [], [[123, 2]]));
    history.push(stateDiff(3));
    history.push(stateDiff(4));

    expect(history.lastContentFrame).toBe(2);
    expect(history.pull(1, 4)).toEqual(
      new StateDiff(testCid, { fromFrame: 1, toFrame: 4, resets: [[123, 2]] })
    );
    expect(history.pull(2, 4)).toEqual(new StateDiff(testCid, { fromFrame: 2, toFrame: 4 }));
    history.push(stateDiff(5));
    expect(history.canPullAfterPush(1)).toBe(false);
    history.push(stateDiff(6));
    expect(history.evictedContentFrame).toBe(2);
    expect(() => history.pull(1, 6)).toThrow("outside history window");
  });

  it("retains 64 frames by default, about two seconds at 30 Hz", () => {
    expect(HISTORY_LENGTH).toBe(64);
    expect(new History(testCid).oldestFrame).toBe(-1 - 64 + 1);
  });

  it("starts primed with empty negative frames", () => {
    const history = new History(testCid);

    expect(history.lastFrame).toBe(-1);
    expect(history.oldestFrame).toBe(-HISTORY_LENGTH);
    for (let frame = -1; frame >= -HISTORY_LENGTH; frame--) {
      expect(history.get(frame)).toMatchObject({
        fromFrame: frame - 1,
        toFrame: frame,
        snapshots: [],
        removed: [],
      });
    }
  });

  it("pushes frame 0 first and drops the oldest primed frame", () => {
    const history = new History(testCid);
    const frame0 = diff(0);

    history.push(frame0);

    expect(history.lastFrame).toBe(0);
    expect(history.oldestFrame).toBe(-HISTORY_LENGTH + 1);
    expect(history.get(0)).toBe(frame0);
    expect(() => history.get(-HISTORY_LENGTH)).toThrow("outside history window");
  });

  it("starts from a provided last frame for late sessions", () => {
    const history = new History(testCid, HISTORY_LENGTH, 9);
    const frame10 = diff(10);
    const oldest = 9 - HISTORY_LENGTH + 1;

    expect(history.lastFrame).toBe(9);
    expect(history.oldestFrame).toBe(oldest);
    for (let frame = oldest; frame <= 9; frame++) {
      expect(history.get(frame)).toMatchObject({
        fromFrame: frame - 1,
        toFrame: frame,
        snapshots: [],
        removed: [],
      });
    }

    history.push(frame10);

    expect(history.lastFrame).toBe(10);
    expect(history.get(10)).toBe(frame10);
    expect(() => history.push(diff(12))).toThrow("Expected frame 11, got 12");
  });

  it("keeps only the latest frames in the circular buffer", () => {
    const history = new History(testCid, 5);
    const frames: StateDiff[] = [];

    for (let frame = 0; frame <= 20; frame++) {
      const next = diff(frame);
      frames.push(next);
      history.push(next);
    }

    expect(history.lastFrame).toBe(20);
    expect(history.oldestFrame).toBe(16);
    for (let frame = 16; frame <= 20; frame++) {
      expect(history.get(frame)).toBe(frames[frame]);
    }
    expect(() => history.get(15)).toThrow("outside history window");
    expect(() => history.get(21)).toThrow("outside history window");
  });

  it("rejects non-sequential pushes", () => {
    const history = new History(testCid);

    expect(() => history.push(diff(1))).toThrow("Expected frame 0, got 1");
    history.push(diff(0));
    expect(() => history.push(diff(2))).toThrow("Expected frame 1, got 2");
  });

  it("pulls a single frame by returning the indexed diff", () => {
    const history = new History(testCid);
    const frame0 = stateDiff(0, [snapshot(1, 1)]);

    history.push(frame0);

    expect(history.pull(-1, 0)).toBe(frame0);
  });

  it("pulls a forged diff with the requested frame range", () => {
    const history = new History(testCid);
    history.push(stateDiff(0, [snapshot(1, 1)]));
    history.push(stateDiff(1, [snapshot(2, 1)]));
    history.push(stateDiff(2, [snapshot(3, 1)]));

    const pulled = history.pull(0, 2);

    expect(pulled.fromFrame).toBe(0);
    expect(pulled.toFrame).toBe(2);
    expect(pulled.snapshots).toEqual([snapshot(2, 1), snapshot(3, 1)]);
    expect(pulled.removed).toEqual([]);
  });

  it("lets snapshots and removals for a component cancel each other", () => {
    const history = new History(testCid);
    const firstPosition = snapshot(1, 1, 10);
    const latestPosition = snapshot(1, 1, 20);

    history.push(stateDiff(0, [firstPosition]));
    history.push(stateDiff(1, [], [[1, 1]]));
    history.push(stateDiff(2, [latestPosition]));

    const pulledAfterReadd = history.pull(-1, 2);
    expect(pulledAfterReadd.snapshots).toEqual([latestPosition]);
    expect(pulledAfterReadd.removed).toEqual([]);

    history.push(stateDiff(3, [], [[1, 1]]));

    const pulledAfterRemove = history.pull(-1, 3);
    expect(pulledAfterRemove.snapshots).toEqual([]);
    expect(pulledAfterRemove.removed).toEqual([[1, 1]]);
  });

  describe("an entity reset within the span", () => {
    it("is pulled as a reset at its frame, with the snapshots that follow it", () => {
      const history = new History(testCid);
      const latestPosition = snapshot(1, 1, 20);

      history.push(stateDiff(0, [snapshot(1, 1, 10)]));
      history.push(stateDiff(1, [], [], [[1, 1]]));
      history.push(stateDiff(2, [latestPosition]));

      const pulled = history.pull(-1, 2);

      expect(pulled.snapshots).toEqual([latestPosition]);
      expect(pulled.resets).toEqual([[1, 1]]);
      expect(pulled.removed).toEqual([]);
    });

    it("keeps nothing of the removed entity: the snapshots before the reset are gone", () => {
      const history = new History(testCid);

      history.push(stateDiff(0, [snapshot(1, 1, 10), snapshot(1, 2, 10)]));
      history.push(stateDiff(1, [], [], [[1, 1]]));
      history.push(stateDiff(2, [snapshot(1, 1, 20)]));

      const pulled = history.pull(-1, 2);

      expect(pulled.snapshots).toEqual([snapshot(1, 1, 20)]);
      expect(pulled.resets).toEqual([[1, 1]]);
    });

    it("is also a reset when the reset and the snapshots share one frame's diff", () => {
      const history = new History(testCid);

      history.push(stateDiff(0, [snapshot(1, 1, 10), snapshot(1, 2, 10)]));
      history.push(stateDiff(1, [snapshot(1, 1, 20)], [], [[1, 1]]));
      history.push(stateDiff(2, [snapshot(2, 1, 5)]));

      const pulled = history.pull(-1, 2);

      expect(pulled.snapshots).toEqual([snapshot(1, 1, 20), snapshot(2, 1, 5)]);
      expect(pulled.resets).toEqual([[1, 1]]);
    });

    it("applies a frame's reset before its snapshots, not after", () => {
      const history = new History(testCid);

      history.push(stateDiff(0, [snapshot(1, 1, 10)]));
      history.push(stateDiff(1, [snapshot(1, 2, 5)], [], [[1, 1]]));

      const pulled = history.pull(-1, 1);

      // The snapshot the reset's own frame carries survives it: it is the new entity's.
      expect(pulled.snapshots).toEqual([snapshot(1, 2, 5)]);
      expect(pulled.resets).toEqual([[1, 1]]);
    });

    it("keeps the removal of a component after the reset, so a client that skipped the reset applies it", () => {
      const history = new History(testCid);

      history.push(stateDiff(0, [snapshot(1, 1, 10), snapshot(1, 2, 10)]));
      history.push(stateDiff(1, [], [], [[1, 1]]));
      history.push(stateDiff(2, [snapshot(1, 1, 20), snapshot(1, 2, 20)]));
      history.push(stateDiff(3, [], [[1, 2]]));

      const pulled = history.pull(-1, 3);

      expect(pulled.snapshots).toEqual([snapshot(1, 1, 20)]);
      expect(pulled.removed).toEqual([[1, 2]]);
      expect(pulled.resets).toEqual([[1, 1]]);
    });

    it("keeps the removal of a component that was never snapshotted after the reset", () => {
      const history = new History(testCid);

      history.push(stateDiff(0, [snapshot(1, 1, 10), snapshot(1, 2, 10)]));
      history.push(stateDiff(1, [], [], [[1, 1]]));
      history.push(stateDiff(2, [], [[1, 2]]));

      const pulled = history.pull(-1, 2);

      expect(pulled.snapshots).toEqual([]);
      expect(pulled.removed).toEqual([[1, 2]]);
      expect(pulled.resets).toEqual([[1, 1]]);
    });

    it("drops the removals of single components that precede the reset", () => {
      const history = new History(testCid);

      history.push(stateDiff(0, [snapshot(1, 1), snapshot(1, 2)]));
      history.push(stateDiff(1, [], [[1, 3]]));
      history.push(stateDiff(2, [], [], [[1, 2]]));

      const pulled = history.pull(-1, 2);

      expect(pulled.snapshots).toEqual([]);
      expect(pulled.removed).toEqual([]);
      expect(pulled.resets).toEqual([[1, 2]]);
    });

    it("keeps only the newest reset, and what follows it, when the entity is reset again", () => {
      const history = new History(testCid);

      history.push(stateDiff(0, [snapshot(1, 1, 10)]));
      history.push(stateDiff(1, [], [], [[1, 1]]));
      history.push(stateDiff(2, [snapshot(1, 1, 20), snapshot(1, 2, 20)]));
      history.push(stateDiff(3, [], [[1, 2]]));
      history.push(stateDiff(4, [], [], [[1, 4]]));
      history.push(stateDiff(5, [snapshot(1, 3, 40)]));

      const pulled = history.pull(-1, 5);

      expect(pulled.resets).toEqual([[1, 4]]);
      expect(pulled.snapshots).toEqual([snapshot(1, 3, 40)]);
      expect(pulled.removed).toEqual([]);
    });

    it("is removed outright, with the frame of its last reset, if it is not snapshotted again", () => {
      const history = new History(testCid);

      history.push(stateDiff(0, [snapshot(1, 1, 10)]));
      history.push(stateDiff(1, [], [], [[1, 1]]));
      history.push(stateDiff(2, [snapshot(1, 1, 20)]));
      history.push(stateDiff(3, [], [], [[1, 3]]));

      const pulled = history.pull(-1, 3);

      expect(pulled.snapshots).toEqual([]);
      expect(pulled.resets).toEqual([[1, 3]]);
    });

    it("leaves the other entities of the span as they are", () => {
      const history = new History(testCid);

      history.push(stateDiff(0, [snapshot(1, 1, 10), snapshot(2, 1, 10)]));
      history.push(stateDiff(1, [snapshot(2, 1, 11)], [], [[1, 1]]));
      history.push(stateDiff(2, [snapshot(1, 1, 20)], [[3, 1]]));

      const pulled = history.pull(-1, 2);

      expect(pulled.snapshots).toEqual([snapshot(1, 1, 20), snapshot(2, 1, 11)]);
      expect(pulled.resets).toEqual([[1, 1]]);
      expect(pulled.removed).toEqual([[3, 1]]);
    });

    it("is not a reset for a span that starts after it: its snapshots are pulled alone", () => {
      const history = new History(testCid);

      history.push(stateDiff(0, [snapshot(1, 1, 10)]));
      history.push(stateDiff(1, [], [], [[1, 1]]));
      history.push(stateDiff(2, [snapshot(1, 1, 20)]));
      history.push(stateDiff(3, [snapshot(1, 2, 30)]));

      // A client that acked frame 1 has the reset already.
      const pulled = history.pull(1, 3);

      expect(pulled.snapshots).toEqual([snapshot(1, 1, 20), snapshot(1, 2, 30)]);
      expect(pulled.removed).toEqual([]);
      expect(pulled.resets).toBeUndefined();
    });

    it("repeats the same reset, with the same frame, in every span that includes it", () => {
      const history = new History(testCid);

      history.push(stateDiff(0, [snapshot(1, 1, 10)]));
      history.push(stateDiff(1, [], [], [[1, 1]]));
      history.push(stateDiff(2, [snapshot(1, 1, 20)]));
      history.push(stateDiff(3, [snapshot(1, 2, 30)]));
      history.push(stateDiff(4));

      expect(history.pull(-1, 3).resets).toEqual([[1, 1]]);
      expect(history.pull(0, 4).resets).toEqual([[1, 1]]);
      expect(history.pull(0, 3).resets).toEqual([[1, 1]]);
    });

    it("is a plain delta for an entity that was only snapshotted within the span", () => {
      const history = new History(testCid);

      history.push(stateDiff(0, [snapshot(1, 1, 10)]));
      history.push(stateDiff(1, [snapshot(1, 1, 11)]));
      history.push(stateDiff(2, [snapshot(1, 2, 12)]));

      const pulled = history.pull(-1, 2);

      expect(pulled.snapshots).toEqual([snapshot(1, 1, 11), snapshot(1, 2, 12)]);
      expect(pulled.removed).toEqual([]);
      expect(pulled.resets).toBeUndefined();
    });

    it("returns the frame's own diff, with its reset, for a single-frame pull", () => {
      const history = new History(testCid);
      const frame = stateDiff(0, [snapshot(1, 1)], [], [[1, 0]]);

      history.push(frame);

      expect(history.pull(-1, 0)).toBe(frame);
      expect(history.pull(-1, 0).resets).toEqual([[1, 0]]);
    });

    it("counts a frame that holds only a reset as content, for the window", () => {
      const history = new History(testCid, 3);
      history.push(stateDiff(0, [], [], [[1, 0]]));
      history.push(stateDiff(1));
      history.push(stateDiff(2));

      expect(history.canPullAfterPush(-1)).toBe(false);

      history.push(stateDiff(3));
      expect(history.evictedContentFrame).toBe(0);
    });
  });

  it("lets a reset cancel prior snapshots and removals for the entity", () => {
    const history = new History(testCid);

    history.push(stateDiff(0, [snapshot(1, 1), snapshot(1, 2)]));
    history.push(stateDiff(1, [], [[1, 3]]));
    history.push(stateDiff(2, [], [], [[1, 2]]));

    const pulled = history.pull(-1, 2);

    expect(pulled.snapshots).toEqual([]);
    expect(pulled.removed).toEqual([]);
    expect(pulled.resets).toEqual([[1, 2]]);
  });

  it("keeps a reset when it is followed by narrower component removals", () => {
    const history = new History(testCid);

    history.push(stateDiff(0, [snapshot(1, 1)]));
    history.push(stateDiff(1, [], [], [[1, 1]]));
    history.push(stateDiff(2, [], [[1, 1]]));

    const pulled = history.pull(-1, 2);

    expect(pulled.snapshots).toEqual([]);
    expect(pulled.resets).toEqual([[1, 1]]);
    expect(pulled.removed).toEqual([[1, 1]]);
  });

  it("can pull from the frame just before the oldest one it holds, and no further back", () => {
    const history = new History(testCid, 4);
    for (let frame = 0; frame <= 9; frame++) {
      history.push(stateDiff(frame, [snapshot(1, 1, frame)]));
    }

    // The window holds frames 6..9, which is everything a client that acked frame 5 is missing.
    expect(history.oldestFrame).toBe(6);
    const pulled = history.pull(history.oldestFrame - 1, history.lastFrame);
    expect(pulled).toMatchObject({ fromFrame: 5, toFrame: 9 });
    expect(pulled.snapshots).toEqual([snapshot(1, 1, 9)]);
    expect(() => history.pull(history.oldestFrame - 2, history.lastFrame)).toThrow(
      "outside history window"
    );
  });

  describe("the frame the state last changed", () => {
    it("is the frame the history started at until a frame with content is pushed", () => {
      const history = new History(testCid, 4, 9);
      expect(history.lastContentFrame).toBe(9);

      history.push(stateDiff(10));
      history.push(stateDiff(11));

      expect(history.lastContentFrame).toBe(9);
    });

    it("is the newest frame pushed with a snapshot or a removal, and no later empty frame moves it", () => {
      const history = new History(testCid, 4);

      history.push(stateDiff(0, [snapshot(1, 1)]));
      expect(history.lastContentFrame).toBe(0);
      history.push(stateDiff(1));
      history.push(stateDiff(2, [], [[1, 1]]));
      expect(history.lastContentFrame).toBe(2);
      history.push(stateDiff(3));
      history.push(stateDiff(4));
      expect(history.lastContentFrame).toBe(2);
      history.push(stateDiff(5, [], [], [[1, 5]]));
      expect(history.lastContentFrame).toBe(5);
    });

    it("stays when the frame that held the content leaves the window", () => {
      const history = new History(testCid, 3);
      history.push(stateDiff(0, [snapshot(1, 1)]));
      for (let frame = 1; frame <= 8; frame++) {
        history.push(stateDiff(frame));
      }

      expect(history.evictedContentFrame).toBe(0);
      expect(history.lastContentFrame).toBe(0);
    });

    it("lets a pull from it or from any later frame answer an empty delta without merging", () => {
      const history = new History(testCid, 8);
      history.push(stateDiff(0, [snapshot(1, 1)]));
      for (let frame = 1; frame <= 6; frame++) {
        history.push(stateDiff(frame));
      }

      for (const from of [0, 2, 5]) {
        const pulled = history.pull(from, 6);
        expect(pulled).toMatchObject({ fromFrame: from, toFrame: 6, snapshots: [], removed: [] });
      }
      // One frame before it still holds the change.
      expect(history.pull(-1, 6).snapshots).toEqual([snapshot(1, 1)]);
      // Pulling past the newest frame is refused, whatever the content.
      expect(() => history.pull(2, 7)).toThrow("outside history window");
    });
  });

  describe("frames that left the window", () => {
    it("remembers the newest one that left holding a snapshot or a removal", () => {
      const history = new History(testCid, 3);
      expect(history.evictedContentFrame).toBe(Number.NEGATIVE_INFINITY);

      history.push(stateDiff(0, [snapshot(1, 1)]));
      history.push(stateDiff(1));
      history.push(stateDiff(2));
      // Only the empty frames of the primed history have left so far.
      expect(history.evictedContentFrame).toBe(Number.NEGATIVE_INFINITY);

      history.push(stateDiff(3));
      expect(history.evictedContentFrame).toBe(0);

      // Frames 1..5 leave empty, so the answer does not move.
      history.push(stateDiff(4));
      history.push(stateDiff(5));
      history.push(stateDiff(6, [], [[2, 1]]));
      history.push(stateDiff(7));
      history.push(stateDiff(8));
      expect(history.evictedContentFrame).toBe(0);

      // Frame 6 holds only a removal, which counts.
      history.push(stateDiff(9));
      expect(history.evictedContentFrame).toBe(6);
    });

    it("pulls from an ack older than the window while only empty frames have left it", () => {
      const history = new History(testCid, 3);
      history.push(stateDiff(0, [snapshot(1, 1, 10)]));
      for (let frame = 1; frame <= 8; frame++) {
        history.push(stateDiff(frame));
      }
      history.push(stateDiff(9, [snapshot(2, 1, 20)]));

      // Frame 0 held something and left the window, but a client that acked it holds that.
      const pulled = history.pull(0, 9);

      expect(pulled).toMatchObject({ fromFrame: 0, toFrame: 9 });
      expect(pulled.snapshots).toEqual([snapshot(2, 1, 20)]);
      expect(pulled.removed).toEqual([]);
    });

    it("keeps the client's own frame as the start of the diff, never a later one", () => {
      const history = new History(testCid, 3);
      for (let frame = 0; frame <= 50; frame++) {
        history.push(stateDiff(frame));
      }

      const pulled = history.pull(-40, 50);

      expect(pulled).toMatchObject({ fromFrame: -40, toFrame: 50, snapshots: [], removed: [] });
    });

    it("refuses an ack older than a frame that left holding something", () => {
      const history = new History(testCid, 3);
      history.push(stateDiff(0, [snapshot(1, 1)]));
      for (let frame = 1; frame <= 8; frame++) {
        history.push(stateDiff(frame));
      }

      expect(() => history.pull(-1, 8)).toThrow("Frame 0 is outside history window");
      expect(() => history.pull(0, 8)).not.toThrow();
    });

    it("looks ahead to the frame the next push evicts", () => {
      const history = new History(testCid, 3);
      history.push(stateDiff(0, [snapshot(1, 1)]));
      history.push(stateDiff(1));
      history.push(stateDiff(2));

      // The window holds 0..2 and the next push evicts frame 0, which holds something.
      expect(history.evictedContentFrame).toBe(Number.NEGATIVE_INFINITY);
      expect(history.canPullAfterPush(-1)).toBe(false);
      expect(history.canPullAfterPush(0)).toBe(true);

      // The next push evicts frame 1, which is empty, and frame 0 has already gone.
      history.push(stateDiff(3));
      expect(history.canPullAfterPush(-1)).toBe(false);
      expect(history.canPullAfterPush(0)).toBe(true);
    });

    // The claim everything above rests on: skipping the frames that left, when they held
    // nothing, gives exactly the diff a history that kept them would. Check it against a
    // history long enough never to forget, over random sparse changes.
    it("merges to exactly what a history that kept every frame would, whenever it can", () => {
      const next = lcg(12345);
      const short = new History(testCid, 6);
      const long = new History(testCid, 500);
      const mismatches: string[] = [];
      let answerable = 0;
      let refused = 0;

      for (let frame = 0; frame < 300; frame++) {
        const content = next() < 0.12 ? randomContent(frame, next) : emptyContent(frame);
        const predicted = new Map<number, boolean>();
        for (let from = frame - 40; from < frame; from++) {
          predicted.set(from, short.canPullAfterPush(from));
        }
        short.push(content());
        long.push(content());

        for (let from = frame - 40; from < frame; from++) {
          const canPull = from >= short.evictedContentFrame;
          if (canPull !== predicted.get(from)) {
            mismatches.push(`frame ${frame}, from ${from}: the look-ahead said ${!canPull}`);
          }
          if (canPull) {
            answerable++;
            if (!isDeepStrictEqual(short.pull(from, frame), long.pull(from, frame))) {
              mismatches.push(`frame ${frame}, from ${from}: the merges differ`);
            }
          } else {
            refused++;
            try {
              short.pull(from, frame);
              mismatches.push(`frame ${frame}, from ${from}: expected a refusal`);
            } catch (error) {
              if (!String(error).includes("outside history window")) {
                mismatches.push(`frame ${frame}, from ${from}: unexpected ${String(error)}`);
              }
            }
          }
        }
      }

      expect(mismatches).toEqual([]);
      // Both outcomes were exercised, a good many times.
      expect(answerable).toBeGreaterThan(2_000);
      expect(refused).toBeGreaterThan(2_000);
    });
  });
});

/** A small deterministic generator, so the property test is the same on every run. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

type ContentFactory = () => StateDiff;

function emptyContent(frame: number): ContentFactory {
  return () => stateDiff(frame);
}

/**
 * A frame that sets, removes or resets a few components or entities. A reset carries the frame it
 * is in, as the server's does, and at most one per entity.
 */
function randomContent(frame: number, next: () => number): ContentFactory {
  const snapshots: EncodedSnapshot[] = [];
  const removed: RemovedComponent[] = [];
  const resets: EntityReset[] = [];
  const count = 1 + Math.floor(next() * 3);
  for (let i = 0; i < count; i++) {
    const eid = 1 + Math.floor(next() * 4);
    const type = 1 + Math.floor(next() * 3);
    const roll = next();
    if (roll < 0.6) {
      snapshots.push(snapshot(eid, type, frame & 0xff));
    } else if (roll < 0.9) {
      removed.push([eid, type]);
    } else if (!resets.some(([resetEid]) => resetEid === eid)) {
      resets.push([eid, frame]);
    }
  }
  return () => stateDiff(frame, snapshots, removed, resets);
}

/** What a client holds: the bytes of every component of every entity, keyed by `eid:wireType`. */
type ClientState = Map<string, string>;

/**
 * Apply a diff the way a client does, to a state that is at frame `held`: the resets newer than
 * `held` (the others were applied already), then the snapshots, then the removals.
 */
function applyDiff(state: ClientState, diff: StateDiff, held: number): ClientState {
  const next = new Map(state);
  diff.resets?.forEach(([eid, frame]) => {
    if (frame > held) {
      [...next.keys()]
        .filter((key) => key.startsWith(`${eid}:`))
        .forEach((key) => next.delete(key));
    }
  });
  diff.snapshots.forEach((s) => next.set(`${s.eid}:${s.wireType}`, [...s.bytes].join(",")));
  diff.removed.forEach(([eid, type]) => next.delete(`${eid}:${type}`));
  return next;
}

describe("a pulled delta", () => {
  // The claim History exists to keep: a delta takes a client that holds frame `from` to frame
  // `to` exactly as the frames in between would, one after the other, whatever they hold. That
  // includes frames that reset an entity and snapshot it again, in one frame or across several.
  it("takes a client to the same state as applying the frames it merges one by one", () => {
    const next = lcg(777);
    const history = new History(testCid, 400);
    const states: ClientState[] = [new Map()];
    const mismatches: string[] = [];
    let spansWithAReset = 0;

    for (let frame = 0; frame < 300; frame++) {
      const content = randomContent(frame, next)();
      history.push(content);
      states.push(applyDiff(states[states.length - 1], content, frame - 1));

      for (let from = Math.max(-1, frame - 12); from < frame; from++) {
        const pulled = history.pull(from, frame);
        const viaDelta = applyDiff(states[from + 1], pulled, from);
        const oneByOne = states[frame + 1];
        if (!isDeepStrictEqual([...viaDelta].sort(), [...oneByOne].sort())) {
          mismatches.push(`frame ${frame}, from ${from}`);
        }
        if ((pulled.resets?.length ?? 0) > 0 && pulled.snapshots.length > 0) {
          spansWithAReset++;
        }
      }
    }

    expect(mismatches).toEqual([]);
    // The random frames did reset entities and re-create them within a span.
    expect(spansWithAReset).toBeGreaterThan(300);
  });

  // A delta starts at the newest frame the server has seen acked, so a client that has applied
  // later frames than that receives a span that overlaps what it holds. Applying it must leave
  // the same state whatever frame the client holds in between: a reset the client has applied
  // already is skipped, and the snapshots and removals that follow it, which include the
  // removals after the reset, bring the entity to where it is.
  it("takes a client that holds any later frame to the same state, skipping the resets it has applied", () => {
    const next = lcg(4242);
    const history = new History(testCid, 400);
    const states: ClientState[] = [new Map()];
    const mismatches: string[] = [];
    let skipped = 0;
    let applied = 0;

    for (let frame = 0; frame < 300; frame++) {
      const content = randomContent(frame, next)();
      history.push(content);
      states.push(applyDiff(states[states.length - 1], content, frame - 1));

      for (let from = Math.max(-1, frame - 10); from < frame; from++) {
        const pulled = history.pull(from, frame);
        for (let held = from; held < frame; held++) {
          const viaDelta = applyDiff(states[held + 1], pulled, held);
          if (!isDeepStrictEqual([...viaDelta].sort(), [...states[frame + 1]].sort())) {
            mismatches.push(`frame ${frame}, acked ${from}, held ${held}`);
          }
          pulled.resets?.forEach(([, resetFrame]) => {
            if (resetFrame > held) {
              applied++;
            } else {
              skipped++;
            }
          });
        }
      }
    }

    expect(mismatches).toEqual([]);
    // Both outcomes were exercised, a good many times.
    expect(skipped).toBeGreaterThan(500);
    expect(applied).toBeGreaterThan(500);
  });
});

describe("validateHistoryFrames", () => {
  it.each([2, 3, 32, 1000])("accepts %i and returns it", (frames) => {
    expect(validateHistoryFrames(frames)).toBe(frames);
  });

  it.each([1, 0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects %s",
    (frames) => {
      expect(() => validateHistoryFrames(frames)).toThrow(
        `historyFrames must be an integer of at least 2, got ${String(frames)}`
      );
    }
  );
});
