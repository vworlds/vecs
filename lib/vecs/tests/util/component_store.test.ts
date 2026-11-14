import { describe, expect, it } from "vitest";
import { type Entity, World } from "../../src/index.js";
import { ComponentStore } from "../../src/util/component_store.js";

describe("ComponentStore", () => {
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
    // Enough carriers for the later idle insertion to promote at density 8.
    const all = Array.from({ length: 256 }, () => world.entity());
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
