import { describe, expect, it } from "vitest";
import { type Entity, World } from "../../src/index.js";
import { DenseEntitySet } from "../../src/util/dense_entity_set.js";

describe("DenseEntitySet", () => {
  it("does no work for an empty callback traversal and can be filled afterward", () => {
    const world = new World();
    const set = new DenseEntitySet();
    const seen: Entity[] = [];
    set.forEachLive((entity) => seen.push(entity));
    expect(seen).toEqual([]);
    const entity = world.entity();
    set.add(entity);
    set.forEachLive((member) => seen.push(member));
    expect(seen).toEqual([entity]);
    world.dispose();
  });

  it.each([0, 256])("checks identity after id reuse with %i padding members", (paddingCount) => {
    const world = densityWorld();
    const stale = world.entity();
    const eid = stale.eid;
    const set = new DenseEntitySet();
    set.add(stale).add(stale);
    expect(set.size).toBe(1);
    const padding = Array.from({ length: paddingCount }, () => world.entity());
    padding.forEach((entity) => set.add(entity));
    expect(set.delete(stale)).toBe(true);
    stale.destroy();
    const fresh = world.getOrCreateEntity(eid);
    expect(fresh.eid).toBe(eid);
    set.add(fresh);
    expect(set.has(stale)).toBe(false);
    expect(set.indexOf(stale)).toBe(-1);
    expect(set.delete(stale)).toBe(false);
    expect(set.has(fresh)).toBe(true);
    const distant = world.getOrCreateEntity(100_000);
    set.add(distant);
    expect(set.has(distant)).toBe(true);
    expect(new Set(set)).toEqual(new Set([...padding, fresh, distant]));
    world.dispose();
  });

  it.each(["iterator", "callback"] as const)("visits live changes through %s", (kind) => {
    const world = new World();
    const entities = Array.from({ length: 6 }, () => world.entity());
    const run = (set: Set<Entity> | DenseEntitySet): Entity[] => {
      const seen: Entity[] = [];
      const visit = (entity: Entity): void => {
        seen.push(entity);
        if (entity === entities[0]) {
          set.delete(entity); // current
          set.delete(entities[2]!); // unvisited
          set.add(entities[5]!); // addition
        }
        if (entity === entities[1]) {
          set.delete(entities[0]!); // already removed
          set.delete(entity);
          set.add(entity); // a reinsertion must be visited again
        }
        if (seen.filter((e) => e === entities[1]).length === 2) {
          set.delete(entities[1]!);
        }
        expect(seen.length).toBeLessThan(10);
      };
      for (const entity of entities.slice(0, 5)) {
        set.add(entity);
      }
      if (kind === "callback" && set instanceof DenseEntitySet) {
        set.forEachLive(visit);
      } else {
        for (const entity of set) {
          visit(entity);
        }
      }
      return seen;
    };
    const oracle = run(new Set());
    const actual = run(new DenseEntitySet());
    expect(actual.map((e) => e.eid).sort()).toEqual(oracle.map((e) => e.eid).sort());
    world.dispose();
  });

  it("resets active cursors on clear without replacing the dense array", () => {
    const world = new World();
    const a = world.entity();
    const b = world.entity();
    const set = new DenseEntitySet().add(a);
    const dense = set.dense;
    const seen: Entity[] = [];
    set.forEachLive((entity) => {
      seen.push(entity);
      if (entity === a) {
        set.clear();
        set.add(b);
      }
    });
    expect(seen).toEqual([a, b]);
    expect(set.dense).toBe(dense);
    expect(set.has(a)).toBe(false);
    expect(set.size).toBe(1);
    world.dispose();
  });

  it("removes a visited member without visiting another survivor twice", () => {
    const world = new World();
    const entities = Array.from({ length: 4 }, () => world.entity());
    const set = new DenseEntitySet();
    entities.forEach((entity) => set.add(entity));
    const seen: Entity[] = [];
    set.forEachLive((entity) => {
      seen.push(entity);
      if (seen.length === 2) {
        set.delete(seen[0]!);
      }
    });
    expect(seen).toHaveLength(4);
    expect(new Set(seen)).toEqual(new Set(entities));
    expect(set.has(seen[0]!)).toBe(false);
    world.dispose();
  });

  it("supports nested callback and generator cursors at the same boundary", () => {
    const world = new World();
    const entities = Array.from({ length: 4 }, () => world.entity());
    const set = new DenseEntitySet();
    entities.forEach((entity) => set.add(entity));
    const outer = set[Symbol.iterator]();
    expect(outer.next().value).toBe(entities[0]);
    const seen: Entity[] = [];
    set.forEachLive((entity) => {
      seen.push(entity);
      set.delete(entity);
    });
    expect(seen).toHaveLength(4);
    expect(new Set(seen)).toEqual(new Set(entities));
    expect(outer.next().done).toBe(true);
    expect(set.size).toBe(0);
    world.dispose();
  });

  it("releases traversals on break, return and throw", () => {
    const world = new World();
    const entities = Array.from({ length: 4 }, () => world.entity());
    const set = new DenseEntitySet();
    entities.forEach((entity) => set.add(entity));
    for (const _entity of set) {
      break;
    }
    const iterator = set[Symbol.iterator]();
    iterator.next();
    iterator.return?.();
    expect(() => {
      for (const _entity of set) {
        throw new Error("stop");
      }
    }).toThrow("stop");
    expect(() =>
      set.forEachLive(() => {
        throw new Error("stop");
      })
    ).toThrow("stop");
    set.delete(entities[0]!);
    // With no active cursor, removal uses the tail rather than a visited boundary.
    expect([...set]).toEqual([entities[3], entities[1], entities[2]]);
    world.dispose();
  });

  it.each([
    ["iterator", "clear"],
    ["iterator", "delete"],
    ["callback", "clear"],
    ["callback", "delete"],
  ] as const)("promotes and empties during active %s traversal via %s", (kind, removal) => {
    const world = densityWorld();
    const entities = Array.from({ length: 65 }, () => world.entity());
    const replacement = world.entity();
    const set = new DenseEntitySet().add(entities[0]!);
    const dense = set.dense;
    const seen: Entity[] = [];
    const visit = (entity: Entity): void => {
      seen.push(entity);
      if (entity === entities[0]) {
        for (const added of entities) {
          set.add(added);
        }
        expect(set.size).toBe(65);
        for (const member of entities) {
          expect(set.has(member)).toBe(true);
          expect(set.indexOf(member)).toBe(dense.indexOf(member));
        }
        if (removal === "clear") {
          set.clear();
        } else {
          for (const removed of entities) {
            expect(set.delete(removed)).toBe(true);
          }
        }
        expect(set.size).toBe(0);
        for (const removed of entities) {
          expect(set.indexOf(removed)).toBe(-1);
        }
        set.add(replacement);
      }
    };
    if (kind === "callback") {
      set.forEachLive(visit);
    } else {
      for (const entity of set) {
        visit(entity);
      }
    }
    expect(seen).toEqual([entities[0], replacement]);
    expect(set.dense).toBe(dense);
    expect(set.indexOf(replacement)).toBe(0);
    world.dispose();
  });

  it("recomputes density after removing the highest hashed member id", () => {
    const world = densityWorld();
    const high = world.getOrCreateEntity(100_000);
    const entities = Array.from({ length: 65 }, () => world.entity());
    const set = new DenseEntitySet().add(high);
    const iterator = set[Symbol.iterator]();
    expect(iterator.next().value).toBe(high);
    expect(set.delete(high)).toBe(true);
    // Keep a hashed population alive while removing its maximum, then insert
    // enough low-id members to justify direct lookup for every measured ratio.
    set.add(high).add(entities[0]!);
    expect(set.delete(high)).toBe(true);
    entities.forEach((entity) => set.add(entity));
    expect(new Set(iterator)).toEqual(new Set(entities));
    expect(set.has(high)).toBe(false);
    for (const entity of entities) {
      expect(set.indexOf(entity)).toBe(set.dense.indexOf(entity));
    }
    world.dispose();
  });

  describe.each([4, 128])("Set visitation oracle with a pool of %i members", (poolSize) => {
    it.each([1, 42, 0x5eed, 0xabcdef])(
      "matches a Set visitation oracle under interleaved nested mutation (seed %i)",
      (seed) => {
        const world = densityWorld();
        const entities = Array.from({ length: poolSize }, () => world.entity());
        const highest = Math.max(...entities.map((entity) => entity.eid));
        // Guard both fixtures across the measured density ratios 4, 8 and 16.
        if (poolSize === 128) {
          expect(poolSize * 4).toBeGreaterThanOrEqual(highest + 1);
        } else {
          expect(poolSize * 16).toBeLessThan(highest + 1);
        }
        const set = new DenseEntitySet();
        entities.forEach((entity) => set.add(entity));
        const oracle = new Set<Entity>(entities);
        // Each Set is the unvisited membership for one active traversal. This
        // compares Set visitation guarantees, not its insertion order: dense
        // removal deliberately leaves member order unspecified.
        const cursors: { iterator: IterableIterator<Entity>; pending: Set<Entity> }[] = [];
        let state = seed;
        const random = (n: number): number => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return (state >>> 8) % n;
        };
        for (let step = 0; step < 2_000; step++) {
          const entity = entities[random(entities.length)]!;
          switch (random(6)) {
            case 0:
            case 1:
              if (!oracle.has(entity)) {
                for (const cursor of cursors) {
                  cursor.pending.add(entity);
                }
              }
              oracle.add(entity);
              set.add(entity);
              break;
            case 2:
              expect(set.delete(entity)).toBe(oracle.delete(entity));
              for (const cursor of cursors) {
                cursor.pending.delete(entity);
              }
              break;
            case 3:
              if (cursors.length < 6) {
                cursors.push({ iterator: set[Symbol.iterator](), pending: new Set(oracle) });
                // Register the cursor now: generators start on the first next().
                const cursor = cursors[cursors.length - 1]!;
                const result = cursor.iterator.next();
                if (!result.done) {
                  expect(cursor.pending.delete(result.value)).toBe(true);
                } else {
                  expect(cursor.pending.size).toBe(0);
                  cursors.pop();
                }
              }
              break;
            case 4:
            case 5: {
              if (cursors.length === 0) {
                break;
              }
              const index = random(cursors.length);
              const cursor = cursors[index]!;
              const result = cursor.iterator.next();
              if (result.done) {
                expect(cursor.pending.size).toBe(0);
                cursors.splice(index, 1);
              } else {
                expect(cursor.pending.delete(result.value)).toBe(true);
              }
              break;
            }
          }
          expect(set.size).toBe(oracle.size);
          for (const candidate of entities) {
            expect(set.has(candidate)).toBe(oracle.has(candidate));
          }
        }
        for (const cursor of cursors) {
          for (const entity of cursor.iterator) {
            expect(cursor.pending.delete(entity)).toBe(true);
          }
          expect(cursor.pending.size).toBe(0);
        }
        expect(new Set(set)).toEqual(oracle);
        world.dispose();
      },
      // Full membership assertions took ~5 s for a large-pool seed while two
      // workers shared one CPU; retain the scenario with a bounded 3x budget.
      poolSize === 128 ? 15_000 : 5_000
    );
  });
});

function densityWorld(): World {
  return new World({
    idPools: [
      { name: "component", min: 1, max: 63 },
      { name: "module", min: 64, max: 99 },
      { name: "entity", min: 100, reuseWaitFrames: 0 },
    ],
  });
}
