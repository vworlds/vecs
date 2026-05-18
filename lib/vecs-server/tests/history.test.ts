import { describe, expect, it } from "vitest";
import { EncodedSnapshot, StateDiff } from "@vworlds/vecs-protocol";
import { HISTORY_LENGTH, History } from "../src/history.js";

function diff(toFrame: number): StateDiff {
  return new StateDiff({
    fromFrame: toFrame - 1,
    toFrame,
    snapshots: [new EncodedSnapshot(new Uint8Array([toFrame]), toFrame)],
    removed: [toFrame],
  });
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
});
