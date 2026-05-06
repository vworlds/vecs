import { describe, it, expect, vi } from "vitest";
import { World, Component } from "../src/index.js";
import { makeWorldWithFlushPhase } from "./_helpers.js";

class Position extends Component {
  x = 0;
  y = 0;
}
class Velocity extends Component {
  vx = 0;
}

describe("Entity — components", () => {
  it("add returns the entity for chaining", () => {
    const w = new World();
    w.registerComponent(Position);
    const e = w.entity();
    expect(e.add(Position)).toBe(e);
    const pos = e.get(Position)!;
    expect(pos).toBeInstanceOf(Position);
    expect(pos.entity).toBe(e);
    expect(pos.x).toBe(0);
  });

  it("add is idempotent — same instance is returned on repeat", () => {
    const w = new World();
    w.registerComponent(Position);
    const e = w.entity();
    const a = e.add(Position).get(Position);
    const b = e.add(Position).get(Position);
    expect(a).toBe(b);
  });

  it("add(typeId) works with numeric type ids", () => {
    const w = new World();
    w.registerComponent(Position, 5);
    const e = w.entity();
    const pos = e.add(5).get(5);
    expect(pos).toBeInstanceOf(Position);
  });

  it("set returns the entity for chaining", () => {
    const w = new World();
    w.registerComponent(Position);
    const e = w.entity();
    expect(e.set(Position, { x: 10, y: 20 })).toBe(e);
    const pos = e.get(Position)!;
    expect(pos).toBeInstanceOf(Position);
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(20);
  });

  it("set is idempotent — same instance is kept with updated properties", () => {
    const w = new World();
    w.registerComponent(Position);
    const e = w.entity();
    const a = e.set(Position, { x: 1 }).get(Position);
    const b = e.set(Position, { x: 99 }).get(Position);
    expect(a).toBe(b);
    expect(a!.x).toBe(99);
  });

  it("set only assigns present properties — absent keys leave defaults intact", () => {
    const w = new World();
    w.registerComponent(Position);
    const e = w.entity();
    const pos = e.set(Position, { x: 5 }).get(Position)!;
    expect(pos.x).toBe(5);
    expect(pos.y).toBe(0); // default unchanged
  });

  it("set(typeId, props) works with numeric type ids", () => {
    const w = new World();
    w.registerComponent(Position, 7);
    const e = w.entity();
    const pos = e.set(7, {}).get(7);
    expect(pos).toBeInstanceOf(Position);
  });

  it("set marks a new component as modified", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Position);
    env.start();
    const onSet = vi.fn();
    env.w.hook(Position).onSet(onSet);
    const e = env.w.entity();
    e.set(Position, { x: 1 });
    env.tick();
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("set marks an already-present component as modified", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Position);
    env.start();
    const onSet = vi.fn();
    env.w.hook(Position).onSet(onSet);
    const e = env.w.entity();
    e.add(Position);
    env.tick(); // flush the initial add notification
    onSet.mockClear();
    e.set(Position, { x: 42 });
    env.tick();
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("get returns the component or undefined", () => {
    const w = new World();
    w.registerComponent(Position);
    const e = w.entity();
    expect(e.get(Position)).toBeUndefined();
    expect(e.add(Position).get(Position)).toBeInstanceOf(Position);
  });

  it("remove detaches a component", () => {
    const w = new World();
    w.registerComponent(Position);
    const e = w.entity();
    e.add(Position);
    e.remove(Position);
    expect(e.get(Position)).toBeUndefined();
  });

  it("componentBitmask reflects added/removed components", () => {
    const w = new World();
    w.registerComponent(Position);
    w.registerComponent(Velocity);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    expect(e.componentBitmask.has(w.getComponentType(Position))).toBe(true);
    expect(e.componentBitmask.has(w.getComponentType(Velocity))).toBe(true);
    e.remove(Position);
    expect(e.componentBitmask.has(w.getComponentType(Position))).toBe(false);
  });

  it("empty reflects whether any components remain", () => {
    const w = new World();
    w.registerComponent(Position);
    const e = w.entity();
    expect(e.empty).toBe(true);
    e.add(Position);
    expect(e.empty).toBe(false);
    e.remove(Position);
    expect(e.empty).toBe(true);
  });

  it("forEachComponent visits every attached component", () => {
    const w = new World();
    w.registerComponent(Position);
    w.registerComponent(Velocity);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    const seen: string[] = [];
    e.forEachComponent((c) => seen.push(c.toString()));
    expect(seen.sort()).toEqual(["Position", "Velocity"]);
  });

  it("toString returns Entity{eid}", () => {
    const w = new World();
    const e = w.entity();
    expect(e.toString()).toBe(`Entity${e.eid}`);
  });
});

describe("Entity — lifecycle and hierarchy", () => {
  it("destroy emits the 'destroy' event", () => {
    const env = makeWorldWithFlushPhase();
    env.start();
    const e = env.w.entity();
    const cb = vi.fn();
    e.events.on("destroy", cb);
    e.destroy();
    env.tick();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("destroy removes the entity from the world map", () => {
    const env = makeWorldWithFlushPhase();
    env.start();
    const e = env.w.entity();
    e.destroy();
    expect(env.w.entity(e.eid)).toBeUndefined();
  });

  it("destroy recursively destroys children", () => {
    const env = makeWorldWithFlushPhase();
    env.start();
    const parent = env.w.entity();
    const child = env.w.entity();
    child.setParent(parent);

    const childDestroyed = vi.fn();
    child.events.on("destroy", childDestroyed);
    parent.destroy();
    env.tick();
    expect(childDestroyed).toHaveBeenCalled();
    expect(env.w.entity(child.eid)).toBeUndefined();
    expect(env.w.entity(parent.eid)).toBeUndefined();
  });

  it("destroy unlinks from parent and triggers parent's archetype update", () => {
    const env = makeWorldWithFlushPhase();
    env.start();
    const parent = env.w.entity();
    const child = env.w.entity();
    child.setParent(parent);

    child.destroy();
    env.tick();
    expect(parent.children.has(child)).toBe(false);
    expect(child.parent).toBeUndefined();
    expect(env.w.entity(parent.eid)).toBe(parent);
  });

  it("destroy is re-entrant safe", () => {
    const env = makeWorldWithFlushPhase();
    env.start();
    const e = env.w.entity();
    const cb = vi.fn(() => e.destroy());
    e.events.on("destroy", cb);
    e.destroy();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("_setParent does not mutate a destroyed entity", () => {
    const env = makeWorldWithFlushPhase();
    env.start();
    const parent = env.w.entity();
    const child = env.w.entity();

    child.destroy();
    child._setParent(parent);

    expect(child.parent).toBeUndefined();
    expect(parent.children.has(child)).toBe(false);
  });

  it("children returns an empty ReadonlySet before any child is added", () => {
    const w = new World();
    const e = w.entity();
    expect(e.children.size).toBe(0);
  });

  it("properties is a free-form map", () => {
    const w = new World();
    const e = w.entity();
    e.properties.set("kind", "bullet");
    expect(e.properties.get("kind")).toBe("bullet");
  });
});

describe("Entity — setParent / parent hierarchy", () => {
  it("setParent links parent and child bidirectionally", () => {
    const w = new World();
    const parent = w.entity();
    const child = w.entity();
    child.setParent(parent);
    expect(child.parent).toBe(parent);
    expect(parent.children.has(child)).toBe(true);
  });

  it("setParent(undefined) unlinks from parent", () => {
    const w = new World();
    const parent = w.entity();
    const child = w.entity();
    child.setParent(parent);
    child.setParent(undefined);
    expect(child.parent).toBeUndefined();
    expect(parent.children.has(child)).toBe(false);
  });

  it("setParent moves child from old parent to new parent", () => {
    const w = new World();
    const p1 = w.entity();
    const p2 = w.entity();
    const child = w.entity();
    child.setParent(p1);
    child.setParent(p2);
    expect(child.parent).toBe(p2);
    expect(p1.children.has(child)).toBe(false);
    expect(p2.children.has(child)).toBe(true);
  });

  it("_setParent throws on direct circular reference", () => {
    const w = new World();
    const a = w.entity();
    expect(() => a.setParent(a)).toThrow();
  });

  it("_setParent throws on indirect circular reference", () => {
    const w = new World();
    const a = w.entity();
    const b = w.entity();
    const c = w.entity();
    b.setParent(a);
    c.setParent(b);
    expect(() => a.setParent(c)).toThrow();
  });

  it("setParent in deferred mode is not visible until queue drains", () => {
    const env = makeWorldWithFlushPhase();
    env.start();
    const parent = env.w.entity();
    const child = env.w.entity();
    env.w.beginDefer();
    child.setParent(parent);
    expect(child.parent).toBeUndefined();
    expect(parent.children.has(child)).toBe(false);
    env.w.endDefer();
    expect(child.parent).toBe(parent);
    expect(parent.children.has(child)).toBe(true);
  });
});
