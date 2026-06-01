import { describe, expect, it } from "vitest";

import { swapRemove } from "../../src/util/dense_array.js";

describe("swapRemove", () => {
  it("swaps the last element into the removed slot and returns it", () => {
    const arr = ["a", "b", "c", "d"];
    const moved = swapRemove(arr, 1);
    expect(moved).toBe("d");
    expect(arr).toEqual(["a", "d", "c"]);
  });

  it("returns undefined and just pops when removing the last element", () => {
    const arr = ["a", "b", "c"];
    const moved = swapRemove(arr, 2);
    expect(moved).toBeUndefined();
    expect(arr).toEqual(["a", "b"]);
  });

  it("preserves indices for a back-reference fix-up loop", () => {
    // Simulate dense storage where each element records its own index.
    const items = [
      { id: "x", index: 0 },
      { id: "y", index: 1 },
      { id: "z", index: 2 },
    ];
    const moved = swapRemove(items, 0);
    // The moved element must be patched to its new index by the caller.
    if (moved) {
      moved.index = 0;
    }
    expect(items).toEqual([
      { id: "z", index: 0 },
      { id: "y", index: 1 },
    ]);
  });

  it("handles a single-element array", () => {
    const arr = [42];
    expect(swapRemove(arr, 0)).toBeUndefined();
    expect(arr).toEqual([]);
  });

  it("throws on an out-of-range index", () => {
    expect(() => swapRemove([1, 2], 5)).toThrow(RangeError);
    expect(() => swapRemove([1, 2], -1)).toThrow(RangeError);
  });
});
