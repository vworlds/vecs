import { describe, it, expect } from "vitest";
import { DenseSet } from "../src/util/dense_set.js";

describe("DenseSet", () => {
  it("starts empty", () => {
    const s = new DenseSet<number>();
    expect(s.size).toBe(0);
    expect(s.has(1)).toBe(false);
  });

  it("add/has round trip", () => {
    const s = new DenseSet<number>();
    s.add(3);
    expect(s.has(3)).toBe(true);
    expect(s.size).toBe(1);
  });

  it("add is idempotent", () => {
    const s = new DenseSet<number>();
    s.add(5).add(5).add(5);
    expect(s.size).toBe(1);
  });

  it("add returns this for chaining", () => {
    const s = new DenseSet<number>();
    expect(s.add(1).add(2)).toBe(s);
  });

  it("delete removes element and returns true", () => {
    const s = new DenseSet<number>();
    s.add(1).add(2).add(3);
    expect(s.delete(2)).toBe(true);
    expect(s.has(2)).toBe(false);
    expect(s.size).toBe(2);
  });

  it("delete on missing element returns false", () => {
    const s = new DenseSet<number>();
    s.add(1);
    expect(s.delete(99)).toBe(false);
    expect(s.size).toBe(1);
  });

  it("clear empties the set", () => {
    const s = new DenseSet<number>();
    s.add(1).add(2).add(3);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.has(1)).toBe(false);
  });

  it("forEach visits values in current order", () => {
    const s = new DenseSet<number>();
    s.add(3).add(1).add(2);
    const seen: number[] = [];
    s.forEach((v) => seen.push(v));
    expect(seen).toEqual([3, 1, 2]);
  });

  it("forEach passes value, value, set", () => {
    const s = new DenseSet<number>();
    s.add(42);
    s.forEach((v, v2, set) => {
      expect(v).toBe(42);
      expect(v2).toBe(42);
      expect(set).toBe(s);
    });
  });

  it("forEach respects thisArg", () => {
    const s = new DenseSet<number>();
    s.add(1);
    const ctx = { seen: 0 };
    s.forEach(function (this: typeof ctx, v) {
      this.seen = v;
    }, ctx);
    expect(ctx.seen).toBe(1);
  });

  it("[Symbol.iterator] yields values in current order", () => {
    const s = new DenseSet<number>();
    s.add(9).add(3).add(6);
    expect([...s]).toEqual([9, 3, 6]);
  });

  it("values() and keys() yield current-order values", () => {
    const s = new DenseSet<number>();
    s.add(2).add(1).add(3);
    expect([...s.values()]).toEqual([2, 1, 3]);
    expect([...s.keys()]).toEqual([2, 1, 3]);
  });

  it("entries() yields [value, value] pairs", () => {
    const s = new DenseSet<number>();
    s.add(2).add(1);
    expect([...s.entries()]).toEqual([
      [2, 2],
      [1, 1],
    ]);
  });

  it("Symbol.toStringTag is 'DenseSet'", () => {
    const s = new DenseSet<number>();
    expect(s[Symbol.toStringTag]).toBe("DenseSet");
  });

  it("is assignable to Set<T>", () => {
    const s: Set<number> = new DenseSet<number>();
    s.add(1).add(2);
    expect(s.size).toBe(2);
  });
});

describe("DenseSet.forEachSafe", () => {
  it("visits every element when the callback does not mutate", () => {
    const s = new DenseSet<number>();
    s.add(3).add(1).add(2);
    const seen: number[] = [];
    s.forEachSafe((v) => seen.push(v));
    expect(seen).toEqual([3, 1, 2]);
  });

  it("passes value, value, set and respects thisArg", () => {
    const s = new DenseSet<number>();
    s.add(42);
    const ctx = { hit: false };
    s.forEachSafe(function (this: typeof ctx, v, v2, set) {
      expect(v).toBe(42);
      expect(v2).toBe(42);
      expect(set).toBe(s);
      this.hit = true;
    }, ctx);
    expect(ctx.hit).toBe(true);
  });

  it("visits the swapped-in element when the current element is deleted", () => {
    // After deleting the current element, DenseSet swaps the last element
    // into the vacated slot. forEachSafe must visit that swapped-in element
    // rather than skipping it.
    const s = new DenseSet<number>();
    s.add(1).add(2).add(3).add(4); // order: [1, 2, 3, 4]
    const seen: number[] = [];
    s.forEachSafe((v) => {
      seen.push(v);
      if (v === 1) {
        s.delete(1); // swaps 4 into slot 0
      }
    });
    // 1 is visited, then 4 (swapped in), then 2, then 3.
    expect(seen).toEqual([1, 4, 2, 3]);
    expect(s.size).toBe(3);
  });

  it("does not re-process the previous slot when the last element is deleted", () => {
    // Deleting the last element pops it with no swap; the index is now out of
    // bounds and forEachSafe must not decrement and re-visit slot i-1.
    const s = new DenseSet<number>();
    s.add(1).add(2).add(3); // order: [1, 2, 3]
    const seen: number[] = [];
    s.forEachSafe((v) => {
      seen.push(v);
      if (v === 3) {
        s.delete(3); // no swap, slot 2 just pops out of bounds
      }
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(s.size).toBe(2);
  });

  it("visits all carriers when each callback deletes its current element", () => {
    // Mirrors _applyOnDelete: every visited element removes itself from the
    // set during the callback.
    const s = new DenseSet<string>();
    s.add("a").add("b").add("c").add("d"); // order: [a, b, c, d]
    const seen: string[] = [];
    s.forEachSafe((v) => {
      seen.push(v);
      s.delete(v);
    });
    // Each delete swaps the last unprocessed element into the current slot,
    // which forEachSafe then visits — so all four are seen exactly once.
    expect(seen.sort()).toEqual(["a", "b", "c", "d"]);
    expect(s.size).toBe(0);
  });

  it("tolerates an idempotent callback that deletes the current element twice", () => {
    const s = new DenseSet<number>();
    s.add(1).add(2).add(3);
    const seen: number[] = [];
    s.forEachSafe((v) => {
      seen.push(v);
      s.delete(v);
      s.delete(v); // second delete is a no-op; must not perturb the loop
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
    expect(s.size).toBe(0);
  });

  it("visits elements added during iteration at the appended slot", () => {
    // Adding a new element pushes it to the end; forward iteration will visit
    // it at its appended index. This documents the forward-iteration
    // contract: adds are seen via the normal forward advance, not via the
    // i-- re-visit path.
    const s = new DenseSet<number>();
    s.add(1).add(2).add(3); // order: [1, 2, 3]
    const seen: number[] = [];
    s.forEachSafe((v) => {
      seen.push(v);
      if (v === 1) {
        s.add(99); // appended at end, will be visited at i=3
      }
    });
    expect(seen).toEqual([1, 2, 3, 99]);
    expect(s.size).toBe(4);
  });

  it("is a no-op on an empty set", () => {
    const s = new DenseSet<number>();
    const seen: number[] = [];
    s.forEachSafe((v) => seen.push(v));
    expect(seen).toEqual([]);
  });
});
