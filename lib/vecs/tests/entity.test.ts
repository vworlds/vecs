import { describe, it, expect, vi } from "vitest";
import {
  ChildOf,
  CleanupPolicy,
  Exclusive,
  Relationship,
  type Entity,
  World,
} from "../src/index.js";

class Position {
  x = 0;
  y = 0;
}
class Velocity {
  vx = 0;
}
class FriendOf extends Relationship {
  label = "";
}
class InRoom extends Relationship {}
class Guards extends Relationship {}
class SecondTarget {}
class ThirdTarget {}

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
    w.component(Position).on("add", onAdd).on("set", onSet);
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
    w.component(Position).on("add", onAdd).on("set", onSet);
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
    w.component(Position).on("set", onSet);
    const e = w.entity();
    e.set(Position, { x: 1 });
    w.progress(0, 0);
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("set marks an already-present component as modified", () => {
    const w = new World();
    w.component(Position);
    const onSet = vi.fn();
    w.component(Position).on("set", onSet);
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
    w.component(Position).on("set", onSet);
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
    w.component(Position).on("set", onSet);
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
    w.component(Position).on("add", onAdd).on("set", onSet);
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
    w.component(Position).on("set", onSet);
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
    w.component(Position).on("remove", (entity) => {
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

  it("destroy cascades through a deep ChildOf chain", () => {
    // The cascade recurses per level (each buffered destroy owns and drains
    // its own deletion scope), so usable depth is bounded by the call stack:
    // the chain overflows at roughly 4000 levels on Node's default stack, and
    // the exact threshold varies between runs. 2000 stays reliably below the
    // limit while still failing if a change roughly doubles the per-level
    // stack cost; shallower depths only repeat the 3-level cascade test above.
    const w = new World();
    const chain = [w.entity()];
    for (let i = 1; i < 2000; i++) {
      chain.push(w.entity().childOf(chain[i - 1]));
    }

    chain[0].destroy();

    expect(chain.every((e) => e.destroyed)).toBe(true);
  });

  it("default relationship cleanup removes the component when the target is destroyed", () => {
    const w = new World();
    w.component(FriendOf);
    const target = w.entity();
    const source = w.entity().add(FriendOf, target);

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
    const lamp = w.entity().add(InRoom, room);
    const guard = w.entity().add(Guards, room);

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
    const guard = w.entity().add(Guards, room);
    const lamp = w.entity().add(InRoom, room);

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
    const lamp = w.entity().add(InRoom, target);
    const friend = w.entity().add(FriendOf, target);

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
    const lamp = w.entity().add(InRoom, target);
    const friend = w.entity().add(FriendOf, target);

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
    const lamp = w.entity().add(InRoom, target);
    const guard = w.entity().add(Guards, target);

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
    w.component(Position).on("remove", cb);
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

  it("deferred Throw-policy destroy throws on drain and leaves the world partial", () => {
    const w = new World();
    const componentEntity = w.component(Position);
    const carrier = w.entity().add(Position);

    // Start with a non-Throw policy so the eager `destroy()` check passes and
    // the command is enqueued; flip to Throw before the drain so `_destroy`
    // hits the deferred throw path (the race this guard exists for).
    componentEntity.meta.onDelete = CleanupPolicy.Remove;
    w.beginDefer();
    componentEntity.destroy();
    componentEntity.meta.onDelete = CleanupPolicy.Throw;
    expect(() => w.endDefer()).toThrow(/component eid is still in use/);
    // Throw landed before _destroyed was set; entity is registered but world is dead.
    expect(componentEntity.destroyed).toBe(false);
    expect(carrier.get(Position)).toBeDefined();
  });

  it("Delete cascade into a Throw-policy component throws and leaves the world partial", () => {
    const w = new World();
    w.component(InRoom).meta.onDeleteTarget = CleanupPolicy.Delete;
    w.component(Position);
    const room = w.entity();
    const lamp = w.entity();
    lamp.meta.onDelete = CleanupPolicy.Throw;
    w.entity().add(lamp); // carrier so usageCount > 0
    lamp.add(InRoom, room);

    expect(() => room.destroy()).toThrow(/component eid is still in use/);
    expect(room.destroyed).toBe(true);
    expect(lamp.destroyed).toBe(false);
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
    const mutate = vi.fn((_rel: ChildOf) => void p2);

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
    const mutate = vi.fn((_rel: ChildOf) => void p2);

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

  it("stores multiple idempotent targets without exposing its backing array", () => {
    const w = new World();
    w.component(FriendOf);
    const source = w.entity();
    const first = w.entity();
    const second = w.entity();

    source.add(FriendOf, first).add(FriendOf, second).add(FriendOf, first);
    const targets = source.targets(FriendOf);

    expect(source.target(FriendOf)).toBe(first);
    expect(targets).toEqual([first, second]);
    expect(source.hasTarget(FriendOf, second)).toBe(true);
    (targets as Entity[]).pop();
    expect(source.targets(FriendOf)).toEqual([first, second]);
    expect(first.children(FriendOf)).toContain(source);
    expect(second.children(FriendOf)).toContain(source);
  });

  it("removes one edge or the whole relationship idempotently", () => {
    const w = new World();
    w.component(FriendOf);
    const source = w.entity();
    const first = w.entity();
    const second = w.entity();
    source.add(FriendOf, first).add(FriendOf, second);

    source.remove(FriendOf, first);
    source.remove(FriendOf, first);
    expect(source.targets(FriendOf)).toEqual([second]);
    expect(first.children(FriendOf)).not.toContain(source);

    source.remove(FriendOf);
    expect(source.has(FriendOf)).toBe(false);
    expect(second.children(FriendOf)).not.toContain(source);
  });

  it("validates relationship targets and rejects relationship attachment", () => {
    const w = new World();
    w.component(FriendOf);
    w.component(Position);
    const source = w.entity();
    const target = w.entity();

    expect(() => source.add(FriendOf)).toThrow(/requires a target/);
    expect(() => source.add(Position, target)).toThrow(/requires a Relationship/);
    expect(() => source.remove(Position, target)).toThrow(/requires a Relationship/);
    expect(() => source.attach(new FriendOf())).toThrow(/cannot attach Relationship/);
  });

  it("set updates relationship data only when the relationship exists", () => {
    const w = new World();
    const relationship = w.component(FriendOf);
    const onSet = vi.fn();
    relationship.on("set", onSet);
    const source = w.entity();
    const first = w.entity();
    const second = w.entity();

    source.set(FriendOf, { label: "absent" });
    expect(source.has(FriendOf)).toBe(false);

    source.add(FriendOf, first);
    source.set(FriendOf, { label: "present", target: second } as any);
    expect(source.get(FriendOf)?.label).toBe("present");
    expect(source.targets(FriendOf)).toEqual([first]);
    expect(onSet).toHaveBeenCalledOnce();

    source.set(FriendOf, { target: second } as any);
    expect(source.targets(FriendOf)).toEqual([first]);
    expect(onSet).toHaveBeenCalledOnce();
  });

  it("fires edge hooks with finalized indexes and detaches before final removal hooks", () => {
    const w = new World();
    const relationship = w.component(FriendOf);
    const events: string[] = [];
    const source = w.entity();
    const target = w.entity();
    relationship
      .on("targetAdd", (entity, instance, added) => {
        expect(entity.hasTarget(FriendOf, added)).toBe(true);
        expect(added.children(FriendOf)).toContain(entity);
        expect(instance).toBe(entity.get(FriendOf));
        events.push("target-add");
      })
      .on("add", () => events.push("add"))
      .on("targetRemove", (entity, instance, removed) => {
        expect(entity.has(FriendOf)).toBe(false);
        expect(instance._target()).toBeUndefined();
        expect(removed.children(FriendOf)).not.toContain(entity);
        events.push("target-remove");
      })
      .on("remove", () => events.push("remove"));

    source.add(FriendOf, target);
    source.remove(FriendOf, target);

    expect(events).toEqual(["target-add", "add", "target-remove", "remove"]);
  });

  it("does not publish phantom query membership when onTargetAdd removes the relationship", () => {
    const w = new World();
    const relationship = w.component(FriendOf);
    const query = w.query("reentrant relationship add").with(FriendOf).build();
    const onAdd = vi.fn();
    const onTargetAdd = vi.fn((source: Entity) => source.remove(FriendOf));
    relationship.on("targetAdd", onTargetAdd).on("add", onAdd);
    const source = w.entity();
    const target = w.entity();

    source.add(FriendOf, target);

    expect(onTargetAdd).toHaveBeenCalledOnce();
    expect(onAdd).not.toHaveBeenCalled();
    expect(source.has(FriendOf)).toBe(false);
    expect(target.children(FriendOf)).not.toContain(source);
    expect(query.has(source)).toBe(false);
  });

  it("suppresses stale exclusive hooks and query updates after a nested replacement", () => {
    const w = new World();
    const relationship = w.component(FriendOf).add(Exclusive);
    w.component(SecondTarget);
    w.component(ThirdTarget);
    const source = w.entity();
    const first = w.entity();
    const second = w.entity().add(SecondTarget);
    const third = w.entity().add(ThirdTarget);
    const secondQuery = w
      .query("second target")
      .with({ target: [FriendOf, SecondTarget] })
      .build();
    const thirdQuery = w
      .query("third target")
      .with({ target: [FriendOf, ThirdTarget] })
      .build();
    const updates = vi.fn();
    w.query("relationship updates").with(FriendOf).update(FriendOf, updates).build();
    const removed: Entity[] = [];
    const added: Entity[] = [];
    relationship
      .on("targetRemove", (entity, _instance, target) => {
        removed.push(target);
        if (target === first) {
          entity.add(FriendOf, third);
        }
      })
      .on("targetAdd", (entity, _instance, target) => {
        expect(entity.target(FriendOf)).toBe(target);
        expect(target.children(FriendOf)).toContain(entity);
        added.push(target);
      });
    source.add(FriendOf, first);
    removed.length = 0;
    added.length = 0;
    updates.mockClear();

    source.add(FriendOf, second);

    expect(source.target(FriendOf)).toBe(third);
    expect(removed).toEqual([first, second]);
    expect(added).toEqual([third]);
    expect(updates).toHaveBeenCalledOnce();
    expect(secondQuery.has(source)).toBe(false);
    expect(thirdQuery.has(source)).toBe(true);
  });

  it("exclusive relationships replace targets while preserving data", () => {
    const w = new World();
    const relationship = w.component(FriendOf).add(Exclusive);
    const removed = vi.fn();
    const added = vi.fn();
    relationship.on("targetRemove", removed).on("targetAdd", added);
    const source = w.entity();
    const first = w.entity();
    const second = w.entity();
    source.add(FriendOf, first).set(FriendOf, { label: "kept" });
    const instance = source.get(FriendOf);

    source.add(FriendOf, second);

    expect(source.get(FriendOf)).toBe(instance);
    expect(source.get(FriendOf)?.label).toBe("kept");
    expect(source.targets(FriendOf)).toEqual([second]);
    expect(removed).toHaveBeenCalledWith(source, instance, first);
    expect(added).toHaveBeenLastCalledWith(source, instance, second);
  });

  it("rejects changing Exclusive while relationship instances exist", () => {
    const w = new World();
    const relationship = w.component(FriendOf);
    const source = w.entity().add(FriendOf, w.entity());

    expect(() => relationship.add(Exclusive)).toThrow(/while the relationship is in use/);
    source.remove(FriendOf);
    relationship.add(Exclusive);
    source.add(FriendOf, w.entity());
    expect(() => relationship.remove(Exclusive)).toThrow(/while the relationship is in use/);
  });

  it("rejects cross-world relationship targets without creating reverse edges", () => {
    const sourceWorld = new World();
    const targetWorld = new World();
    const relationship = sourceWorld.component(FriendOf);
    targetWorld.component(FriendOf);
    const source = sourceWorld.entity();
    const foreignTarget = targetWorld.entity();

    expect(() => source.add(FriendOf, foreignTarget)).toThrow(/same World/);
    expect(() => source._addTarget(relationship.meta, foreignTarget)).toThrow(/same World/);
    expect(source.has(FriendOf)).toBe(false);
    expect(foreignTarget.children(FriendOf)).not.toContain(source);
  });
});
