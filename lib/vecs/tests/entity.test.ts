import { describe, it, expect, vi } from "vitest";
import { ChildOf, CleanupPolicy, Relationship, World } from "../src/index.js";
import { makeWorldWithFlushPhase } from "./_helpers.js";

class Position {
  x = 0;
  y = 0;
}
class Velocity {
  vx = 0;
}
class FriendOf extends Relationship {}

describe("Entity — components", () => {
  it("add returns the entity for chaining", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    expect(e.add(Position)).toBe(e);
    const pos = e.get(Position)!;
    expect(pos).toBeInstanceOf(Position);
    expect(pos.x).toBe(0);
  });

  it("add is idempotent — same instance is returned on repeat", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    const a = e.add(Position).get(Position);
    const b = e.add(Position).get(Position);
    expect(a).toBe(b);
  });

  it("add(typeId) works with numeric type ids", () => {
    const w = new World();
    w.component(Position, 50);
    const e = w.entity();
    const pos = e.add(50).get(50);
    expect(pos).toBeInstanceOf(Position);
  });

  it("set returns the entity for chaining", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    expect(e.set(Position, { x: 10, y: 20 })).toBe(e);
    const pos = e.get(Position)!;
    expect(pos).toBeInstanceOf(Position);
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(20);
  });

  it("set is idempotent — same instance is kept with updated properties", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    const a = e.set(Position, { x: 1 }).get(Position);
    const b = e.set(Position, { x: 99 }).get(Position);
    expect(a).toBe(b);
    expect(a!.x).toBe(99);
  });

  it("set only assigns present properties — absent keys leave defaults intact", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    const pos = e.set(Position, { x: 5 }).get(Position)!;
    expect(pos.x).toBe(5);
    expect(pos.y).toBe(0); // default unchanged
  });

  it("set(typeId, props) works with numeric type ids", () => {
    const w = new World();
    w.component(Position, 7);
    const e = w.entity();
    const pos = e.set(7, {}).get(7);
    expect(pos).toBeInstanceOf(Position);
  });

  it("set/get/getMut/remove work with entity component refs", () => {
    const w = new World();
    const key = w.entity();
    const e = w.entity();

    e.set(key, { enabled: true });

    expect(e.get(key)).toMatchObject({ enabled: true });
    const component = e.getMut(key, (value) => Object.assign(value, { enabled: false }));
    expect(component).toMatchObject({ enabled: false });
    e.remove(key);
    expect(e.get(key)).toBeUndefined();
  });

  it("tracks usage count for entity component refs", () => {
    const w = new World();
    const key = w.entity();
    const e = w.entity();

    e.add(key);
    e.set(key, { enabled: true });
    expect(key.instanceCount()).toBe(1);
    expect(() => key.destroy()).toThrow();

    e.remove(key);
    expect(key.instanceCount()).toBe(0);
    expect(() => key.destroy()).not.toThrow();
  });

  it("attach stores the exact passed instance", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    const pos = new Position();
    e.attach(pos);
    expect(e.get(Position)).toBe(pos);
  });

  it("attach returns the entity for chaining", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    const pos = new Position();
    expect(e.attach(pos)).toBe(e);
  });

  it("attach throws for an unregistered component constructor", () => {
    const w = new World();
    const e = w.entity();
    const pos = new Position();
    expect(() => e.attach(pos)).toThrow(/unregistered component entity/);
  });

  it("attach replaces an existing stored instance without assigning into the old object", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    const pos1 = new Position();
    const pos2 = new Position();
    e.attach(pos1);
    e.attach(pos2);
    expect(e.get(Position)).toBe(pos2);
    expect(e.get(Position)).not.toBe(pos1);
  });

  it("attach triggers onAdd and onSet hooks", () => {
    const w = new World();
    w.component(Position);
    const onAdd = vi.fn();
    const onSet = vi.fn();
    w.component(Position).onAdd(onAdd).onSet(onSet);
    const e = w.entity();
    const pos = new Position();
    e.attach(pos);
    expect(onAdd).toHaveBeenCalledWith(e, pos);
    expect(onSet).toHaveBeenCalledWith(e, pos);
  });

  it("attach triggers onSet but not onAdd when replacing", () => {
    const w = new World();
    w.component(Position);
    const onAdd = vi.fn();
    const onSet = vi.fn();
    w.component(Position).onAdd(onAdd).onSet(onSet);
    const e = w.entity();
    const pos1 = new Position();
    const pos2 = new Position();
    e.attach(pos1);
    onAdd.mockClear();
    onSet.mockClear();
    e.attach(pos2);
    expect(onAdd).not.toHaveBeenCalled();
    expect(onSet).toHaveBeenCalledWith(e, pos2);
  });

  it("attach handles exclusive components", () => {
    const w = new World();
    w.component(Position);
    w.component(Velocity);
    w.setExclusiveComponents(Position, Velocity);
    const e = w.entity();
    const pos = new Position();
    const vel = new Velocity();
    e.attach(pos);
    e.attach(vel);
    expect(e.get(Position)).toBeUndefined();
    expect(e.get(Velocity)).toBe(vel);
  });

  it("attach works in deferred mode", () => {
    const w = new World();
    w.component(Position);
    w.start();
    const e = w.entity();
    const pos = new Position();
    w.beginDefer();
    e.attach(pos);
    expect(e.get(Position)).toBeUndefined();
    w.endDefer();
    expect(e.get(Position)).toBe(pos);
  });

  it("set marks a new component as modified", () => {
    const env = makeWorldWithFlushPhase();
    env.w.component(Position);
    env.start();
    const onSet = vi.fn();
    env.w.component(Position).onSet(onSet);
    const e = env.w.entity();
    e.set(Position, { x: 1 });
    env.tick();
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("set marks an already-present component as modified", () => {
    const env = makeWorldWithFlushPhase();
    env.w.component(Position);
    env.start();
    const onSet = vi.fn();
    env.w.component(Position).onSet(onSet);
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
    w.component(Position);
    const e = w.entity();
    expect(e.get(Position)).toBeUndefined();
    expect(e.add(Position).get(Position)).toBeInstanceOf(Position);
  });

  it("getMut invokes the callback with the component or returns undefined", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    const callback = vi.fn();
    expect(e.getMut(Position, callback)).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();

    let observed: Position | undefined;
    const pos = e.add(Position).getMut(Position, (value) => {
      observed = value;
      value.x = 3;
    });
    expect(pos).toBeInstanceOf(Position);
    expect(observed).toBe(pos);
    expect(pos?.x).toBe(3);
  });

  it("getMut with a callback marks an existing component as modified after the callback", () => {
    const w = new World();
    w.component(Position);
    const onSet = vi.fn();
    w.component(Position).onSet(onSet);
    const e = w.entity();
    const pos = e.add(Position).getMut(Position, (value) => {
      value.x = 3;
      expect(onSet).not.toHaveBeenCalled();
    })!;
    expect(pos).toBe(e.get(Position));
    expect(pos.x).toBe(3);
    expect(onSet).toHaveBeenCalledWith(e, pos);
  });

  it("getMut with a callback does not mark a missing component as modified", () => {
    const w = new World();
    w.component(Position);
    const onSet = vi.fn();
    w.component(Position).onSet(onSet);
    const e = w.entity();
    const callback = vi.fn();
    expect(e.getMut(Position, callback)).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    expect(onSet).not.toHaveBeenCalled();
  });

  it("getMut without a callback throws outside deferred mode", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    e.add(Position);
    expect(() => e.getMut(Position)).toThrow("deferred mode");
  });

  it("getMut(typeId) works with numeric type ids", () => {
    const w = new World();
    w.component(Position, 8);
    const e = w.entity();
    const pos = e.add(8).getMut(8, (value) => Object.assign(value, { x: 4 }));
    expect(pos).toBeInstanceOf(Position);
    expect((pos as Position | undefined)?.x).toBe(4);
  });

  it("remove detaches a component", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    e.add(Position);
    e.remove(Position);
    expect(e.get(Position)).toBeUndefined();
  });

  it("componentBitmask reflects added/removed components", () => {
    const w = new World();
    w.component(Position);
    w.component(Velocity);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    expect(e.componentBitmask.has(w.entity(Position).eid)).toBe(true);
    expect(e.componentBitmask.has(w.entity(Velocity).eid)).toBe(true);
    e.remove(Position);
    expect(e.componentBitmask.has(w.entity(Position).eid)).toBe(false);
  });

  it("empty reflects whether any components remain", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    expect(e.empty).toBe(true);
    e.add(Position);
    expect(e.empty).toBe(false);
    e.remove(Position);
    expect(e.empty).toBe(true);
  });

  it("components visits every attached component", () => {
    const w = new World();
    w.component(Position);
    w.component(Velocity);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    const seen: string[] = [];
    e.components.forEach((c) => seen.push(c.constructor.name));
    expect(seen.sort()).toEqual(["Position", "Velocity"]);
  });

  it("toString returns Entity{eid}", () => {
    const w = new World();
    const e = w.entity();
    expect(e.toString()).toBe(`Entity${e.eid}`);
  });
});

describe("Entity — lifecycle and relationships", () => {
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
    expect(() => env.w.entity(e.eid)).toThrow();
  });

  it("destroy cascades through ChildOf relationships", () => {
    const env = makeWorldWithFlushPhase();
    env.start();
    const parent = env.w.entity();
    const child = env.w.entity();
    const grandchild = env.w.entity();
    child.set(ChildOf, { target: parent });
    grandchild.set(ChildOf, { target: child });

    const childDestroyed = vi.fn();
    child.events.on("destroy", childDestroyed);
    parent.destroy();
    env.tick();
    expect(childDestroyed).toHaveBeenCalled();
    expect(() => env.w.entity(grandchild.eid)).toThrow();
    expect(() => env.w.entity(child.eid)).toThrow();
    expect(() => env.w.entity(parent.eid)).toThrow();
  });

  it("default relationship cleanup removes the component when the target is destroyed", () => {
    const env = makeWorldWithFlushPhase();
    env.w.component(FriendOf);
    env.start();
    const target = env.w.entity();
    const source = env.w.entity().set(FriendOf, { target });

    target.destroy();
    env.tick();

    expect(source._destroyed).toBe(false);
    expect(source.get(FriendOf)).toBeUndefined();
    expect(() => env.w.entity(target.eid)).toThrow();
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

  it("children(ref) returns an empty ReadonlySet before any child is added", () => {
    const w = new World();
    const e = w.entity();
    expect(e.children(ChildOf).size).toBe(0);
  });

  it("properties is a free-form map", () => {
    const w = new World();
    const e = w.entity();
    e.properties.set("kind", "bullet");
    expect(e.properties.get("kind")).toBe("bullet");
  });
});

describe("Entity — component entity onDelete", () => {
  it("removes the component from carriers when onDelete is Remove", () => {
    const w = new World();
    const componentEntity = w.component(Position);
    componentEntity.ownMeta.onDelete = CleanupPolicy.Remove;
    const a = w.entity().add(Position);
    const b = w.entity().add(Position);

    componentEntity.destroy();

    expect(a._destroyed).toBe(false);
    expect(b._destroyed).toBe(false);
    expect(a._get(componentEntity.eid)).toBeUndefined();
    expect(b._get(componentEntity.eid)).toBeUndefined();
    expect(componentEntity.instanceCount()).toBe(0);
    expect(componentEntity._destroyed).toBe(true);
  });

  it("destroys carriers when onDelete is Delete", () => {
    const w = new World();
    const componentEntity = w.component(Position);
    componentEntity.ownMeta.onDelete = CleanupPolicy.Delete;
    const a = w.entity().add(Position);
    const b = w.entity().add(Position);

    componentEntity.destroy();

    expect(() => w.entity(a.eid)).toThrow();
    expect(() => w.entity(b.eid)).toThrow();
    expect(() => w.entity(componentEntity.eid)).toThrow();
    expect(componentEntity._destroyed).toBe(true);
  });

  it("throws by default and leaves the component entity and carriers untouched", () => {
    const w = new World();
    const componentEntity = w.component(Position);
    const carrier = w.entity().add(Position);
    const component = carrier.get(Position);

    expect(() => componentEntity.destroy()).toThrow(/component eid is still in use/);

    expect(componentEntity._destroyed).toBe(false);
    expect(w.entity(componentEntity.eid)).toBe(componentEntity);
    expect(carrier._destroyed).toBe(false);
    expect(carrier.get(Position)).toBe(component);
    expect(componentEntity.instanceCount()).toBe(1);
  });

  it("allows a default component key to destroy itself when it has no other carriers", () => {
    const w = new World();
    const key = w.entity();
    key.add(key);

    expect(() => key.destroy()).not.toThrow();
    expect(key._destroyed).toBe(true);
    expect(key.instanceCount()).toBe(0);
  });
});

describe("Entity — relationship navigation", () => {
  it("ChildOf links parent and child bidirectionally", () => {
    const w = new World();
    const parent = w.entity();
    const child = w.entity();
    child.set(ChildOf, { target: parent });
    expect(child.parent(ChildOf)).toBe(parent);
    expect(parent.children(ChildOf).has(child)).toBe(true);
  });

  it("remove(ChildOf) unlinks from parent", () => {
    const w = new World();
    const parent = w.entity();
    const child = w.entity();
    child.set(ChildOf, { target: parent });
    child.remove(ChildOf);
    expect(child.parent(ChildOf)).toBeUndefined();
    expect(parent.children(ChildOf).has(child)).toBe(false);
  });

  it("set(ChildOf) moves child from old parent to new parent", () => {
    const w = new World();
    const p1 = w.entity();
    const p2 = w.entity();
    const child = w.entity();
    child.set(ChildOf, { target: p1 });
    child.set(ChildOf, { target: p2 });
    expect(child.parent(ChildOf)).toBe(p2);
    expect(p1.children(ChildOf).has(child)).toBe(false);
    expect(p2.children(ChildOf).has(child)).toBe(true);
  });

  it("getMut rejects relationship retargets and leaves incoming sets consistent", () => {
    const w = new World();
    const p1 = w.entity();
    const p2 = w.entity();
    const child = w.entity().set(ChildOf, { target: p1 });
    const mutate = vi.fn((rel: ChildOf) => {
      rel.target = p2;
    });

    expect(() => child.getMut(ChildOf, mutate)).toThrow(/Relationship/);

    expect(mutate).not.toHaveBeenCalled();
    expect(child.parent(ChildOf)).toBe(p1);
    expect(p1.children(ChildOf).has(child)).toBe(true);
    expect(p2.children(ChildOf).has(child)).toBe(false);
  });

  it("source destroy cleans the target's incoming set", () => {
    const w = new World();
    const parent = w.entity();
    const child = w.entity().set(ChildOf, { target: parent });
    child.destroy();
    expect(parent.children(ChildOf).has(child)).toBe(false);
  });

  it("set(ChildOf) in deferred mode is not visible until queue drains", () => {
    const env = makeWorldWithFlushPhase();
    env.start();
    const parent = env.w.entity();
    const child = env.w.entity();
    env.w.beginDefer();
    child.set(ChildOf, { target: parent });
    expect(child.parent(ChildOf)).toBeUndefined();
    expect(parent.children(ChildOf).has(child)).toBe(false);
    env.w.endDefer();
    expect(child.parent(ChildOf)).toBe(parent);
    expect(parent.children(ChildOf).has(child)).toBe(true);
  });
});
