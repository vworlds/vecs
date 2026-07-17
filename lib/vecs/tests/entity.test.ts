import { describe, it, expect, vi } from "vitest";
import {
  ChildOf,
  CleanupPolicy,
  Exclusive,
  Implements,
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
    const source = w.entity().add(FriendOf, target);

    target.destroy();
    w.progress(0, 0);

    expect(source.destroyed).toBe(false);
    expect(source.get(FriendOf)).toBeUndefined();
    expect(() => w.entity(target.eid)).toThrow();
  });

  // Regression for issue #155: cleanup must snapshot every indexed incoming
  // relationship type before commit mutates the reverse indexes.
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
    expect(w.getEntity(Position)).toBeUndefined();
    expect(componentEntity.destroyed).toBe(true);
  });

  it("throws when a default component key still has an external carrier", () => {
    const w = new World();
    const componentEntity = w.component(Position);
    w.entity().add(Position);

    expect(() => componentEntity.destroy()).toThrow(/component eid is still in use/);
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

describe("Entity — indexed destruction executor", () => {
  it.each([CleanupPolicy.Remove, CleanupPolicy.Delete])(
    "does not scan world entities for component-key %s cleanup",
    (policy) => {
      const world = new World();
      const component = world.component(Position);
      const componentEid = component.eid;
      component.meta.onDelete = policy;
      const first = world.entity().add(Position);
      const second = world.entity().add(Position);
      world.entity();
      world.entity();
      const scan = vi.spyOn(world.entities, "forEach");

      component.destroy();

      expect(scan).not.toHaveBeenCalled();
      expect(component.destroyed).toBe(true);
      if (policy === CleanupPolicy.Remove) {
        expect(first._get(componentEid)).toBeUndefined();
        expect(second._get(componentEid)).toBeUndefined();
      } else {
        expect(first.destroyed).toBe(true);
        expect(second.destroyed).toBe(true);
      }
    }
  );

  it("validates and applies each Remove immediately exactly once", () => {
    const world = new World();
    const component = world.component(Position);
    const componentEid = component.eid;
    component.meta.onDelete = CleanupPolicy.Remove;
    const first = world.entity().add(Position);
    const second = world.entity().add(Position);
    const validations: Entity[] = [];
    component.meta._validateRemove = (carrier) => {
      if (carrier === second) {
        expect(first.has(Position)).toBe(false);
      }
      validations.push(carrier);
    };

    component.destroy();

    expect(validations).toEqual([first, second]);
    expect(first._get(componentEid)).toBeUndefined();
    expect(second._get(componentEid)).toBeUndefined();
  });

  it("stops Remove cleanup at the first validation exception", () => {
    const world = new World();
    const component = world.component(Position);
    component.meta.onDelete = CleanupPolicy.Remove;
    const first = world.entity().add(Position);
    const second = world.entity().add(Position);
    world.entity().add(Position);
    const validations: Entity[] = [];
    component.meta._validateRemove = (carrier) => {
      validations.push(carrier);
      if (carrier === second) {
        throw new Error("invalid removal");
      }
    };

    expect(() => component.destroy()).toThrow("invalid removal");
    expect(validations).toEqual([first, second]);
  });

  it("deduplicates cyclic and overlapping Delete cascades without dangling references", () => {
    class CascadesTo extends Relationship {}
    const world = new World();
    const relationship = world.component(CascadesTo);
    relationship.meta.onDeleteTarget = CleanupPolicy.Delete;
    const removed = vi.fn();
    relationship.onRemove(removed);
    const first = world.entity();
    const second = world.entity();
    const overlap = world.entity();
    first.add(CascadesTo, second);
    second.add(CascadesTo, first);
    overlap.add(CascadesTo, first).add(CascadesTo, second);

    first.destroy();

    expect(first.destroyed).toBe(true);
    expect(second.destroyed).toBe(true);
    expect(overlap.destroyed).toBe(true);
    expect(removed).toHaveBeenCalledTimes(3);
    expect(relationship.instanceCount()).toBe(0);
    expect(first.children(CascadesTo).size).toBe(0);
    expect(second.children(CascadesTo).size).toBe(0);
  });

  it("destroys a deep Delete cascade without recursive stack overflow", () => {
    class CascadesTo extends Relationship {}
    const world = new World();
    const relationship = world.component(CascadesTo);
    relationship.meta.onDeleteTarget = CleanupPolicy.Delete;
    const root = world.entity();
    let leaf = root;
    for (let i = 0; i < 20_000; i++) {
      leaf = world.entity().add(CascadesTo, leaf);
    }

    root.destroy();

    expect(leaf.destroyed).toBe(true);
    expect(relationship.instanceCount()).toBe(0);
  });

  it("removes only the destroyed edge from a multi-target Remove relationship", () => {
    const world = new World();
    world.component(FriendOf);
    const destroyedTarget = world.entity();
    const survivingTarget = world.entity();
    const source = world.entity().add(FriendOf, destroyedTarget).add(FriendOf, survivingTarget);

    destroyedTarget.destroy();

    expect(source.destroyed).toBe(false);
    expect(source.targets(FriendOf)).toEqual([survivingTarget]);
    expect(source.has(FriendOf)).toBe(true);
    expect(destroyedTarget.children(FriendOf).size).toBe(0);
    expect(survivingTarget.children(FriendOf)).toContain(source);
  });

  it("throws immediately when an incoming relationship uses CleanupPolicy.Throw", () => {
    const world = new World();
    world.component(FriendOf).meta.onDeleteTarget = CleanupPolicy.Throw;
    const target = world.entity();
    world.entity().add(FriendOf, target);

    expect(() => target.destroy()).toThrow(/relationship target is still in use/);
  });

  it("checks incoming Throw before target exit callbacks can destroy the source", () => {
    const world = new World();
    world.component(FriendOf).meta.onDeleteTarget = CleanupPolicy.Throw;
    const source = world.entity();
    let target: Entity;
    const exit = vi.fn((entity: Entity) => {
      if (entity === target) {
        source.destroy();
      }
    });
    world.query("target exit").with(true).exit(exit).build();
    target = world.entity();
    source.add(FriendOf, target);

    expect(() => target.destroy()).toThrow(/relationship target is still in use/);
    expect(exit).not.toHaveBeenCalled();
  });

  it("keeps incoming cleanup bound to its relationship generation during eid reuse", () => {
    class CascadesTo extends Relationship {}
    class OldRelationship extends Relationship {}
    class ReplacementRelationship extends Relationship {}
    const world = new World({
      idPools: [
        { name: "component", min: 1, max: 899, reuseWaitFrames: 0 },
        { name: "module", min: 900, max: 999 },
        { name: "entity", min: 1000 },
      ],
    });
    world.component(CascadesTo).meta.onDeleteTarget = CleanupPolicy.Delete;
    const oldDefinition = world.component(OldRelationship, 700);
    const oldTargetRemove = vi.fn();
    const oldRemove = vi.fn();
    oldDefinition.onTargetRemove(oldTargetRemove).onRemove(oldRemove);
    const source = world.entity();
    const firstDependency = world.entity().add(CascadesTo, source);
    const oldTarget = world.entity().add(CascadesTo, source);
    const oldInstance = source.add(OldRelationship, oldTarget).get(OldRelationship)!;
    const replacementTargetRemove = vi.fn();
    const replacementRemove = vi.fn();
    const replacementPolicy = vi.fn();
    let replacementDefinition: Entity | undefined;
    world
      .query("replace relationship definition")
      .with(true)
      .exit((entity) => {
        if (entity !== firstDependency) {
          return;
        }
        oldDefinition.destroy();
        replacementDefinition = world.component(ReplacementRelationship, 700);
        replacementDefinition.onTargetRemove(replacementTargetRemove).onRemove(replacementRemove);
        replacementDefinition.meta._targetRemovePolicies = new Map([[999, replacementPolicy]]);
      })
      .build();

    source.destroy();

    expect(oldTargetRemove).toHaveBeenCalledOnce();
    expect(oldTargetRemove).toHaveBeenCalledWith(source, oldInstance, oldTarget);
    expect(oldRemove).toHaveBeenCalledOnce();
    expect(oldRemove).toHaveBeenCalledWith(source, oldInstance);
    expect(replacementTargetRemove).not.toHaveBeenCalled();
    expect(replacementRemove).not.toHaveBeenCalled();
    expect(replacementPolicy).not.toHaveBeenCalled();
    expect(oldDefinition.instanceCount()).toBe(0);
    expect(world.getEntity(OldRelationship)).toBeUndefined();
    expect(world.getEntity(ReplacementRelationship)).toBe(replacementDefinition);
  });

  it("checks each Delete source attachment only once per iterative destruction", () => {
    const world = new World();
    const target = world.entity();
    const source = world.entity();
    const checks: ReturnType<typeof vi.spyOn>[] = [];
    for (let i = 0; i < 16; i++) {
      const RelationshipType = class extends Relationship {};
      const meta = world.component(RelationshipType).meta;
      meta.onDeleteTarget = CleanupPolicy.Delete;
      source.add(RelationshipType, target);
      checks.push(vi.spyOn(meta, "_assertCanDetach"));
    }

    target.destroy();

    for (const check of checks) {
      expect(check).toHaveBeenCalledOnce();
    }
  });

  it("removes Implements aliases with a destroyed concrete component definition", () => {
    abstract class Located {}
    class Point {}
    const world = new World();
    const located = world.component(Located);
    const point = world.component(Point).set(Implements, { interfaces: [Located] });
    const pointEid = point.eid;
    const locatedEid = located.eid;
    point.meta.onDelete = CleanupPolicy.Remove;
    const carrier = world.entity().add(Point);

    point.destroy();

    expect(carrier.destroyed).toBe(false);
    expect(carrier._get(pointEid)).toBeUndefined();
    expect(carrier._get(locatedEid)).toBeUndefined();
  });

  it("handles self-carry while removing a component definition from other carriers", () => {
    const world = new World();
    const key = world.entity();
    const keyEid = key.eid;
    key.meta.onDelete = CleanupPolicy.Remove;
    key.add(key);
    const carrier = world.entity().add(key);

    key.destroy();

    expect(key.destroyed).toBe(true);
    expect(carrier.destroyed).toBe(false);
    expect(carrier._get(keyEid)).toBeUndefined();
    expect(key.instanceCount()).toBe(0);
  });

  it("tears down relationship component definitions and their reverse indexes", () => {
    class ConnectedTo extends Relationship {}
    const world = new World();
    const relationship = world.component(ConnectedTo).add(Exclusive);
    const relationshipEid = relationship.eid;
    relationship.meta.onDelete = CleanupPolicy.Remove;
    const target = world.entity();
    const source = world.entity().add(ConnectedTo, target);

    relationship.destroy();

    expect(relationship.destroyed).toBe(true);
    expect(source.destroyed).toBe(false);
    expect(source._get(relationshipEid)).toBeUndefined();
    expect(target.children(relationshipEid).size).toBe(0);
  });

  it.each([
    ["add", (carrier: Entity) => carrier.add(Position), false],
    ["remove", (carrier: Entity) => carrier.remove(Position), true],
  ] as const)(
    "throws a stale deferred %s after definition destruction",
    (_name, apply, present) => {
      const world = new World();
      const component = world.component(Position);
      component.meta.onDelete = CleanupPolicy.Remove;
      const carrier = world.entity();
      if (present) {
        carrier.add(Position);
      }

      expect(() =>
        world.defer(() => {
          component.destroy();
          apply(carrier);
        })
      ).toThrow("Cannot use destroyed component Position");
    }
  );

  it("throws a stale deferred relationship command after definition destruction", () => {
    class OldRelationship extends Relationship {}
    class ReplacementRelationship extends Relationship {}
    class ReleasesDefinition extends Relationship {}
    const world = new World({
      idPools: [
        { name: "component", min: 1, max: 899, reuseWaitFrames: 0 },
        { name: "module", min: 900, max: 999 },
        { name: "entity", min: 1000 },
      ],
    });
    const definition = world.component(OldRelationship, 700);
    definition.meta.onDelete = CleanupPolicy.Remove;
    const replacementRegistered = vi.fn(() => {
      world.component(ReplacementRelationship, 700);
    });
    world.component(ReleasesDefinition).onTargetRemove(replacementRegistered);
    world.entity().add(ReleasesDefinition, definition);
    const source = world.entity();
    const target = world.entity();

    expect(() =>
      world.defer(() => {
        definition.destroy();
        source.add(OldRelationship, target);
      })
    ).toThrow("Cannot use destroyed component OldRelationship");
    expect(replacementRegistered).toHaveBeenCalledOnce();
  });

  it("cleans mutations made before a later Delete dependency begins", () => {
    const world = new World();
    const velocity = world.component(Velocity);
    world.component(FriendOf);
    const root = world.entity();
    const dependent = world.entity().childOf(root);
    const survivingTarget = world.entity();
    const exits: Entity[] = [];
    world
      .query("all entities")
      .with(true)
      .exit((entity) => {
        if (entity === root) {
          dependent.add(Velocity);
          dependent.add(FriendOf, survivingTarget);
        }
        if (entity === root || entity === dependent) {
          exits.push(entity);
        }
      })
      .build();

    root.destroy();

    expect(exits).toEqual([root, dependent]);
    expect(root.destroyed).toBe(true);
    expect(dependent.destroyed).toBe(true);
    expect(velocity.instanceCount()).toBe(0);
    expect(survivingTarget.children(FriendOf).size).toBe(0);
  });

  it("applies strict Throw ordering before a future Delete dependency starts", () => {
    class CascadesTo extends Relationship {}
    const world = new World();
    world.component(CascadesTo).meta.onDeleteTarget = CleanupPolicy.Delete;
    const root = world.entity();
    const key = world.entity().add(CascadesTo, root);
    const carrier = world.entity().add(CascadesTo, root).add(key);

    expect(() => root.destroy()).toThrow(/component eid is still in use/);
  });

  it("runs component-key Remove before key teardown and incoming Remove after target finalization", () => {
    class Marker {}
    const world = new World();
    const events: string[] = [];
    const component = world.component(Position);
    world.component(FriendOf);
    component.meta.onDelete = CleanupPolicy.Remove;
    world.component(Position).onRemove((entity) => {
      if (entity !== component) {
        events.push("carrier remove");
      }
    });
    world.component(Marker).onRemove((entity) => {
      if (entity === component) {
        events.push("key teardown");
      }
    });
    component.add(Marker);
    world.entity().add(Position);

    component.destroy();

    expect(events).toEqual(["carrier remove", "key teardown"]);

    const target = world.entity();
    const source = world.entity().add(FriendOf, target);
    world.component(FriendOf).onTargetRemove((_source, _relationship, removed) => {
      expect(removed).toBe(target);
      expect(world.getEntity(target.eid)).toBeUndefined();
      events.push("incoming remove");
    });
    target.destroy();
    expect(source.has(FriendOf)).toBe(false);
    expect(events.at(-1)).toBe("incoming remove");
  });

  it("propagates the first destruction callback exception immediately", () => {
    const world = new World();
    world.component(Position);
    world.component(FriendOf);
    let target: Entity;
    world
      .query("throwing exit")
      .with(true)
      .exit((entity) => {
        if (entity === target) {
          throw new Error("query exit failed");
        }
      })
      .build();
    target = world.entity().add(Position);
    world.entity().add(FriendOf, target);

    expect(() => target.destroy()).toThrow("query exit failed");
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
    relationship.onSet(onSet);
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
      .onTargetAdd((entity, instance, added) => {
        expect(entity.hasTarget(FriendOf, added)).toBe(true);
        expect(added.children(FriendOf)).toContain(entity);
        expect(instance).toBe(entity.get(FriendOf));
        events.push("target-add");
      })
      .onAdd(() => events.push("add"))
      .onTargetRemove((entity, instance, removed) => {
        expect(entity.has(FriendOf)).toBe(false);
        expect(instance._target()).toBeUndefined();
        expect(removed.children(FriendOf)).not.toContain(entity);
        events.push("target-remove");
      })
      .onRemove(() => events.push("remove"));

    source.add(FriendOf, target);
    source.remove(FriendOf, target);

    expect(events).toEqual(["target-add", "add", "target-remove", "remove"]);
  });

  it("propagates removal of the initializing relationship from onTargetAdd", () => {
    const w = new World();
    const relationship = w.component(FriendOf);
    relationship.onTargetAdd((source) => source.remove(FriendOf));
    const source = w.entity();
    const target = w.entity();

    expect(() => source.add(FriendOf, target)).toThrow(/while its add hooks are initializing it/);
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
      .onTargetRemove((entity, _instance, target) => {
        removed.push(target);
        if (target === first) {
          entity.add(FriendOf, third);
        }
      })
      .onTargetAdd((entity, _instance, target) => {
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
    relationship.onTargetRemove(removed).onTargetAdd(added);
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
