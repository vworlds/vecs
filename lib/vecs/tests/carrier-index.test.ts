import { describe, expect, it } from "vitest";
import {
  Delete,
  Entity,
  Exclusive,
  Module,
  OnDelete,
  Relationship,
  Remove,
  Singleton,
  World,
} from "../src/index.js";
import { carriersFirst, isCarried } from "../src/world/destroy-order.js";

class Data {
  value = 0;
}
class Link extends Relationship {}

describe("component carrier index", () => {
  it("exposes staged membership in a direct leaf query during add hooks, before enter", () => {
    const world = new World();
    const component = world.component(Data);
    const events: string[] = [];
    const query = world
      .query("data")
      .with(Data)
      .enter(() => events.push("enter"))
      .exit(() => expect(component.meta.usageCount).toBe(0))
      .build();
    class Other {}
    world.component(Other);
    const composite = world
      .query("composite")
      .with(Data, Other)
      .enter(() => events.push("composite"))
      .build();
    const entity = world.entity().add(Other);
    component.on("add", (added) => {
      expect(added).toBe(entity);
      expect(component.meta.usageCount).toBe(1);
      expect([...query]).toEqual([entity]);
      expect(query.count).toBe(1);
      expect([...composite]).toEqual([]);
      expect(events).toEqual([]);
      events.push("add");
    });

    entity.add(Data);
    expect(events).toEqual(["add", "enter", "composite"]);
    expect([...composite]).toEqual([entity]);
    entity.remove(Data);
    expect(component.meta.usageCount).toBe(0);
    expect([...query]).toEqual([]);
  });

  it("counts unqueried components through attach, replace, remove and carrier-first teardown", () => {
    const world = new World();
    const component = world.component(Data);
    const first = world.entity().add(Data);
    const second = world.entity().attach(new Data());
    expect(component.meta.usageCount).toBe(2);
    first.set(Data, { value: 42 });
    expect(component.meta.usageCount).toBe(2);
    expect(isCarried(component)).toBe(true);
    expect(carriersFirst([component, first, second])).toEqual([first, second, component]);
    expect(carriersFirst([component, first])).toEqual([first]);
    second.remove(Data);
    expect(component.meta.usageCount).toBe(1);
    const removed: Entity[] = [];
    component.on("remove", (e) => removed.push(e));
    world.clearAllEntities();
    expect(removed).toEqual([first]);
    expect(component.meta.usageCount).toBe(0);
    world.dispose();
    expect(world.entities.size).toBe(0);
  });

  it("initializes singleton components and module singleton values", () => {
    class Feature extends Module {
      public init(): void {}
    }
    const world = new World();
    const component = world.component(Data).add(Singleton);
    const feature = world.module(Feature);
    expect(world.get(Data)).toEqual(new Data());
    expect(component.meta.usageCount).toBe(1);
    expect(world.get(Feature)).toBe(feature);
    expect(feature.meta.usageCount).toBe(1);
    expect(() => world.entity().add(Data)).toThrow("Cannot add singleton component");
  });

  it("stages relationship counts before target/add hooks and enters after them", () => {
    const world = new World();
    const component = world.component(Link).add(Exclusive);
    const events: string[] = [];
    const query = world
      .query("links")
      .with(Link)
      .enter(() => events.push("enter"))
      .build();
    component.on("targetAdd", (e) => {
      expect(component.meta.usageCount).toBe(1);
      expect([...query]).toEqual([e]);
      events.push("targetAdd");
    });
    component.on("add", () => events.push("add"));
    const first = world.entity();
    const second = world.entity();
    const carrier = world.entity().add(Link, first);
    expect(events).toEqual(["targetAdd", "add", "enter"]);
    carrier.add(Link, second);
    expect(component.meta.usageCount).toBe(1);
    expect(events).toEqual(["targetAdd", "add", "enter", "targetAdd"]);
    carrier.remove(Link);
    expect(component.meta.usageCount).toBe(0);
    expect([...query]).toEqual([]);
  });

  it("destroys carriers of carriers exactly once while nested cascades delete upcoming members", () => {
    const world = new World();
    const root = world.entity().add(OnDelete, Delete);
    const first = world.entity().add(OnDelete, Delete).add(root);
    const second = world.entity().add(OnDelete, Delete).add(root).add(first);
    const third = world.entity().add(root).add(second);
    const counts = new Map<Entity, number>();
    world.component(Data).on("remove", (e) => counts.set(e, (counts.get(e) ?? 0) + 1));
    const all = [root, first, second, third];
    for (const entity of all) {
      entity.add(Data);
    }

    root.destroy();

    expect([...counts.keys()]).toEqual([third, second, first, root]);
    for (const entity of all) {
      expect(entity.destroyed).toBe(true);
      expect(counts.get(entity)).toBe(1);
      expect(entity.meta.usageCount).toBe(0);
      expect(world.getEntity(entity.eid)).toBeUndefined();
    }
  });

  it("visits carriers added during a live Remove cleanup scan", () => {
    const world = new World();
    const key = world.entity().add(OnDelete, Remove);
    const first = world.entity().add(key);
    const later = world.entity();
    const removed: Entity[] = [];
    key.on("remove", (e) => {
      removed.push(e);
      if (e === first) {
        later.add(key);
      }
    });

    key.destroy();

    expect(removed).toEqual([first, later]);
    expect(first.has(key.eid)).toBe(false);
    expect(later.has(key.eid)).toBe(false);
    expect(key.meta.usageCount).toBe(0);
    expect(first.destroyed).toBe(false);
    expect(later.destroyed).toBe(false);
  });
});
