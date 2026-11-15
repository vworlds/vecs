import { describe, expect, it } from "vitest";
import { World, type Entity } from "../../src/index.js";
import { ComponentStore } from "../../src/util/component_store.js";
import { DenseEntitySet } from "../../src/util/dense_entity_set.js";

describe.each(["term", "store"] as const)("%s position density invariant", (kind) => {
  function fixture() {
    const world = new World();
    const container = kind === "term" ? new DenseEntitySet() : new ComponentStore();
    const values = new Map<Entity, { n: number }>();
    const add = (entity: Entity) => {
      const value = values.get(entity) ?? { n: entity.eid };
      values.set(entity, value);
      return container instanceof ComponentStore
        ? container.set(entity, value)
        : container.add(entity);
    };
    const check = (members: Entity[]) => {
      expect(new Set(container)).toEqual(new Set(members));
      expect(container.size).toBe(members.length);
      for (const member of members) {
        expect(container.has(member)).toBe(true);
        if (container instanceof ComponentStore) {
          expect(container.get(member)).toBe(values.get(member));
        }
      }
    };
    const low = Array.from({ length: 32 }, (_, i) => world.getOrCreateEntity(1000 + i));
    low.forEach(add);
    return { world, container, low, add, check };
  }

  it("demotes a bootstrap-promoted population before adding a distant member", () => {
    const { world, container, low, add, check } = fixture();
    const high = world.getOrCreateEntity(100000);
    expect(add(high)).toBe(true);
    expect(add(high)).toBe(false);
    check([...low, high]);
    container.delete(low[0]!);
    // Native sparse deletion keeps survivors in insertion order.
    expect([...container]).toEqual([...low.slice(1), high]);
    check([...low.slice(1), high]);
    world.dispose();
  });

  it("defers a density demotion through nested active traversal until an idle insert", () => {
    const { world, container, low, add, check } = fixture();
    const high = world.getOrCreateEntity(100000);
    const outer = container[Symbol.iterator]();
    expect(outer.next().value).toBe(low[0]);
    add(high);
    container.forEachLive(() => {
      // No mutation here: nested cursor registration must not release the outer pin.
      expect(container.has(high)).toBe(true);
    });
    container.delete(low[1]!);
    expect([...container]).toEqual([low[0], high, ...low.slice(2)]);
    expect(new Set(outer)).toEqual(new Set([high, ...low.slice(2)]));
    const later = world.getOrCreateEntity(1100);
    add(later);
    const before = [...container];
    container.delete(low[0]!);
    expect([...container]).toEqual(before.slice(1));
    check([...low.slice(2), high, later]);
    world.dispose();
  });

  it("keeps direct mode between promotion and the hysteresis boundary", () => {
    const { world, container, low, add, check } = fixture();
    // At 33 members: ordinary bound 1288, demotion bound 2576.
    const boundary = world.getOrCreateEntity(2500);
    for (let i = 0; i < 20; i++) {
      add(boundary);
      container.delete(low[0]!);
      expect([...container][0]).toBe(boundary);
      add(low[0]!);
      container.delete(boundary);
      check(low);
    }
    world.dispose();
  });
});
