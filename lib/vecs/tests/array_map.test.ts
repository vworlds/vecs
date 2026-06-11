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
