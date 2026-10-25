import { describe, expect, it } from "vitest";
import { DEFAULT_POOLS, Entity, World } from "../src/index.js";
import { vecsEqualityTester } from "../src/testing.js";

expect.addEqualityTesters([vecsEqualityTester]);

describe("vecsEqualityTester", () => {
  it("compares either operand by reference, including subclasses and destroyed entities", () => {
    class Scene extends World {}
    const world = new Scene({
      idPools: DEFAULT_POOLS.map((pool) => ({ ...pool, reuseWaitFrames: 0 })),
    });
    const entity = world.entity();
    const eid = entity.eid;
    entity.destroy();
    const replacement = world.getOrCreateEntity(eid);
    expect(replacement.eid).toBe(entity.eid);
    expect(replacement).not.toBe(entity);
    expect(replacement).not.toEqual(entity);
    for (const value of [world, entity]) {
      expect(vecsEqualityTester(value, value)).toBe(true);
      for (const other of [{}, null, undefined, 42, new World()]) {
        expect(vecsEqualityTester(value, other)).toBe(false);
        expect(vecsEqualityTester(other, value)).toBe(false);
      }
    }
    expect(entity).toBeInstanceOf(Entity);
  });

  it.each([
    ["entity", "toBe"],
    ["entity", "toEqual"],
    ["world", "toBe"],
    ["world", "toEqual"],
  ])("does not deep-walk %s %s comparisons", (kind, matcher) => {
    const a = new World();
    const b = new World();
    let reads = 0;
    for (const world of [a, b]) {
      Object.defineProperty(world, "walkProbe", {
        enumerable: true,
        get: () => {
          reads++;
          return 0;
        },
      });
    }
    const left = kind === "entity" ? a.entity() : a;
    const right = kind === "entity" ? b.entity() : b;
    try {
      if (matcher === "toBe") {
        expect(left).not.toBe(right);
      } else {
        expect(left).not.toEqual(right);
      }
    } finally {
      expect(reads).toBe(0);
    }
    expect({ value: left }).not.toEqual({ value: right });
    expect(reads).toBe(0);
  });

  it("leaves unrelated equality unchanged", () => {
    expect(vecsEqualityTester({ a: 1 }, { a: 1 })).toBeUndefined();
    expect({ items: [1, { a: "b" }] }).toEqual({ items: [1, { a: "b" }] });
    expect({ items: [1] }).not.toEqual({ items: [2] });
    expect(new Set([1, 2])).toEqual(new Set([2, 1]));
  });
});
