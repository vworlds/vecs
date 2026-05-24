import { describe, expect, it } from "vitest";
import { IdPool } from "../src/util/id_pool.js";

describe("IdPool", () => {
  it("hands out consecutive ids starting from min", () => {
    const pool = new IdPool("p", 1, undefined);
    expect(pool.alloc()).toBe(1);
    expect(pool.alloc()).toBe(2);
    expect(pool.alloc()).toBe(3);
  });

  it("respects custom min", () => {
    const pool = new IdPool("p", 1000, 2000);
    expect(pool.alloc()).toBe(1000);
    expect(pool.alloc()).toBe(1001);
  });

  it("reuses the lowest freed id on alloc", () => {
    const pool = new IdPool("p", 1, undefined);
    const a = pool.alloc();
    const b = pool.alloc();
    const c = pool.alloc();
    pool.free(b);
    pool.free(a);
    expect(pool.alloc()).toBe(a);
    expect(pool.alloc()).toBe(b);
    expect(pool.alloc()).toBe(c + 1);
  });

  it("supports free of high id and continues fresh thereafter", () => {
    const pool = new IdPool("p", 1, undefined);
    const ids = [pool.alloc(), pool.alloc(), pool.alloc(), pool.alloc()];
    pool.free(ids[3]);
    expect(pool.alloc()).toBe(ids[3]);
    expect(pool.alloc()).toBe(ids[3] + 1);
  });

  it("throws on exhaustion when max is set", () => {
    const pool = new IdPool("p", 1, 2);
    pool.alloc();
    pool.alloc();
    expect(() => pool.alloc()).toThrow(/exhausted/);
  });

  it("reserve marks an id as taken and is skipped by alloc", () => {
    const pool = new IdPool("p", 1, undefined);
    pool.reserve(2);
    expect(pool.alloc()).toBe(1);
    expect(pool.alloc()).toBe(3);
  });

  it("reserve throws if id is out of range", () => {
    const pool = new IdPool("p", 10, 20);
    expect(() => pool.reserve(5)).toThrow();
    expect(() => pool.reserve(25)).toThrow();
  });

  it("reserve throws on double-reserve", () => {
    const pool = new IdPool("p", 1, undefined);
    pool.reserve(5);
    expect(() => pool.reserve(5)).toThrow(/already reserved/);
  });

  it("free throws on out-of-range id", () => {
    const pool = new IdPool("p", 10, 20);
    expect(() => pool.free(5)).toThrow();
  });

  it("free of unreserved id is a no-op (does not throw)", () => {
    const pool = new IdPool("p", 1, undefined);
    expect(() => pool.free(42)).not.toThrow();
  });

  it("owns returns true only within the [min,max] range", () => {
    const pool = new IdPool("p", 5, 10);
    expect(pool.owns(4)).toBe(false);
    expect(pool.owns(5)).toBe(true);
    expect(pool.owns(10)).toBe(true);
    expect(pool.owns(11)).toBe(false);
  });

  it("owns returns true for any id >= min when open-ended", () => {
    const pool = new IdPool("p", 1, undefined);
    expect(pool.owns(0)).toBe(false);
    expect(pool.owns(1)).toBe(true);
    expect(pool.owns(1_000_000)).toBe(true);
  });

  it("free + reserve same id round-trip works", () => {
    const pool = new IdPool("p", 1, undefined);
    const id = pool.alloc();
    pool.free(id);
    expect(() => pool.reserve(id)).not.toThrow();
    expect(pool.alloc()).toBe(id + 1);
  });

  it("reserving an id above current allocations still keeps low ids fresh", () => {
    const pool = new IdPool("p", 1, undefined);
    pool.reserve(100);
    expect(pool.alloc()).toBe(1);
    expect(pool.alloc()).toBe(2);
  });

  it("alloc after many reserves picks the lowest available", () => {
    const pool = new IdPool("p", 1, undefined);
    pool.reserve(1);
    pool.reserve(2);
    pool.reserve(4);
    expect(pool.alloc()).toBe(3);
    expect(pool.alloc()).toBe(5);
  });

  it("returns lowest id across many free/alloc cycles", () => {
    const pool = new IdPool("p", 1, undefined);
    const ids: number[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push(pool.alloc());
    }
    // free in arbitrary order
    pool.free(ids[50]);
    pool.free(ids[10]);
    pool.free(ids[80]);
    expect(pool.alloc()).toBe(ids[10]);
    expect(pool.alloc()).toBe(ids[50]);
    expect(pool.alloc()).toBe(ids[80]);
    expect(pool.alloc()).toBe(101);
  });
});
