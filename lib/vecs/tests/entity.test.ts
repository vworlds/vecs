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

describe("Entity — indexed deletion planner", () => {
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

  it("validates every planned Remove exactly once before removing anything", () => {
    const world = new World();
    const component = world.component(Position);
    const componentEid = component.eid;
    component.meta.onDelete = CleanupPolicy.Remove;
    const first = world.entity().add(Position);
    const second = world.entity().add(Position);
    const validations: Entity[] = [];
    component.meta._validateRemove = (carrier) => {
      expect(first.has(Position)).toBe(true);
      expect(second.has(Position)).toBe(true);
      validations.push(carrier);
    };

    component.destroy();

    expect(validations).toEqual([first, second]);
    expect(first._get(componentEid)).toBeUndefined();
    expect(second._get(componentEid)).toBeUndefined();
  });

  it("leaves the root and every carrier unchanged when Remove validation fails", () => {
    const world = new World();
    const component = world.component(Position);
    component.meta.onDelete = CleanupPolicy.Remove;
    const first = world.entity().add(Position);
    const second = world.entity().add(Position);
    const firstValue = first.get(Position);
    const secondValue = second.get(Position);
    let validations = 0;
    component.meta._validateRemove = () => {
      if (++validations === 2) {
        throw new Error("blocked removal");
      }
    };

    expect(() => component.destroy()).toThrow("blocked removal");

    expect(validations).toBe(2);
    expect(component.destroyed).toBe(false);
    expect(world.entity(component.eid)).toBe(component);
    expect(first.get(Position)).toBe(firstValue);
    expect(second.get(Position)).toBe(secondValue);
    expect(component.instanceCount()).toBe(2);
  });

  it("leaves a direct Delete cascade unchanged when its carrier is a blocked component key", () => {
    class RootComponent {}
    const world = new World();
    const root = world.component(RootComponent);
    root.meta.onDelete = CleanupPolicy.Delete;
    const blockedCarrier = world.entity().add(RootComponent);
    const holder = world.entity().add(blockedCarrier);

    expect(() => root.destroy()).toThrow(/component eid is still in use/);

    expect(root.destroyed).toBe(false);
    expect(blockedCarrier.destroyed).toBe(false);
    expect(blockedCarrier.has(RootComponent)).toBe(true);
    expect(holder.has(blockedCarrier)).toBe(true);
  });

  it("leaves a transitive Delete cascade unchanged when a nested carrier is blocked", () => {
    class RootComponent {}
    class NestedComponent {}
    const world = new World();
    const root = world.component(RootComponent);
    const nested = world.component(NestedComponent).add(RootComponent);
    root.meta.onDelete = CleanupPolicy.Delete;
    nested.meta.onDelete = CleanupPolicy.Delete;
    const blockedCarrier = world.entity().add(NestedComponent);
    const holder = world.entity().add(blockedCarrier);

    expect(() => root.destroy()).toThrow(/component eid is still in use/);

    expect(root.destroyed).toBe(false);
    expect(nested.destroyed).toBe(false);
    expect(blockedCarrier.destroyed).toBe(false);
    expect(nested.has(RootComponent)).toBe(true);
    expect(blockedCarrier.has(NestedComponent)).toBe(true);
    expect(holder.has(blockedCarrier)).toBe(true);
  });

  it("leaves a target and graph unchanged when an incoming Delete source is blocked", () => {
    class CascadesTo extends Relationship {}
    const world = new World();
    world.component(CascadesTo).meta.onDeleteTarget = CleanupPolicy.Delete;
    const target = world.entity();
    const blockedSource = world.entity().add(CascadesTo, target);
    const holder = world.entity().add(blockedSource);

    expect(() => target.destroy()).toThrow(/component eid is still in use/);

    expect(target.destroyed).toBe(false);
    expect(blockedSource.destroyed).toBe(false);
    expect(blockedSource.hasTarget(CascadesTo, target)).toBe(true);
    expect(target.children(CascadesTo)).toContain(blockedSource);
    expect(holder.has(blockedSource)).toBe(true);
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

  it("consumes a deferred blocked plan without partial mutation and keeps FIFO usable", () => {
    class CascadesTo extends Relationship {}
    const world = new World();
    world.component(CascadesTo).meta.onDeleteTarget = CleanupPolicy.Delete;
    world.component(Position);
    const target = world.entity();
    const blockedSource = world.entity().add(CascadesTo, target);
    const holder = world.entity().add(blockedSource);
    const later = world.entity();

    world.defer(() => {
      target.destroy();
      later.add(Position);
    });

    expect(target.destroyed).toBe(false);
    expect(blockedSource.destroyed).toBe(false);
    expect(blockedSource.hasTarget(CascadesTo, target)).toBe(true);
    expect(target.children(CascadesTo)).toContain(blockedSource);
    expect(holder.has(blockedSource)).toBe(true);
    expect(later.has(Position)).toBe(true);

    expect(() => world.defer(() => later.remove(Position))).not.toThrow();
    expect(later.has(Position)).toBe(false);
  });

  it("forbids and contains structural mutation attempted by Remove validators", () => {
    class RegisteredDuringValidation {}
    const world = new World();
    const component = world.component(Position);
    world.component(Velocity);
    world.component(FriendOf);
    component.meta.onDelete = CleanupPolicy.Remove;
    const carrier = world.entity().add(Position);
    const untouched = world.entity();
    const mutable = world.entity().set(Velocity, { vx: 1 });
    const mutate = vi.fn((velocity: Velocity) => {
      velocity.vx = 99;
    });
    const relationshipTarget = world.entity();
    const relationshipSource = world.entity().add(FriendOf, relationshipTarget);
    const cached = world.getTerm(Position);
    const queryCount = world.queries.length;
    let validations = 0;
    component.meta._validateRemove = () => {
      validations++;
      expect(world.getTerm(Position)).toBe(cached);
      const attempts = [
        () => untouched.add(Velocity),
        () => untouched.set(Velocity, {}),
        () => untouched.attach(new Velocity()),
        () => untouched.ensure(Velocity, () => {}),
        () => untouched.modified(Velocity),
        () => mutable.getMut(Velocity, mutate),
        () => carrier.remove(Position),
        () => relationshipSource.add(FriendOf, untouched),
        () => relationshipSource.remove(FriendOf, relationshipTarget),
        () => untouched.destroy(),
        () => world.entity(),
        () => world.getOrCreateEntity(50_000),
        () => world.component(RegisteredDuringValidation),
        () => world.query("forbidden"),
        () => world.getTerm(Velocity),
        () => world.beginDefer(),
        () => world.endDefer(),
        () => world.defer(() => untouched.add(Velocity)),
      ];
      attempts.forEach((attempt) => expect(attempt).toThrow(/deletion preflight/));
    };

    component.destroy();

    expect(validations).toBe(1);
    expect(untouched.empty).toBe(true);
    expect(untouched.destroyed).toBe(false);
    expect(mutable.get(Velocity)?.vx).toBe(1);
    expect(mutate).not.toHaveBeenCalled();
    expect(world.deferred).toBe(false);
    expect((world as any)._deferredDepth).toBe(0);
    expect(relationshipSource.targets(FriendOf)).toEqual([relationshipTarget]);
    expect(relationshipTarget.children(FriendOf)).toContain(relationshipSource);
    expect(world.getEntity(50_000)).toBeUndefined();
    expect(world.getEntity(RegisteredDuringValidation)).toBeUndefined();
    expect(world.queries).toHaveLength(queryCount);
    expect(world._getCachedTerm(Velocity)).toBeUndefined();
  });

  it("no-ops a stale component command queued after definition destruction", () => {
    const world = new World();
    const component = world.component(Position);
    component.meta.onDelete = CleanupPolicy.Remove;
    const componentEid = component.eid;
    const carrier = world.entity();

    world.defer(() => {
      component.destroy();
      carrier.set(Position, { x: 99 });
    });

    expect(component.destroyed).toBe(true);
    expect(carrier._get(componentEid)).toBeUndefined();
  });

  it("does not let a stale meta mutate a replacement definition at a reused eid", () => {
    class Replacement {
      value = 0;
    }
    const world = new World({
      idPools: [
        { name: "component", min: 1, max: 899, reuseWaitFrames: 0 },
        { name: "module", min: 900, max: 999 },
        { name: "entity", min: 1000 },
      ],
    });
    const oldDefinition = world.component(Position, 700);
    const oldMeta = oldDefinition.meta;
    oldMeta.onDelete = CleanupPolicy.Remove;
    oldDefinition.onRemove(() => {
      throw new Error("teardown observer failed");
    });
    const carrier = world.entity().add(Position);

    expect(() =>
      world.defer(() => {
        oldDefinition.destroy();
        carrier.set(Position, { x: 99 });
      })
    ).toThrow("teardown observer failed");

    const replacement = world.component(Replacement, 700);
    carrier.set(Replacement, { value: 7 });
    expect(replacement.meta._generation).not.toBe(oldMeta._generation);

    expect(() => world.flush()).not.toThrow();
    expect(carrier.get(Replacement)).toEqual({ value: 7 });
    expect(carrier.get(Replacement)).not.toHaveProperty("x");
    expect(replacement.instanceCount()).toBe(1);
  });

  it("freezes later Delete dependents before root exit callbacks can mutate them", () => {
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

  it("allows a Throw carrier that is independently doomed by the same Delete closure", () => {
    class CascadesTo extends Relationship {}
    const world = new World();
    world.component(CascadesTo).meta.onDeleteTarget = CleanupPolicy.Delete;
    const root = world.entity();
    const key = world.entity().add(CascadesTo, root);
    const carrier = world.entity().add(CascadesTo, root).add(key);

    expect(() => root.destroy()).not.toThrow();

    expect(root.destroyed).toBe(true);
    expect(key.destroyed).toBe(true);
    expect(carrier.destroyed).toBe(true);
    expect(key.instanceCount()).toBe(0);
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

  it("completes planned teardown after query and removal callbacks throw", () => {
    const world = new World();
    const position = world.component(Position);
    const relationship = world.component(FriendOf);
    const laterExit = vi.fn();
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
    world
      .query("later exit")
      .with(true)
      .exit((entity) => {
        if (entity === target) {
          laterExit(entity);
        }
      })
      .build();
    const onRemove = vi.fn(() => {
      throw new Error("remove failed");
    });
    const onTargetRemove = vi.fn(() => {
      throw new Error("target remove failed");
    });
    position.onRemove(onRemove);
    relationship.onTargetRemove(onTargetRemove);
    target = world.entity().add(Position);
    const source = world.entity().add(FriendOf, target);
    const targetEid = target.eid;

    expect(() => target.destroy()).toThrow("query exit failed");

    expect(target.destroyed).toBe(true);
    expect(world.getEntity(targetEid)).toBeUndefined();
    expect(position.instanceCount()).toBe(0);
    expect(source.has(FriendOf)).toBe(false);
    expect(target.children(FriendOf).size).toBe(0);
    expect(laterExit).toHaveBeenCalledWith(target);
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onTargetRemove).toHaveBeenCalledOnce();
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

  it("rejects removing the initializing relationship from onTargetAdd and rolls it back", () => {
    const w = new World();
    const relationship = w.component(FriendOf);
    const query = w.query("reentrant relationship add").with(FriendOf).build();
    const onAdd = vi.fn();
    const onTargetAdd = vi.fn((source: Entity) => source.remove(FriendOf));
    relationship.onTargetAdd(onTargetAdd).onAdd(onAdd);
    const source = w.entity();
    const target = w.entity();

    expect(() => source.add(FriendOf, target)).toThrow(/while its add hooks are initializing it/);

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
