import { describe, expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import type { EID } from "@vworlds/vecs";
import {
  ALL_COMPONENTS,
  EncodedSnapshot,
  StateDiff,
  type RemovedComponent,
} from "@vworlds/vecs-protocol";
import { HISTORY_LENGTH, History, validateHistoryFrames } from "../src/history.js";

function diff(toFrame: number): StateDiff {
  const snapshotBytes = new Uint8Array([toFrame]);

  return new StateDiff({
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
  removed: RemovedComponent[] = []
): StateDiff {
  return new StateDiff({ fromFrame: toFrame - 1, toFrame, snapshots, removed });
}

describe("History", () => {
  it("retains 64 frames by default, about two seconds at 30 Hz", () => {
    expect(HISTORY_LENGTH).toBe(64);
    expect(new History().oldestFrame).toBe(-1 - 64 + 1);
  });

  it("starts primed with empty negative frames", () => {
    const history = new History();

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
    const history = new History();
    const frame0 = diff(0);

    history.push(frame0);

    expect(history.lastFrame).toBe(0);
    expect(history.oldestFrame).toBe(-HISTORY_LENGTH + 1);
    expect(history.get(0)).toBe(frame0);
    expect(() => history.get(-HISTORY_LENGTH)).toThrow("outside history window");
  });

  it("starts from a provided last frame for late sessions", () => {
    const history = new History(HISTORY_LENGTH, 9);
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
    const history = new History(5);
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
    const history = new History();

    expect(() => history.push(diff(1))).toThrow("Expected frame 0, got 1");
    history.push(diff(0));
    expect(() => history.push(diff(2))).toThrow("Expected frame 1, got 2");
  });

  it("pulls a single frame by returning the indexed diff", () => {
    const history = new History();
    const frame0 = stateDiff(0, [snapshot(1, 1)]);

    history.push(frame0);

    expect(history.pull(-1, 0)).toBe(frame0);
  });

  it("pulls a forged diff with the requested frame range", () => {
    const history = new History();
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
    const history = new History();
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

  it("lets snapshots cancel prior all-components removals for the entity", () => {
    const history = new History();
    const latestPosition = snapshot(1, 1, 20);

    history.push(stateDiff(0, [snapshot(1, 1, 10)]));
    history.push(stateDiff(1, [], [[1, ALL_COMPONENTS]]));
    history.push(stateDiff(2, [latestPosition]));

    const pulled = history.pull(-1, 2);

    expect(pulled.snapshots).toEqual([latestPosition]);
    expect(pulled.removed).toEqual([]);
  });

  it("lets all-components removals cancel prior snapshots and removals for the entity", () => {
    const history = new History();

    history.push(stateDiff(0, [snapshot(1, 1), snapshot(1, 2)]));
    history.push(stateDiff(1, [], [[1, 3]]));
    history.push(stateDiff(2, [], [[1, ALL_COMPONENTS]]));

    const pulled = history.pull(-1, 2);

    expect(pulled.snapshots).toEqual([]);
    expect(pulled.removed).toEqual([[1, ALL_COMPONENTS]]);
  });

  it("keeps all-components removal when followed by narrower component removals", () => {
    const history = new History();

    history.push(stateDiff(0, [snapshot(1, 1)]));
    history.push(stateDiff(1, [], [[1, ALL_COMPONENTS]]));
    history.push(stateDiff(2, [], [[1, 1]]));

    const pulled = history.pull(-1, 2);

    expect(pulled.snapshots).toEqual([]);
    expect(pulled.removed).toEqual([[1, ALL_COMPONENTS]]);
  });

  it("can pull from the frame just before the oldest one it holds, and no further back", () => {
    const history = new History(4);
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
      const history = new History(4, 9);
      expect(history.lastContentFrame).toBe(9);

      history.push(stateDiff(10));
      history.push(stateDiff(11));

      expect(history.lastContentFrame).toBe(9);
    });

    it("is the newest frame pushed with a snapshot or a removal, and no later empty frame moves it", () => {
      const history = new History(4);

      history.push(stateDiff(0, [snapshot(1, 1)]));
      expect(history.lastContentFrame).toBe(0);
      history.push(stateDiff(1));
      history.push(stateDiff(2, [], [[1, 1]]));
      expect(history.lastContentFrame).toBe(2);
      history.push(stateDiff(3));
      history.push(stateDiff(4));
      expect(history.lastContentFrame).toBe(2);
      history.push(stateDiff(5, [], [[1, ALL_COMPONENTS]]));
      expect(history.lastContentFrame).toBe(5);
    });

    it("stays when the frame that held the content leaves the window", () => {
      const history = new History(3);
      history.push(stateDiff(0, [snapshot(1, 1)]));
      for (let frame = 1; frame <= 8; frame++) {
        history.push(stateDiff(frame));
      }

      expect(history.evictedContentFrame).toBe(0);
      expect(history.lastContentFrame).toBe(0);
    });

    it("lets a pull from it or from any later frame answer an empty delta without merging", () => {
      const history = new History(8);
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
      const history = new History(3);
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
      const history = new History(3);
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
      const history = new History(3);
      for (let frame = 0; frame <= 50; frame++) {
        history.push(stateDiff(frame));
      }

      const pulled = history.pull(-40, 50);

      expect(pulled).toMatchObject({ fromFrame: -40, toFrame: 50, snapshots: [], removed: [] });
    });

    it("refuses an ack older than a frame that left holding something", () => {
      const history = new History(3);
      history.push(stateDiff(0, [snapshot(1, 1)]));
      for (let frame = 1; frame <= 8; frame++) {
        history.push(stateDiff(frame));
      }

      expect(() => history.pull(-1, 8)).toThrow("Frame 0 is outside history window");
      expect(() => history.pull(0, 8)).not.toThrow();
    });

    it("looks ahead to the frame the next push evicts", () => {
      const history = new History(3);
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
      const short = new History(6);
      const long = new History(500);
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

/** A frame that sets, removes or clears a few components of a few entities. */
function randomContent(frame: number, next: () => number): ContentFactory {
  const snapshots: EncodedSnapshot[] = [];
  const removed: RemovedComponent[] = [];
  const count = 1 + Math.floor(next() * 3);
  for (let i = 0; i < count; i++) {
    const eid = 1 + Math.floor(next() * 4);
    const type = 1 + Math.floor(next() * 3);
    const roll = next();
    if (roll < 0.6) {
      snapshots.push(snapshot(eid, type, frame & 0xff));
    } else if (roll < 0.9) {
      removed.push([eid, type]);
    } else {
      removed.push([eid, ALL_COMPONENTS]);
    }
  }
  return () => stateDiff(frame, snapshots, removed);
}

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
