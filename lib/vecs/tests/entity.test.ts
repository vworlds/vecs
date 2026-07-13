import { describe, it, expect, vi } from "vitest";
import { ChildOf, CleanupPolicy, Relationship, type Entity, World } from "../src/index.js";

class Position {
  x = 0;
  y = 0;
}
class Velocity {
  vx = 0;
}
class FriendOf extends Relationship {}
class InRoom extends Relationship {}
class Guards extends Relationship {}

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

  it("get(typeId) for an unattached numeric id returns undefined, like has", () => {
    const w = new World();
    w.component(Position, 50);
    const e = w.entity();
    // 51 is not a registered component entity; get must not throw and must
    // agree with has (both report "not attached").
    expect(e.get(51)).toBeUndefined();
    expect(e.has(51)).toBe(false);
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
    const ceid = w.peekNextEid("component");
    w.component(Position, ceid);
    const e = w.entity();
    const pos = e.set(ceid, {}).get(ceid);
    expect(pos).toBeInstanceOf(Position);
  });

  it("set/get/getMut/ensure/remove work with entity component refs", () => {
    const w = new World();
    const key = w.entity();
    const e = w.entity();

    e.set(key, { enabled: true });

    expect(e.get(key)).toMatchObject({ enabled: true });
    const component = e.getMut(key, (value) => Object.assign(value, { enabled: false }));
    expect(component).toMatchObject({ enabled: false });
    e.remove(key);
    const ensured = e.ensure(key, (value) => Object.assign(value, { enabled: true }));
    expect(ensured).toMatchObject({ enabled: true });
    expect(e.get(key)).toBe(ensured);
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
    const e = w.entity();
    const pos = new Position();
    w.beginDefer();
    e.attach(pos);
    expect(e.get(Position)).toBeUndefined();
    w.endDefer();
    expect(e.get(Position)).toBe(pos);
  });

  it("set marks a new component as modified", () => {
    const w = new World();
    w.component(Position);
    const onSet = vi.fn();
    w.component(Position).onSet(onSet);
    const e = w.entity();
    e.set(Position, { x: 1 });
    w.progress(0, 0);
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("set marks an already-present component as modified", () => {
    const w = new World();
    w.component(Position);
    const onSet = vi.fn();
    w.component(Position).onSet(onSet);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0); // flush the initial add notification
    onSet.mockClear();
    e.set(Position, { x: 42 });
    w.progress(0, 0);
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
    w.component(Position, 808);
    const e = w.entity();
    const pos = e.add(808).getMut(808, (value) => Object.assign(value, { x: 4 }));
    expect(pos).toBeInstanceOf(Position);
    expect((pos as Position | undefined)?.x).toBe(4);
  });

  it("ensure creates a missing component and invokes the callback", () => {
    const w = new World();
    w.component(Position);
    const onAdd = vi.fn();
    const onSet = vi.fn();
    w.component(Position).onAdd(onAdd).onSet(onSet);
    const e = w.entity();

    const pos = e.ensure(Position, (value) => {
      value.x = 3;
    });

    expect(pos).toBeInstanceOf(Position);
    expect(e.get(Position)).toBe(pos);
    expect(pos?.x).toBe(3);
    expect(onAdd).toHaveBeenCalledWith(e, pos);
    expect(onSet).toHaveBeenCalledWith(e, pos);
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("ensure with a callback marks an existing component as modified after the callback", () => {
    const w = new World();
    w.component(Position);
    const onSet = vi.fn();
    w.component(Position).onSet(onSet);
    const e = w.entity();
    const pos = e.add(Position).ensure(Position, (value) => {
      value.x = 3;
      expect(onSet).not.toHaveBeenCalled();
    })!;
    expect(pos).toBe(e.get(Position));
    expect(pos.x).toBe(3);
    expect(onSet).toHaveBeenCalledWith(e, pos);
  });

  it("ensure without a callback throws outside deferred mode", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    expect(() => e.ensure(Position)).toThrow("deferred mode");
  });

  it("ensure throws immediately on a destroyed entity", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    const callback = vi.fn();

    e.destroy();

    expect(() => e.ensure(Position)).toThrow("destroyed entity");
    expect(() => e.ensure(Position, callback)).toThrow("destroyed entity");
    expect(callback).not.toHaveBeenCalled();
  });

  it("ensure(typeId) works with numeric type ids", () => {
    const w = new World();
    w.component(Position, 808);
    const e = w.entity();
    const pos = e.ensure(808, (value) => Object.assign(value, { x: 4 }));
    expect(pos).toBeInstanceOf(Position);
    expect((pos as Position | undefined)?.x).toBe(4);
    expect(e.get(808)).toBe(pos);
  });

  it("remove detaches a component", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    e.add(Position);
    e.remove(Position);
    expect(e.get(Position)).toBeUndefined();
  });

  it("has reflects added/removed components", () => {
    const w = new World();
    w.component(Position);
    w.component(Velocity, 200);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    expect(e.has(Position)).toBe(true);
    expect(e.has(200)).toBe(true);
    expect(e.has(w.entity(Velocity))).toBe(true);
    e.remove(Position);
    expect(e.has(Position)).toBe(false);
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
  it("destroy removes the entity from the world map", () => {
    const w = new World();
    const e = w.entity();
    e.destroy();
    expect(() => w.entity(e.eid)).toThrow();
  });

  it("destroy clears component storage so read APIs agree", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    e.set(Position, { x: 5, y: 0 });
    e.destroy();
    expect(e.get(Position)).toBeUndefined();
    expect(e.components.size).toBe(0);
    expect(e.empty).toBe(true);
    expect(e.has(Position)).toBe(false);
  });

  it("deferred destroy clears component storage after the queue drains", () => {
    const w = new World();
    w.component(Position);
    const e = w.entity();
    e.set(Position, { x: 5, y: 0 });
    w.defer(() => {
      e.destroy();
    });
    expect(e.get(Position)).toBeUndefined();
    expect(e.components.size).toBe(0);
    expect(e.empty).toBe(true);
    expect(e.has(Position)).toBe(false);
  });

  it("onRemove hook can read a sibling component while the entity is being destroyed", () => {
    const w = new World();
    w.component(Position);
    w.component(Velocity);
    let observed: Velocity | undefined;
    w.component(Position).onRemove((entity) => {
      observed = entity.get(Velocity);
    });
    const e = w.entity();
    e.set(Position, { x: 5, y: 0 });
    const vel = e.set(Velocity, { vx: 1 }).get(Velocity);
    e.destroy();
    expect(observed).toBe(vel);
  });

  it("destroy cascades through ChildOf relationships", () => {
    const w = new World();
    const parent = w.entity();
    const child = w.entity();
    const grandchild = w.entity();
    child.childOf(parent);
    grandchild.childOf(child);

    parent.destroy();
    w.progress(0, 0);
    expect(parent.destroyed).toBe(true);
    expect(child.destroyed).toBe(true);
    expect(grandchild.destroyed).toBe(true);
    expect(() => w.entity(grandchild.eid)).toThrow();
    expect(() => w.entity(child.eid)).toThrow();
    expect(() => w.entity(parent.eid)).toThrow();
  });

  it("default relationship cleanup removes the component when the target is destroyed", () => {
    const w = new World();
    w.component(FriendOf);
    const target = w.entity();
    const source = w.entity().set(FriendOf, { target });

    target.destroy();
    w.progress(0, 0);

    expect(source.destroyed).toBe(false);
    expect(source.get(FriendOf)).toBeUndefined();
    expect(() => w.entity(target.eid)).toThrow();
  });

  // Regression for issue #155: _cleanupIncoming's outer forEach over distinct
  // relationship types was perturbed by re-entrant _removeIncoming deletes,
  // causing it to skip types after the first. The fix buffers cleanup ops onto
  // a world-level deletion scope and drains them after the scan completes.
  it("destroy cleans up every incoming relationship type when multiple types target the same entity (Delete, shape-before-joint order)", () => {
    const w = new World();
    w.component(InRoom).meta.onDeleteTarget = CleanupPolicy.Delete;
    w.component(Guards).meta.onDeleteTarget = CleanupPolicy.Delete;
    const room = w.entity();
    const lamp = w.entity().set(InRoom, { target: room });
    const guard = w.entity().set(Guards, { target: room });

    room.destroy();
    w.progress(0, 0);

    expect(room.destroyed).toBe(true);
    expect(lamp.destroyed).toBe(true);
    expect(guard.destroyed).toBe(true);
    expect(() => w.entity(room.eid)).toThrow();
    expect(() => w.entity(lamp.eid)).toThrow();
    expect(() => w.entity(guard.eid)).toThrow();
  });

  it("destroy cleans up every incoming relationship type when multiple types target the same entity (Delete, joint-before-shape order)", () => {
    const w = new World();
    w.component(InRoom).meta.onDeleteTarget = CleanupPolicy.Delete;
    w.component(Guards).meta.onDeleteTarget = CleanupPolicy.Delete;
    const room = w.entity();
    const guard = w.entity().set(Guards, { target: room });
    const lamp = w.entity().set(InRoom, { target: room });

    room.destroy();
    w.progress(0, 0);

    expect(room.destroyed).toBe(true);
    expect(lamp.destroyed).toBe(true);
    expect(guard.destroyed).toBe(true);
    expect(() => w.entity(room.eid)).toThrow();
    expect(() => w.entity(lamp.eid)).toThrow();
    expect(() => w.entity(guard.eid)).toThrow();
  });

  it("destroy cleans up mixed Delete + Remove policies across two incoming relationship types", () => {
    const w = new World();
    w.component(InRoom).meta.onDeleteTarget = CleanupPolicy.Delete;
    w.component(FriendOf); // default Remove
    const target = w.entity();
    const lamp = w.entity().set(InRoom, { target });
    const friend = w.entity().set(FriendOf, { target });

    target.destroy();
    w.progress(0, 0);

    expect(target.destroyed).toBe(true);
    expect(lamp.destroyed).toBe(true);
    expect(friend.destroyed).toBe(false);
    expect(friend.get(FriendOf)).toBeUndefined();
    expect(() => w.entity(target.eid)).toThrow();
    expect(() => w.entity(lamp.eid)).toThrow();
    expect(w.entity(friend.eid)).toBe(friend);
  });

  it("destroy cleans up two default-policy (Remove) incoming relationship types", () => {
    const w = new World();
    w.component(InRoom); // default Remove
    w.component(FriendOf); // default Remove
    const target = w.entity();
    const lamp = w.entity().set(InRoom, { target });
    const friend = w.entity().set(FriendOf, { target });

    target.destroy();
    w.progress(0, 0);

    expect(target.destroyed).toBe(true);
    expect(lamp.destroyed).toBe(false);
    expect(friend.destroyed).toBe(false);
    expect(lamp.get(InRoom)).toBeUndefined();
    expect(friend.get(FriendOf)).toBeUndefined();
    expect(() => w.entity(target.eid)).toThrow();
    expect(w.entity(lamp.eid)).toBe(lamp);
    expect(w.entity(friend.eid)).toBe(friend);
  });

  it("destroy cleanup still runs after a prior destroy with no incoming relationships", () => {
    const w = new World();
    w.component(InRoom).meta.onDeleteTarget = CleanupPolicy.Delete;
    w.component(Guards).meta.onDeleteTarget = CleanupPolicy.Delete;
    const unrelated = w.entity();
    unrelated.destroy();

    const target = w.entity();
    const lamp = w.entity().set(InRoom, { target });
    const guard = w.entity().set(Guards, { target });

    target.destroy();
    w.progress(0, 0);

    expect(unrelated.destroyed).toBe(true);
    expect(target.destroyed).toBe(true);
    expect(lamp.destroyed).toBe(true);
    expect(guard.destroyed).toBe(true);
    expect(() => w.entity(unrelated.eid)).toThrow();
    expect(() => w.entity(target.eid)).toThrow();
    expect(() => w.entity(lamp.eid)).toThrow();
    expect(() => w.entity(guard.eid)).toThrow();
  });

  it("destroy is re-entrant safe", () => {
    const w = new World();
    w.component(Position);
    const cb = vi.fn((entity: Entity) => entity.destroy());
    w.component(Position).onRemove(cb);
    const e = w.entity();
    e.add(Position);
    e.destroy();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(e.destroyed).toBe(true);
    expect(() => w.entity(e.eid)).toThrow();
  });

  it("children(ref) returns an empty ReadonlySet before any child is added", () => {
    const w = new World();
    const e = w.entity();
    expect(e.children(ChildOf).size).toBe(0);
  });
});

describe("Entity — component entity onDelete", () => {
  it("removes the component from carriers when onDelete is Remove", () => {
    const w = new World();
    const componentEntity = w.component(Position);
    componentEntity.meta.onDelete = CleanupPolicy.Remove;
    const a = w.entity().add(Position);
    const b = w.entity().add(Position);

    componentEntity.destroy();

    expect(a.destroyed).toBe(false);
    expect(b.destroyed).toBe(false);
    expect(a._get(componentEntity.eid)).toBeUndefined();
    expect(b._get(componentEntity.eid)).toBeUndefined();
    expect(componentEntity.instanceCount()).toBe(0);
    expect(componentEntity.destroyed).toBe(true);
  });

  it("destroys carriers when onDelete is Delete", () => {
    const w = new World();
    const componentEntity = w.component(Position);
    componentEntity.meta.onDelete = CleanupPolicy.Delete;
    const a = w.entity().add(Position);
    const b = w.entity().add(Position);

    componentEntity.destroy();

    expect(() => w.entity(a.eid)).toThrow();
    expect(() => w.entity(b.eid)).toThrow();
    expect(() => w.entity(componentEntity.eid)).toThrow();
    expect(componentEntity.destroyed).toBe(true);
  });

  it("throws by default and leaves the component entity and carriers untouched", () => {
    const w = new World();
    const componentEntity = w.component(Position);
    const carrier = w.entity().add(Position);
    const component = carrier.get(Position);

    expect(() => componentEntity.destroy()).toThrow(/component eid is still in use/);

    expect(componentEntity.destroyed).toBe(false);
    expect(w.entity(componentEntity.eid)).toBe(componentEntity);
    expect(carrier.destroyed).toBe(false);
    expect(carrier.get(Position)).toBe(component);
    expect(componentEntity.instanceCount()).toBe(1);
  });

  it("allows a default component key to destroy itself when it has no other carriers", () => {
    const w = new World();
    const key = w.entity();
    key.add(key);

    expect(() => key.destroy()).not.toThrow();
    expect(key.destroyed).toBe(true);
    expect(key.instanceCount()).toBe(0);
  });
});

describe("Entity — relationship navigation", () => {
  it("ChildOf links parent and child bidirectionally", () => {
    const w = new World();
    const parent = w.entity();
    const child = w.entity();
    expect(child.childOf(parent)).toBe(child);
    expect(child.target(ChildOf)).toBe(parent);
    expect(parent.children(ChildOf).has(child)).toBe(true);
  });

  it("remove(ChildOf) unlinks from parent", () => {
    const w = new World();
    const parent = w.entity();
    const child = w.entity();
    child.childOf(parent);
    child.remove(ChildOf);
    expect(child.target(ChildOf)).toBeUndefined();
    expect(parent.children(ChildOf).has(child)).toBe(false);
  });

  it("childOf moves child from old parent to new parent", () => {
    const w = new World();
    const p1 = w.entity();
    const p2 = w.entity();
    const child = w.entity();
    child.childOf(p1);
    child.childOf(p2);
    expect(child.target(ChildOf)).toBe(p2);
    expect(p1.children(ChildOf).has(child)).toBe(false);
    expect(p2.children(ChildOf).has(child)).toBe(true);
  });

  it("getMut rejects relationship retargets and leaves incoming sets consistent", () => {
    const w = new World();
    const p1 = w.entity();
    const p2 = w.entity();
    const child = w.entity().childOf(p1);
    const mutate = vi.fn((rel: ChildOf) => {
      rel.target = p2;
    });

    expect(() => child.getMut(ChildOf, mutate)).toThrow(/Relationship/);

    expect(mutate).not.toHaveBeenCalled();
    expect(child.target(ChildOf)).toBe(p1);
    expect(p1.children(ChildOf).has(child)).toBe(true);
    expect(p2.children(ChildOf).has(child)).toBe(false);
  });

  it("ensure rejects relationship retargets and leaves incoming sets consistent", () => {
    const w = new World();
    const p1 = w.entity();
    const p2 = w.entity();
    const child = w.entity().childOf(p1);
    const mutate = vi.fn((rel: ChildOf) => {
      rel.target = p2;
    });

    expect(() => child.ensure(ChildOf, mutate)).toThrow(/Relationship/);

    expect(mutate).not.toHaveBeenCalled();
    expect(child.target(ChildOf)).toBe(p1);
    expect(p1.children(ChildOf).has(child)).toBe(true);
    expect(p2.children(ChildOf).has(child)).toBe(false);
  });

  it("source destroy cleans the target's incoming set", () => {
    const w = new World();
    const parent = w.entity();
    const child = w.entity().childOf(parent);
    child.destroy();
    expect(parent.children(ChildOf).has(child)).toBe(false);
  });

  it("childOf in deferred mode is not visible until queue drains", () => {
    const w = new World();
    const parent = w.entity();
    const child = w.entity();
    w.beginDefer();
    child.childOf(parent);
    expect(child.target(ChildOf)).toBeUndefined();
    expect(parent.children(ChildOf).has(child)).toBe(false);
    w.endDefer();
    expect(child.target(ChildOf)).toBe(parent);
    expect(parent.children(ChildOf).has(child)).toBe(true);
  });

  it("ensureTarget creates and reuses an independent relationship target", () => {
    const w = new World();
    w.component(FriendOf);
    const source = w.entity();

    const target = source.ensureTarget(FriendOf);

    expect(source.ensureTarget(FriendOf)).toBe(target);
    expect(source.target(FriendOf)).toBe(target);
    expect(target.parent).toBeUndefined();

    source.destroy();
    expect(target.alive).toBe(true);
    expect(w.entity(target.eid)).toBe(target);
  });

  it("ensureTarget returns one pending target across repeated deferred calls", () => {
    const w = new World();
    const relationship = w.component(FriendOf);
    const onAdd = vi.fn();
    const onSet = vi.fn();
    relationship.onAdd(onAdd).onSet(onSet);
    const source = w.entity();
    let first: Entity | undefined;
    let second: Entity | undefined;

    w.defer(() => {
      first = source.ensureTarget(FriendOf);
      second = source.ensureTarget(FriendOf);

      expect(second).toBe(first);
      expect(source.target(FriendOf)).toBeUndefined();
    });

    expect(source.target(FriendOf)).toBe(first);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("ensureTarget recreates a target after the previous target is destroyed", () => {
    const w = new World();
    w.component(FriendOf);
    const source = w.entity();
    const first = source.ensureTarget(FriendOf);

    first.destroy();
    const second = source.ensureTarget(FriendOf);

    expect(second).not.toBe(first);
    expect(source.target(FriendOf)).toBe(second);
  });

  it("ensureTarget requires a registered relationship component", () => {
    const w = new World();
    w.component(Position);
    const source = w.entity();

    expect(() => source.ensureTarget(FriendOf)).toThrow(/unregistered component entity/);
    expect(() => source.ensureTarget(Position as unknown as typeof FriendOf)).toThrow(
      /requires a Relationship/
    );
  });
});
