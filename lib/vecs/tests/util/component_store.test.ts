import { describe, expect, it } from "vitest";
import { type Entity, World } from "../../src/index.js";
import { ComponentStore } from "../../src/util/component_store.js";

describe("ComponentStore", () => {
  it.each([1000, 10000])("uses promotion slack only for low-id populations at %i", (offset) => {
    const world = new World();
    const store = new ComponentStore();
    const all = Array.from({ length: 16 }, (_, i) => world.getOrCreateEntity(offset + i));
    all.forEach((entity) => store.set(entity, { n: entity.eid }));
    store.delete(all[0]!);
    expect([...store]).toEqual(offset === 1000 ? [all[15], ...all.slice(1, 15)] : all.slice(1));
    all.slice(1).forEach((entity) => expect(store.get(entity)).toEqual({ n: entity.eid }));
    world.dispose();
  });

  it.each([1000, 10000])(
    "matches a Set oracle across id ranges and live refills at %i",
    (offset) => {
      const world = new World();
      const store = new ComponentStore();
      const oracle = new Set<Entity>();
      const all = Array.from({ length: 600 }, (_, i) => world.getOrCreateEntity(offset + i));
      const values = new Map(all.map((entity) => [entity, { n: entity.eid }]));
      const check = () => {
        expect(new Set(store)).toEqual(oracle);
        expect(store.size).toBe(oracle.size);
        for (const entity of all) {
          expect(store.has(entity)).toBe(oracle.has(entity));
          expect(store.get(entity)).toBe(oracle.has(entity) ? values.get(entity) : undefined);
        }
      };
      for (const entity of all) {
        store.set(entity, values.get(entity)!);
        oracle.add(entity);
      }
      const absent = world.getOrCreateEntity(offset + 30000);
      expect(store.get(absent)).toBeUndefined();
      expect(store.has(absent)).toBe(false);
      expect(store.delete(absent)).toBe(false);
      check();
      const iterator = store[Symbol.iterator]();
      const first = iterator.next().value as Entity;
      const page = all.filter((entity) => entity.eid >> 8 === (offset + 300) >> 8);
      for (const entity of page) {
        expect(store.delete(entity)).toBe(oracle.delete(entity));
      }
      check();
      for (const entity of page) {
        store.set(entity, values.get(entity)!);
        oracle.add(entity);
      }
      const remaining = [...iterator];
      expect(new Set([first, ...remaining])).toEqual(oracle);
      expect(remaining).toHaveLength(oracle.size - 1);
      let seed = 548;
      for (let step = 0; step < 1000; step++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const entity = all[seed % all.length]!;
        if (seed & 0x10000) {
          const existed = oracle.has(entity);
          oracle.add(entity);
          expect(store.set(entity, values.get(entity)!)).toBe(!existed);
        } else {
          expect(store.delete(entity)).toBe(oracle.delete(entity));
        }
        if (step % 100 === 0) {
          check();
        }
      }
      check();
      store.clear();
      oracle.clear();
      check();
      world.dispose();
    }
  );

  it("keeps scattered sparse carriers readable across removal and refill", () => {
    const world = new World();
    const store = new ComponentStore();
    const all = Array.from({ length: 10 }, (_, i) => world.getOrCreateEntity(10000 + i * 10000));
    for (const entity of all) {
      store.set(entity, { n: entity.eid });
    }
    for (const entity of all) {
      expect(store.delete(entity)).toBe(true);
      expect(store.delete(entity)).toBe(false);
      store.set(entity, { n: entity.eid });
    }
    expect(new Set(store)).toEqual(new Set(all));
    all.forEach((entity) => expect(store.get(entity)).toEqual({ n: entity.eid }));
    world.dispose();
  });

  it("keeps moved instances aligned while draining without an active traversal", () => {
    const world = new World();
    const store = new ComponentStore();
    const all = Array.from({ length: 256 }, () => world.entity());
    const values = all.map((entity) => ({ n: entity.eid }));
    all.forEach((entity, i) => store.set(entity, values[i]!));
    const remaining = all.slice();
    for (const removed of all) {
      const index = remaining.indexOf(removed);
      remaining[index] = remaining[remaining.length - 1]!;
      remaining.pop();
      expect(store.delete(removed)).toBe(true);
      expect(store.get(removed)).toBeUndefined();
      expect([...store]).toEqual(remaining);
      for (const entity of remaining) {
        expect(store.get(entity)).toBe(values[all.indexOf(entity)]);
      }
    }
    store.set(all[0]!, values[0]!);
    expect(store.get(all[0]!)).toBe(values[0]);
    world.dispose();
  });

  it.each([0, 256])(
    "retains instance identity through replacement and recycled ids (%i padding)",
    (padding) => {
      const world = new World({
        idPools: [
          { name: "component", min: 1, max: 63 },
          { name: "module", min: 64, max: 99 },
          { name: "entity", min: 100, reuseWaitFrames: 0 },
        ],
      });
      const store = new ComponentStore();
      const stale = world.entity();
      const value = { n: 1 };
      expect(store.set(stale, value)).toBe(true);
      Array.from({ length: padding }, () => world.entity()).forEach((entity) =>
        store.set(entity, { n: entity.eid })
      );
      const replacement = { n: 2 };
      expect(store.set(stale, replacement)).toBe(false);
      expect(store.get(stale)).toBe(replacement);
      expect(store.delete(stale)).toBe(true);
      stale.destroy();
      const fresh = world.getOrCreateEntity(stale.eid);
      store.set(fresh, value);
      expect(store.get(stale)).toBeUndefined();
      expect(store.delete(stale)).toBe(false);
      expect(store.get(fresh)).toBe(value);
      world.dispose();
    }
  );

  it.each([0, 10000])(
    "keeps parallel instances correct under nested live mutation (offset %i)",
    (offset) => {
      const world = new World();
      const store = new ComponentStore();
      const all = Array.from({ length: 128 }, (_, i) => world.getOrCreateEntity(offset + 100 + i));
      const values = all.map((entity) => ({ n: entity.eid }));
      all.forEach((entity, i) => store.set(entity, values[i]!));
      const outer = store[Symbol.iterator]();
      const first = outer.next().value as Entity;
      const seen: Entity[] = [];
      store.forEachLive((entity) => {
        seen.push(entity);
        expect(store.get(entity)).toBe(values[all.indexOf(entity)]);
        store.delete(entity);
        // A nested cascade may also remove an unvisited or already visited carrier.
        if (entity === first) {
          store.delete(all[80]!);
        }
      });
      expect(new Set(seen)).toEqual(new Set(all.filter((entity) => entity !== all[80])));
      expect(seen).toHaveLength(127);
      expect(outer.next().done).toBe(true);
      expect(store.size).toBe(0);
      world.dispose();
    }
  );

  it.each(["iterator", "callback"] as const)(
    "keeps %s traversals live across emptying and additions",
    (kind) => {
      const world = new World();
      const store = new ComponentStore();
      // Cross the direct-mode threshold even with density 8 and default ids 1000+.
      const all = Array.from({ length: 256 }, () => world.entity());
      all.forEach((entity) => store.set(entity, { n: entity.eid }));
      const added = world.getOrCreateEntity(10000);
      const seen: Entity[] = [];
      const visit = (entity: Entity) => {
        seen.push(entity);
        if (seen.length === 1) {
          store.clear();
          store.set(added, { n: 42 });
        }
        expect(store.get(added)).toEqual({ n: 42 });
      };
      if (kind === "callback") {
        store.forEachLive(visit);
      } else {
        for (const entity of store) {
          visit(entity);
        }
      }
      expect(seen).toEqual([all[0], added]);
      expect(store.size).toBe(1);
      world.dispose();
    }
  );

  it("holds sparse representation during a traversal and releases it after throw", () => {
    const world = new World();
    const store = new ComponentStore();
    // Above the low-id allowance initially, but enough carriers to promote later.
    const all = Array.from({ length: 256 }, (_, i) => world.getOrCreateEntity(1200 + i));
    store.set(all[0]!, { n: 0 });
    expect(() =>
      store.forEachLive(() => {
        all.forEach((entity, i) => store.set(entity, { n: i }));
        store.delete(all[1]!);
        expect([...store]).toEqual([all[0], ...all.slice(2)]);
        throw new Error("stop");
      })
    ).toThrow("stop");
    // An idle insertion can promote now; swap-remove must move its instance too.
    store.set(all[1]!, { n: 1 });
    store.delete(all[0]!);
    expect([...store][0]).toBe(all[1]);
    expect(store.get(all[1]!)).toEqual({ n: 1 });
    world.dispose();
  });
});
