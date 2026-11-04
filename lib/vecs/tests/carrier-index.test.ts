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

  it("removes a component inside its own add hook without exit or later entry", () => {
    const world = new World();
    const component = world.component(Data);
    const events: string[] = [];
    const query = world
      .query("data")
      .with(Data)
      .enter(() => events.push("enter"))
      .exit(() => events.push("exit"))
      .build();
    component.on("add", (e) => e.remove(Data));

    const entity = world.entity().add(Data);

    expect(events).toEqual([]);
    expect(entity.has(Data)).toBe(false);
    expect([...query]).toEqual([]);
    expect(component.meta.usageCount).toBe(0);
  });

  it("removes a relationship inside its own targetAdd hook without exit or later entry", () => {
    const world = new World();
    const component = world.component(Link);
    const events: string[] = [];
    const query = world
      .query("links")
      .with(Link)
      .enter(() => events.push("enter"))
      .exit(() => events.push("exit"))
      .build();
    component.on("targetAdd", (source) => source.remove(Link));

    const entity = world.entity().add(Link, world.entity());

    expect(events).toEqual([]);
    expect(entity.has(Link)).toBe(false);
    expect([...query]).toEqual([]);
    expect(component.meta.usageCount).toBe(0);
  });

  it("enters a staged entity once into a query built inside its add hook", () => {
    const world = new World();
    const component = world.component(Data);
    const entered: Entity[] = [];
    let query: ReturnType<World["query"]> | undefined;
    component.on("add", () => {
      query = world
        .query("built-in-add")
        .with(Data)
        .enter((e) => entered.push(e))
        .build();
    });

    const entity = world.entity().add(Data);

    expect(entered).toEqual([entity]);
    expect([...query!]).toEqual([entity]);
  });

  it("exits a staged entity once from queries that saw it inside its add hook", () => {
    class Other {}
    const world = new World();
    const component = world.component(Data);
    world.component(Other);
    const events: string[] = [];
    const before = world
      .query("before")
      .with(Data)
      .enter(() => events.push("before:enter"))
      .exit(() => events.push("before:exit"))
      .build();
    const queries: ReturnType<World["query"]>[] = [];
    component.on("add", (e) => {
      queries.push(
        world
          .query("leaf")
          .with(Data)
          .enter(() => events.push("leaf:enter"))
          .exit(() => events.push("leaf:exit"))
          .build(),
        world
          .query("composite")
          .with(Data, Other)
          .enter(() => events.push("composite:enter"))
          .exit(() => events.push("composite:exit"))
          .build()
      );
      e.remove(Data);
    });

    const entity = world.entity().add(Other).add(Data);

    expect(events).toEqual(["leaf:enter", "composite:enter", "leaf:exit", "composite:exit"]);
    expect([...before]).toEqual([]);
    expect(queries.map((q) => [...q])).toEqual([[], []]);
    expect(entity.has(Data)).toBe(false);
  });

  it("enters once when an add hook removes and re-adds its own component", () => {
    const world = new World();
    const component = world.component(Data);
    const events: string[] = [];
    const query = world
      .query("data")
      .with(Data)
      .enter(() => events.push("enter"))
      .exit(() => events.push("exit"))
      .build();
    let reentered = false;
    component.on("add", (e) => {
      if (!reentered) {
        reentered = true;
        e.remove(Data);
        e.add(Data);
      }
    });

    const entity = world.entity().add(Data);

    expect(events).toEqual(["enter"]);
    expect([...query]).toEqual([entity]);
    expect(component.meta.usageCount).toBe(1);
  });

  it("enters nested staged adds of one component exactly once each", () => {
    const world = new World();
    const component = world.component(Data);
    const entered: Entity[] = [];
    const query = world
      .query("data")
      .with(Data)
      .enter((e) => entered.push(e))
      .build();
    const inner = world.entity();
    component.on("add", (e) => {
      if (e !== inner) {
        inner.add(Data);
      }
    });

    const outer = world.entity().add(Data);

    expect(entered).toEqual([inner, outer]);
    expect([...query]).toEqual([outer, inner]);
  });

  it("discards the staged entry when an add hook throws", () => {
    const world = new World();
    const component = world.component(Data);
    const other = world.entity().add(Data);
    const throwing = (): void => {
      throw new Error("hook failed");
    };
    component.on("add", throwing);

    const failed = world.entity();
    expect(() => failed.add(Data)).toThrow("hook failed");
    component.off("add", throwing);
    other.remove(Data);

    expect(component.meta._term._stagedCount).toBe(0);
    const entered: Entity[] = [];
    const exited: Entity[] = [];
    world
      .query("later")
      .with(Data)
      .enter((e) => entered.push(e))
      .exit((e) => exited.push(e))
      .build();
    const added = world.entity().add(Data);
    added.remove(Data);
    failed.remove(Data);
    expect(entered).toEqual([failed, added]);
    expect(exited).toEqual([added, failed]);
    expect(component.meta._term._stagedCount).toBe(0);
  });

  it.each([
    ["non-exclusive", false],
    ["exclusive", true],
  ])("enters a %s relationship once when its targetAdd hook retargets it", (_kind, exclusive) => {
    const world = new World();
    const component = world.component(Link);
    if (exclusive) {
      component.add(Exclusive);
    }
    const entered: Entity[] = [];
    const exited: Entity[] = [];
    const query = world
      .query("links")
      .with(Link)
      .enter((e) => entered.push(e))
      .exit((e) => exited.push(e))
      .build();
    const first = world.entity();
    const second = world.entity();
    const added: Entity[] = [];
    component.on("add", (e) => added.push(e));
    component.on("targetAdd", (source, _link, target) => {
      if (target === first) {
        source.add(Link, second);
        source.remove(Link, first);
      }
    });

    const entity = world.entity().add(Link, first);

    expect(entity.has(Link)).toBe(true);
    expect(entity.targets(Link)).toEqual([second]);
    expect([...query]).toEqual([entity]);
    expect(entered).toEqual([entity]);
    expect(exited).toEqual([]);
    expect(added).toEqual([entity]);
    expect(component.meta._term._stagedCount).toBe(0);

    entity.remove(Link);
    expect(exited).toEqual([entity]);
    expect([...query]).toEqual([]);
  });

  it("leaves no staged entry when a targetAdd hook retargets a new relationship", () => {
    const world = new World();
    const component = world.component(Link);
    const first = world.entity();
    const second = world.entity();
    const other = world.entity().add(Link, first);
    const retarget = (source: Entity, _link: Relationship, target: Entity): void => {
      if (source !== other && target === first) {
        source.add(Link, second);
        source.remove(Link, first);
      }
    };
    component.on("targetAdd", retarget);

    const retargeted = world.entity().add(Link, first);
    component.off("targetAdd", retarget);
    other.remove(Link);

    expect(component.meta._term._stagedCount).toBe(0);
    const entered: Entity[] = [];
    const exited: Entity[] = [];
    world
      .query("later")
      .with(Link)
      .enter((e) => entered.push(e))
      .exit((e) => exited.push(e))
      .build();
    const added = world.entity().add(Link, first);
    added.remove(Link);
    expect(retargeted.has(Link)).toBe(true);
    expect(entered).toEqual([retargeted, added]);
    expect(exited).toEqual([added]);
    expect(component.meta._term._stagedCount).toBe(0);
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
