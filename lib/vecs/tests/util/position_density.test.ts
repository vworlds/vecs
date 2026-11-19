import { describe, expect, it } from "vitest";
import { World, type Entity } from "../../src/index.js";
import { ComponentStore } from "../../src/util/component_store.js";
import { DenseEntitySet } from "../../src/util/dense_entity_set.js";

describe.each(["term", "store"] as const)("%s position density invariant", (kind) => {
  it("does not spend the low-id allowance on near-singletons", () => {
    const world = new World();
    const container = kind === "term" ? new DenseEntitySet() : new ComponentStore();
    const all = Array.from({ length: 7 }, (_, i) => world.getOrCreateEntity(1000 + i));
    for (const entity of all) {
      if (container instanceof ComponentStore) {
        container.set(entity, { n: entity.eid });
      } else {
        container.add(entity);
      }
    }
    container.delete(all[0]!);
    expect([...container]).toEqual(all.slice(1));
    all.slice(1).forEach((entity) => expect(container.has(entity)).toBe(true));
    world.dispose();
  });

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

  it("promotes past the bulk-zeroed position prefix and keeps other ids absent", () => {
    const world = new World();
    const container = kind === "term" ? new DenseEntitySet() : new ComponentStore();
    const insert = (entity: Entity) =>
      container instanceof ComponentStore
        ? container.set(entity, { n: entity.eid })
        : container.add(entity);
    // Ids from 4,000: the slack rule first holds at the 426th member, so the
    // promotion builds positions longer than the 2,048-slot template.
    const members = Array.from({ length: 430 }, (_, i) => world.getOrCreateEntity(4000 + i));
    members.forEach((member) => expect(insert(member)).toBe(true));
    const absent = [1001, 2047, 2048, 2049, 3999, 4430, 9000].map((id) =>
      world.getOrCreateEntity(id)
    );
    expect(container.size).toBe(430);
    members.forEach((member) => expect(container.has(member)).toBe(true));
    absent.forEach((entity) => expect(container.has(entity)).toBe(false));
    // Direct removal swaps the tail into the hole, which a sparse container would not do.
    container.delete(members[0]!);
    expect([...container][0]).toBe(members[429]);
    if (container instanceof ComponentStore) {
      expect(container.get(members[429]!)).toEqual({ n: members[429]!.eid });
      expect(container.get(absent[2]!)).toBeUndefined();
    }
    world.dispose();
  });

  it("stays correct across repeated empty-and-refill promotions", () => {
    const world = new World();
    const container = kind === "term" ? new DenseEntitySet() : new ComponentStore();
    const insert = (entity: Entity) =>
      container instanceof ComponentStore
        ? container.set(entity, { n: entity.eid })
        : container.add(entity);
    const all = Array.from({ length: 48 }, (_, i) => world.getOrCreateEntity(200 + i * 3));
    for (let cycle = 0; cycle < 4; cycle++) {
      // Each cycle promotes a different subset, so a position left over from an
      // earlier promotion would surface as a false member.
      const members = all.filter((_, i) => (i + cycle) % 2 === 0);
      members.forEach((member) => expect(insert(member)).toBe(true));
      expect(container.size).toBe(members.length);
      for (const entity of all) {
        expect(container.has(entity)).toBe(members.includes(entity));
      }
      expect(new Set(container)).toEqual(new Set(members));
      members.forEach((member) => expect(container.delete(member)).toBe(true));
      expect(container.size).toBe(0);
      all.forEach((entity) => expect(container.has(entity)).toBe(false));
    }
    world.dispose();
  });

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
