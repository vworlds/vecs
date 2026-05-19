import { describe, expect, it } from "vitest";
import { ALL_COMPONENTS, EncodedSnapshot, StateDiff } from "@vworlds/vecs-protocol";
import { HISTORY_LENGTH, History } from "../src/history.js";

function diff(toFrame: number): StateDiff {
  const snapshotBytes = new Uint8Array([toFrame]);

  return new StateDiff({
    fromFrame: toFrame - 1,
    toFrame,
    snapshots: [new EncodedSnapshot(snapshotBytes, 123, 1)],
    removed: [[toFrame, 1]],
  });
}

function snapshot(eid: number, type: number, value = type): EncodedSnapshot {
  return new EncodedSnapshot(new Uint8Array([eid, type, value]), eid, type);
}

function stateDiff(
  toFrame: number,
  snapshots: EncodedSnapshot[] = [],
  removed: [eid: number, type: number][] = []
): StateDiff {
  return new StateDiff({ fromFrame: toFrame - 1, toFrame, snapshots, removed });
}

describe("History", () => {
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

    expect(history.lastFrame).toBe(9);
    expect(history.oldestFrame).toBe(5);
    for (let frame = 5; frame <= 9; frame++) {
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
    const history = new History();
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
});
