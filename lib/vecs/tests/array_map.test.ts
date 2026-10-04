import { describe, it, expect } from "vitest";
import { ArrayMap, IterableArrayMap } from "../src/util/array_map.js";

describe("ArrayMap", () => {
  it("starts empty", () => {
    const m = new ArrayMap<string>();
    expect(m.size).toBe(0);
    expect(m.get(0)).toBeUndefined();
    expect(m.has(0)).toBe(false);
  });

  it("set/get/has round trip", () => {
    const m = new ArrayMap<string>();
    m.set(5, "hello");
    expect(m.get(5)).toBe("hello");
    expect(m.has(5)).toBe(true);
    expect(m.size).toBe(1);
  });

  it("size only increments for new keys", () => {
    const m = new ArrayMap<number>();
    m.set(1, 100);
    m.set(1, 200);
    expect(m.size).toBe(1);
    expect(m.get(1)).toBe(200);
  });

  it("delete removes entry and decrements size", () => {
    const m = new ArrayMap<number>();
    m.set(2, 42);
    m.set(7, 99);
    expect(m.size).toBe(2);
    m.delete(2);
    expect(m.has(2)).toBe(false);
    expect(m.get(2)).toBeUndefined();
    expect(m.size).toBe(1);
  });

  it("delete on missing key is a no-op", () => {
    const m = new ArrayMap<number>();
    m.set(1, 1);
    m.delete(50);
    expect(m.size).toBe(1);
  });

  it("clear empties the map", () => {
    const m = new ArrayMap<number>();
    m.set(1, 1);
    m.set(2, 2);
    m.clear();
    expect(m.has(1)).toBe(false);
    expect(m.has(2)).toBe(false);
    expect(m.size).toBe(0);
  });
});

describe("IterableArrayMap", () => {
  it("starts empty", () => {
    const m = new IterableArrayMap<string>();
    expect(m.size).toBe(0);
    expect(m.get(0)).toBeUndefined();
    expect(m.has(0)).toBe(false);
  });

  it("set/get/has round trip", () => {
    const m = new IterableArrayMap<string>();
    m.set(5, "hello");
    expect(m.get(5)).toBe("hello");
    expect(m.has(5)).toBe(true);
    expect(m.size).toBe(1);
  });

  it("size only increments for new keys", () => {
    const m = new IterableArrayMap<number>();
    m.set(1, 100);
    m.set(1, 200); // overwrite
    expect(m.size).toBe(1);
    expect(m.get(1)).toBe(200);
  });

  it("delete removes entry and decrements size", () => {
    const m = new IterableArrayMap<number>();
    m.set(2, 42);
    m.set(7, 99);
    expect(m.size).toBe(2);
    m.delete(2);
    expect(m.has(2)).toBe(false);
    expect(m.get(2)).toBeUndefined();
    expect(m.size).toBe(1);
  });

  it("delete on missing key is a no-op", () => {
    const m = new IterableArrayMap<number>();
    m.set(1, 1);
    m.delete(50);
    expect(m.size).toBe(1);
  });

  it("forEach skips undefined slots and reports key+value", () => {
    const m = new IterableArrayMap<string>();
    m.set(0, "a");
    m.set(2, "c");
    m.set(5, "f");
    const seen: Array<[string, number]> = [];
    m.forEach((v, k) => seen.push([v, k]));
    expect(seen).toEqual([
      ["a", 0],
      ["c", 2],
      ["f", 5],
    ]);
  });

  it("entries returns key/value pairs in dense item order", () => {
    const m = new IterableArrayMap<string>();
    m.set(0, "a");
    m.set(2, "c");
    m.set(5, "f");

    expect([...m.entries()]).toEqual([
      [0, "a"],
      [2, "c"],
      [5, "f"],
    ]);
  });

  it("supports for-of over key/value pairs", () => {
    const m = new IterableArrayMap<number>();
    m.set(1, 10);
    m.set(3, 30);

    const seen: Array<[number, number]> = [];
    for (const [key, value] of m) {
      seen.push([key, value]);
    }

    expect(seen).toEqual([
      [1, 10],
      [3, 30],
    ]);
  });

  it("clear empties the map", () => {
    const m = new IterableArrayMap<number>();
    m.set(1, 1);
    m.set(2, 2);
    m.clear();
    expect(m.has(1)).toBe(false);
    expect(m.has(2)).toBe(false);
    expect(m.size).toBe(0);
  });
});

describe("IterableArrayMap — dense storage bookkeeping", () => {
  it("keeps lookups and dense order consistent across swap-deletes and re-adds", () => {
    const m = new IterableArrayMap<string>();
    for (const key of [1, 2, 3, 4, 5]) {
      m.set(key, `v${key}`);
    }

    m.delete(2); // 5 moves into 2's position
    m.set(3, "three"); // replacing keeps the position
    m.set(2, "again"); // re-added at the end
    m.delete(1); // 2 moves into 1's position
    m.delete(4);

    expect([...m.entries()]).toEqual([
      [2, "again"],
      [5, "v5"],
      [3, "three"],
    ]);
    expect([1, 2, 3, 4, 5].map((key) => [m.has(key), m.get(key)])).toEqual([
      [false, undefined],
      [true, "again"],
      [true, "three"],
      [false, undefined],
      [true, "v5"],
    ]);
    expect(m.size).toBe(3);
  });

  it("supports large sparse keys", () => {
    const m = new IterableArrayMap<string>();
    m.set(1_000_000, "far");
    m.set(3, "near");
    m.delete(3);
    expect(m.get(1_000_000)).toBe("far");
    expect(m.has(3)).toBe(false);
    expect([...m]).toEqual([[1_000_000, "far"]]);
  });

  it("iterates entries against the live contents", () => {
    const m = new IterableArrayMap<number>();
    m.set(1, 10);
    m.set(2, 20);
    const seen: Array<readonly [number, number]> = [];
    for (const entry of m) {
      seen.push(entry);
      if (entry[0] === 1) {
        m.set(2, 21);
        m.set(3, 30);
      }
    }
    expect(seen).toEqual([
      [1, 10],
      [2, 21],
      [3, 30],
    ]);
  });

  it("returns values as a copy and reuses keys after clear", () => {
    const m = new IterableArrayMap<number>();
    m.set(4, 40);
    m.set(9, 90);
    const values = m.values();
    values.push(100);
    expect(m.values()).toEqual([40, 90]);

    m.clear();
    expect(m.has(4)).toBe(false);
    m.set(9, 91);
    expect([...m]).toEqual([[9, 91]]);
    expect(m.size).toBe(1);
  });
});

describe("IterableArrayMap.forEachSafe", () => {
  it("visits every entry when the callback does not mutate", () => {
    const m = new IterableArrayMap<string>();
    m.set(0, "a");
    m.set(2, "c");
    m.set(5, "f");
    const seen: Array<[string, number]> = [];
    m.forEachSafe((v, k) => seen.push([v, k]));
    expect(seen).toEqual([
      ["a", 0],
      ["c", 2],
      ["f", 5],
    ]);
  });

  it("matches forEach behavior when no mutation occurs", () => {
    const m = new IterableArrayMap<string>();
    m.set(0, "a");
    m.set(2, "c");
    m.set(5, "f");
    const safe: Array<[string, number]> = [];
    const plain: Array<[string, number]> = [];
    m.forEachSafe((v, k) => safe.push([v, k]));
    m.forEach((v, k) => plain.push([v, k]));
    expect(safe).toEqual(plain);
  });

  it("passes value, key, map", () => {
    const m = new IterableArrayMap<number>();
    m.set(7, 42);
    m.forEachSafe((v, k, map) => {
      expect(v).toBe(42);
      expect(k).toBe(7);
      expect(map).toBe(m);
    });
  });

  it("visits the swapped-in entry when the current entry is deleted", () => {
    // After deleting the current entry, IterableArrayMap swaps the last entry
    // into the vacated slot. forEachSafe must visit that swapped-in entry
    // rather than skipping it.
    const m = new IterableArrayMap<string>();
    m.set(1, "a"); // items: [[1,"a"], [2,"b"], [3,"c"]]
    m.set(2, "b");
    m.set(3, "c");
    const seen: Array<[string, number]> = [];
    m.forEachSafe((v, k) => {
      seen.push([v, k]);
      if (k === 1) {
        m.delete(1); // swaps [3,"c"] into slot 0
      }
    });
    // 1 is visited, then 3 (swapped in), then 2.
    expect(seen).toEqual([
      ["a", 1],
      ["c", 3],
      ["b", 2],
    ]);
    expect(m.size).toBe(2);
  });

  it("does not re-process the previous slot when the last entry is deleted", () => {
    // Deleting the last entry pops it with no swap; the index is now out of
    // bounds and forEachSafe must not decrement and re-visit slot i-1.
    const m = new IterableArrayMap<number>();
    m.set(1, 10);
    m.set(2, 20);
    m.set(3, 30); // items: [[1,10],[2,20],[3,30]]
    const seen: Array<[number, number]> = [];
    m.forEachSafe((v, k) => {
      seen.push([v, k]);
      if (k === 3) {
        m.delete(3); // no swap, slot 2 just pops out of bounds
      }
    });
    expect(seen).toEqual([
      [10, 1],
      [20, 2],
      [30, 3],
    ]);
    expect(m.size).toBe(2);
  });

  it("visits all entries when each callback deletes its current entry", () => {
    const m = new IterableArrayMap<string>();
    m.set(1, "a");
    m.set(2, "b");
    m.set(3, "c");
    m.set(4, "d"); // items: [[1,a],[2,b],[3,c],[4,d]]
    const seen: Array<[string, number]> = [];
    m.forEachSafe((v, k) => {
      seen.push([v, k]);
      m.delete(k);
    });
    // Each delete swaps the last unprocessed entry into the current slot,
    // which forEachSafe then visits — so all four are seen exactly once.
    expect(seen.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
    ]);
    expect(m.size).toBe(0);
  });

  it("is a no-op on an empty map", () => {
    const m = new IterableArrayMap<number>();
    const seen: Array<[number, number]> = [];
    m.forEachSafe((v, k) => seen.push([v, k]));
    expect(seen).toEqual([]);
  });

  it("re-add after delete appends to the end and is visited at its new slot", () => {
    // Deleting the current entry then setting a new key inside the callback:
    // the delete pops the last slot (or swaps), then the set pushes the new
    // entry to the end. The new entry is visited via forward advance at its
    // appended index, not via the i-- re-visit path.
    const m = new IterableArrayMap<number>();
    m.set(1, 10);
    m.set(2, 20); // items: [[1,10],[2,20]]
    const seen: Array<[number, number]> = [];
    m.forEachSafe((v, k) => {
      seen.push([v, k]);
      if (k === 1) {
        m.delete(1); // pops [2,20] with no swap (it is last)? No: index 0, last
        // is index 1 -> swaps [2,20] into slot 0. Then set(3,30) appends.
        m.set(3, 30); // appended at end, items: [[2,20],[3,30]]
      }
    });
    // i=0: visit [1,10], delete swaps [2,20] into slot 0, then set(3,30)
    // appends -> items: [[2,20],[3,30]]. items[0][0] is now 2 !== 1, so i--.
    // i=0 again: visit [2,20]. No mutation. i=1: visit [3,30]. Done.
    expect(seen).toEqual([
      [10, 1],
      [20, 2],
      [30, 3],
    ]);
    expect(m.size).toBe(2);
  });
});
