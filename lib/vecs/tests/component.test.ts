import { describe, it, expect, vi } from "vitest";
import { ComponentDef, Entity, Module, ModuleDef, OnDelete, Throw, World } from "../src/index.js";

class Health {
  hp = 10;
}

describe("ComponentMeta", () => {
  it("stores the component eid", () => {
    const w = new World();
    const component = w.component(Health);
    expect(component.meta.eid).toBe(component.eid);
  });

  it("entity.modified(C) queues an onSet hook delivery", () => {
    const w = new World();
    w.component(Health);
    const onSet = vi.fn();
    w.component(Health).on("set", onSet);
    const e = w.entity();
    const h = e.add(Health).get(Health)!;
    e.modified(Health);
    w.progress(0, 0);
    expect(onSet).toHaveBeenCalledWith(e, h);
  });

  it("entity.modified(C) in deferred mode is coalesced — onSet fires once even if called multiple times", () => {
    const w = new World();
    w.component(Health);
    const onSet = vi.fn();
    w.component(Health).on("set", onSet);
    const e = w.entity();
    e.add(Health);
    onSet.mockClear();
    w.beginDefer();
    e.modified(Health);
    e.modified(Health);
    e.modified(Health);
    w.endDefer();
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("entity.modified(C) at top level fires onSet immediately on each call", () => {
    const w = new World();
    w.component(Health);
    const onSet = vi.fn();
    w.component(Health).on("set", onSet);
    const e = w.entity();
    e.add(Health);
    onSet.mockClear();
    e.modified(Health);
    e.modified(Health);
    e.modified(Health);
    expect(onSet).toHaveBeenCalledTimes(3);
  });
});

describe("Entity.modified", () => {
  it("returns the entity for chaining", () => {
    const w = new World();
    w.component(Health);
    const e = w.entity();
    e.add(Health);
    expect(e.modified(Health)).toBe(e);
  });

  it("queues an onSet hook delivery", () => {
    const w = new World();
    w.component(Health);
    const onSet = vi.fn();
    w.component(Health).on("set", onSet);
    const e = w.entity();
    const h = e.add(Health).get(Health)!;
    e.modified(Health);
    w.progress(0, 0);
    expect(onSet).toHaveBeenCalledWith(e, h);
  });

  it("is coalesced in deferred mode — onSet fires once even if called multiple times", () => {
    const w = new World();
    w.component(Health);
    const onSet = vi.fn();
    w.component(Health).on("set", onSet);
    const e = w.entity();
    e.add(Health);
    onSet.mockClear();
    w.beginDefer();
    e.modified(Health);
    e.modified(Health);
    e.modified(Health);
    w.endDefer();
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("can be chained after add", () => {
    const w = new World();
    w.component(Health);
    const onSet = vi.fn();
    w.component(Health).on("set", onSet);
    const e = w.entity();
    e.add(Health).modified(Health);
    w.progress(0, 0);
    expect(onSet).toHaveBeenCalledTimes(1);
  });
});

describe("Hook", () => {
  it("onAdd fires when a component is first attached", () => {
    const w = new World();
    w.component(Health);
    const onAdd = vi.fn();
    w.component(Health).on("add", onAdd);
    const e = w.entity();
    const h = e.add(Health).get(Health)!;
    expect(onAdd).toHaveBeenCalledWith(e, h);
  });

  it("hooks can be registered after component registration", () => {
    const w = new World();
    w.component(Health);
    const onAdd = vi.fn();

    w.component(Health).on("add", onAdd);
    const e = w.entity();
    const h = e.add(Health).get(Health)!;

    expect(onAdd).toHaveBeenCalledWith(e, h);
  });

  it("onSet fires when a component value is set", () => {
    const w = new World();
    w.component(Health);

    const set_values: number[] = [];
    const onSet = vi.fn((_e, c) => set_values.push(c.hp));

    const onAdd = vi.fn();
    w.component(Health).on("set", onSet).on("add", onAdd);
    const e = w.entity();
    const h = e.set(Health, { hp: 99 }).get(Health)!;

    e.set(Health, { hp: 200 });

    expect(onAdd).toHaveBeenCalledWith(e, h);
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onSet).toHaveBeenCalledWith(e, h);
    expect(onSet).toHaveBeenCalledTimes(2);
    expect(set_values).toEqual([99, 200]);
  });

  it("onRemove fires when a component is removed", () => {
    const w = new World();
    w.component(Health);
    const onRemove = vi.fn();
    w.component(Health).on("remove", onRemove);
    const e = w.entity();
    const h = e.add(Health).get(Health)!;
    e.remove(Health);
    expect(onRemove).toHaveBeenCalledWith(e, h);
  });

  it("onRemove fires when the entity is destroyed", () => {
    const w = new World();
    w.component(Health);
    const onRemove = vi.fn();
    w.component(Health).on("remove", onRemove);
    const e = w.entity();
    e.add(Health);
    e.destroy();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("hooks are chainable on the same Hook object", () => {
    const w = new World();
    w.component(Health);
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const result = w.component(Health).on("add", a).on("remove", b).on("set", c);
    expect(result).toBe(w.component(Health));
  });

  it("hook handlers compose in registration order and can be removed by reference", () => {
    const w = new World();
    const component = w.component(Health);
    const calls: string[] = [];
    const add = () => calls.push("add");
    const set = () => calls.push("set");
    const remove = () => calls.push("remove");

    // Multiple handlers on the same event fire in registration order.
    component.on("add", () => calls.push("first add"));
    component.on("add", add);

    component.on("set", () => calls.push("first set"));
    component.on("set", set);

    component.on("remove", () => calls.push("first remove"));
    component.on("remove", remove);

    const e = w.entity();
    e.set(Health, {});
    e.remove(Health);

    expect(calls).toEqual(["first add", "add", "first set", "set", "first remove", "remove"]);

    // off removes a handler by reference; the remaining handler still fires.
    component.off("add", add);
    component.off("set", set);
    component.off("remove", remove);

    w.entity().set(Health, {}).remove(Health);
    expect(calls).toEqual([
      "first add",
      "add",
      "first set",
      "set",
      "first remove",
      "remove",
      "first add",
      "first set",
      "first remove",
    ]);
  });
});

describe("Entity.isComponent", () => {
  it("is true only for definition entities, which are plain entities", () => {
    class Feature extends Module {
      public init(): void {}
    }
    const world = new World();
    const definition = world.component(Health);
    const key = world.entity();
    world.entity().add(key);
    const destroyed = world.component(class Dropped {});

    expect(definition.isComponent).toBe(true);
    expect(world.module(Feature).entity.isComponent).toBe(true);
    expect(world.entity().isComponent).toBe(false);
    expect(key.meta.Class).toBe(Object);
    expect(key.isComponent).toBe(false);
    expect(Object.getPrototypeOf(definition)).toBe(Entity.prototype);
    expect(destroyed.has(ComponentDef)).toBe(true);
    destroyed.destroy();
    expect(destroyed.isComponent).toBe(false);
  });

  it("identifies a definition through lookup, capture and unregistration, unlike a key", () => {
    class Tagged {
      value = 1;
    }
    const world = new World();
    const definition = world.component(Tagged);
    definition.name = "TaggedDefinition";
    const key = world.entity();
    world.entity().add(key);

    expect(definition.isComponent).toBe(true);
    expect(key.isComponent).toBe(false);
    expect(world.component("TaggedDefinition")).toBe(definition);
    expect(() => world.snapshotSubtree(definition)).toThrow(/Cannot snapshot component entity/);

    const carrier = world.entity().add(Tagged).add(key);
    const snapshot = world.snapshotSubtree(carrier);
    expect(snapshot.entities[0].components.map((component) => component.Class)).toEqual([Tagged]);

    carrier.destroy();
    definition.destroy();
    expect(world.getEntity(Tagged)).toBeUndefined();
  });

  it("disposes a definition as infrastructure, after its carriers", () => {
    class Tagged {}
    const world = new World();
    const definition = world.component(Tagged);
    const removed: Entity[] = [];
    definition.on("remove", (entity) => removed.push(entity));
    const carrier = world.entity().add(Tagged);

    world.dispose();

    expect(removed).toEqual([carrier]);
    expect(definition.destroyed).toBe(true);
    expect(world.entities.size).toBe(0);
  });

  it("throws when destroying a schema marker that a definition carries", () => {
    class Feature extends Module {
      public init(): void {}
    }
    const world = new World();
    world.component(Health);
    world.module(Feature);

    for (const Marker of [ComponentDef, ModuleDef]) {
      const marker = world.component(Marker);
      expect(marker.meta._onDelete, Marker.name).toBe("throw");
      expect(marker.target(OnDelete), Marker.name).toBe(world.component(Throw));
      expect(() => marker.destroy(), Marker.name).toThrow("component eid is still in use");
      expect(marker.alive, Marker.name).toBe(true);
    }
  });

  it("does not install the declaration builders as own properties", () => {
    const world = new World();
    const definition = world.component(Health).member("hp", "u8").range(0, 100);

    expect(Object.keys(definition)).toEqual(Object.keys(world.entity()));
    expect(Object.keys(Entity.prototype)).not.toContain("member");
    expect(definition.meta._currentMember).toBe("hp");
  });
});
