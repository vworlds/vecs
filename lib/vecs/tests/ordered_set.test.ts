import { describe, it, expect } from "vitest";
import { OrderedSet } from "../src/util/ordered_set.js";

const numCmp = (a: number, b: number) => a - b;
const strCmp = (a: string, b: string) => a.localeCompare(b);

describe("OrderedSet", () => {
  it("starts empty", () => {
    const s = new OrderedSet<number>(numCmp);
    expect(s.size).toBe(0);
    expect(s.has(1)).toBe(false);
  });

  it("add/has round trip", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(3);
    expect(s.has(3)).toBe(true);
    expect(s.size).toBe(1);
  });

  it("add is idempotent", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(5).add(5).add(5);
    expect(s.size).toBe(1);
  });

  it("add returns this for chaining", () => {
    const s = new OrderedSet<number>(numCmp);
    expect(s.add(1).add(2)).toBe(s);
  });

  it("maintains sorted order", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(30).add(10).add(20).add(5);
    expect([...s]).toEqual([5, 10, 20, 30]);
  });

  it("delete removes existing element and returns true", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(1).add(2).add(3);
    expect(s.delete(2)).toBe(true);
    expect(s.has(2)).toBe(false);
    expect(s.size).toBe(2);
    expect([...s]).toEqual([1, 3]);
  });

  it("delete on missing element returns false", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(1);
    expect(s.delete(99)).toBe(false);
    expect(s.size).toBe(1);
  });

  it("clear empties the set", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(1).add(2).add(3);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.has(1)).toBe(false);
  });

  it("forEach visits values in sorted order", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(3).add(1).add(2);
    const seen: number[] = [];
    s.forEach((v) => seen.push(v));
    expect(seen).toEqual([1, 2, 3]);
  });

  it("forEach passes value, value, set", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(42);
    s.forEach((v, v2, set) => {
      expect(v).toBe(42);
      expect(v2).toBe(42);
      expect(set).toBe(s);
    });
  });

  it("forEach respects thisArg", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(1);
    const ctx = { called: false };
    s.forEach(function (this: typeof ctx) {
      this.called = true;
    }, ctx);
    expect(ctx.called).toBe(true);
  });

  it("[Symbol.iterator] yields values in sorted order", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(9).add(3).add(6);
    expect([...s]).toEqual([3, 6, 9]);
  });

  it("values() yields sorted values", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(2).add(1).add(3);
    expect([...s.values()]).toEqual([1, 2, 3]);
  });

  it("keys() yields sorted values (same as values)", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(2).add(1).add(3);
    expect([...s.keys()]).toEqual([1, 2, 3]);
  });

  it("entries() yields [value, value] pairs in sorted order", () => {
    const s = new OrderedSet<number>(numCmp);
    s.add(2).add(1);
    expect([...s.entries()]).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("works with string comparator", () => {
    const s = new OrderedSet<string>(strCmp);
    s.add("banana").add("apple").add("cherry");
    expect([...s]).toEqual(["apple", "banana", "cherry"]);
  });

  it("works with object comparator", () => {
    type Item = { priority: number; name: string };
    const s = new OrderedSet<Item>((a, b) => a.priority - b.priority);
    s.add({ priority: 3, name: "c" });
    s.add({ priority: 1, name: "a" });
    s.add({ priority: 2, name: "b" });
    const names = [...s].map((x) => x.name);
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("binary search handles first and last element", () => {
    const s = new OrderedSet<number>(numCmp);
    for (let i = 1; i <= 10; i++) {
      s.add(i);
    }
    expect(s.has(1)).toBe(true);
    expect(s.has(10)).toBe(true);
    expect(s.delete(1)).toBe(true);
    expect(s.delete(10)).toBe(true);
    expect([...s]).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("Symbol.toStringTag is 'OrderedSet'", () => {
    const s = new OrderedSet<number>(numCmp);
    expect(s[Symbol.toStringTag]).toBe("OrderedSet");
  });

  it("is assignable to Set<T>", () => {
    const s: Set<number> = new OrderedSet<number>(numCmp);
    s.add(1).add(2);
    expect(s.size).toBe(2);
  });
});
