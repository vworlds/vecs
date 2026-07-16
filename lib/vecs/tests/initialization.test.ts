import { describe, expect, it, vi } from "vitest";
import {
  CleanupPolicy,
  Exclusive,
  Implements,
  Relationship,
  World,
  type Entity,
} from "../src/index.js";

class Position {
  x = 0;
}

class Velocity {}

class FriendOf extends Relationship {}

describe("component initialization", () => {
  it("uses ComponentMeta as carrier authority without scanning for a late component term", () => {
    const world = new World();
    const component = world.component(Position);
    const first = world.entity().add(Position);
    const second = world.entity().add(Position);
    const scan = vi.spyOn(world.entities, "forEach");

    const term = world.getTerm(Position);

    expect(scan).not.toHaveBeenCalled();
    expect(component.instanceCount()).toBe(2);
    expect(term.count).toBe(2);
    expect([...term]).toEqual([first, second]);
  });

  it("rebinds a numeric term across late registration and component eid reuse", () => {
    class First {}
    class Second {}
    const world = new World({
      idPools: [
        { name: "component", min: 1, max: 899, reuseWaitFrames: 0 },
        { name: "module", min: 900, max: 999 },
        { name: "entity", min: 1000 },
      ],
    });
    const term = world.getTerm(700);
    expect(term.count).toBe(0);

    const firstComponent = world.component(First, 700);
    const firstCarrier = world.entity().add(First);
    expect(term.has(firstCarrier)).toBe(true);

    firstComponent.meta.onDelete = CleanupPolicy.Remove;
    firstComponent.destroy();
    expect(term.count).toBe(0);

    world.component(Second, 700);
    const secondCarrier = world.entity().add(Second);
    expect(world.getTerm(700)).toBe(term);
    expect(term.has(firstCarrier)).toBe(false);
    expect(term.has(secondCarrier)).toBe(true);
  });

  it("exposes direct storage and usage during onAdd but publishes query Enter afterward", () => {
    const world = new World();
    const component = world.component(Position);
    const events: string[] = [];
    const query = world
      .query("positions")
      .with(Position)
      .enter(() => events.push("enter"))
      .build();
    component.onAdd((entity, position) => {
      events.push("onAdd");
      expect(entity.get(Position)).toBe(position);
      expect(entity.has(Position)).toBe(true);
      expect(component.instanceCount()).toBe(1);
      expect(world.getTerm(Position).has(entity)).toBe(false);
      expect(query.has(entity)).toBe(false);
    });

    const entity = world.entity().add(Position);

    expect(events).toEqual(["onAdd", "enter"]);
    expect(query.has(entity)).toBe(true);
  });

  it.each([false, true])("rejects query building in %s deferred onAdd execution", (deferred) => {
    const world = new World();
    world.component(Position).onAdd(() => {
      expect(() => world.query("illegal").with(Position).build()).toThrow(
        "queries cannot be built while component add hooks are initializing"
      );
    });
    const entity = world.entity();
    const queryCount = world.queries.length;

    if (deferred) {
      world.defer(() => entity.add(Position));
    } else {
      entity.add(Position);
    }

    expect(entity.has(Position)).toBe(true);
    expect(world.queries.map((query) => query.name)).not.toContain("illegal");
    expect(world.queries.length).toBeGreaterThanOrEqual(queryCount);
  });

  it("allows cached term reads but rejects new term materialization during onAdd", () => {
    const world = new World();
    const component = world.component(Position);
    world.component(Velocity);
    const cached = world.getTerm(Position);
    component.onAdd(() => {
      expect(world.getTerm(Position)).toBe(cached);
      expect(() => world.getTerm(Velocity)).toThrow(/terms cannot be materialized/);
    });

    world.entity().add(Position);

    expect(world._getCachedTerm(Velocity)).toBeUndefined();
  });

  it("rolls back a throwing onAdd without Enter or public onRemove", () => {
    const world = new World();
    const component = world.component(Position);
    const enter = vi.fn();
    const remove = vi.fn();
    world.query("positions").with(Position).enter(enter).build();
    component.onRemove(remove).onAdd(() => {
      throw new Error("initialization failed");
    });
    const entity = world.entity();

    expect(() => entity.add(Position)).toThrow("initialization failed");
    expect(entity.get(Position)).toBeUndefined();
    expect(entity.has(Position)).toBe(false);
    expect(component.instanceCount()).toBe(0);
    expect(world.getTerm(Position).has(entity)).toBe(false);
    expect(enter).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    component.onAdd(undefined);
    entity.add(Position);
    expect(entity.has(Position)).toBe(true);
    expect(enter).toHaveBeenCalledOnce();
  });

  it("keeps committed authority when an Enter observer throws", () => {
    const world = new World();
    const component = world.component(Position);
    const laterEnter = vi.fn();
    const first = world
      .query("throwing observer")
      .with(Position)
      .enter(() => {
        throw new Error("observer failed");
      })
      .build();
    const second = world.query("later observer").with(Position).enter(laterEnter).build();
    const entity = world.entity();

    expect(() => entity.add(Position)).toThrow("observer failed");

    expect(entity.has(Position)).toBe(true);
    expect(component.instanceCount()).toBe(1);
    expect(world.getTerm(Position).has(entity)).toBe(true);
    expect(first.has(entity)).toBe(true);
    expect(second.has(entity)).toBe(true);
    expect(laterEnter).toHaveBeenCalledWith(entity);
  });

  it("does not publish pending aliases removed reentrantly during concrete Enter", () => {
    abstract class Located {}
    class Point {}
    const world = new World();
    world.component(Located);
    world.component(Point).set(Implements, { interfaces: [Located] });
    const aliasEnter = vi.fn();
    const aliasExit = vi.fn();
    world
      .query("remove concrete on enter")
      .with(Point)
      .enter((entity) => entity.remove(Point))
      .build();
    const aliases = world.query("aliases").with(Located).enter(aliasEnter).exit(aliasExit).build();
    const entity = world.entity();

    entity.add(Point);

    expect(entity.has(Point)).toBe(false);
    expect(entity.has(Located)).toBe(false);
    expect(aliases.has(entity)).toBe(false);
    expect(aliasEnter).not.toHaveBeenCalled();
    expect(aliasExit).not.toHaveBeenCalled();
  });

  it.each([CleanupPolicy.Remove, CleanupPolicy.Delete])(
    "forbids %s component-key destruction during onAdd",
    (policy) => {
      const world = new World();
      const component = world.component(Position);
      component.meta.onDelete = policy;
      component.onAdd(() => component.destroy());
      const entity = world.entity();

      expect(() => entity.add(Position)).toThrow(/initializing attachment/);
      expect(entity.has(Position)).toBe(false);
      expect(component.destroyed).toBe(false);
      expect(component.instanceCount()).toBe(0);
    }
  );

  it("forbids self-removal, carrier destruction, and attach replacement during onAdd", () => {
    const operations = [
      (entity: Entity) => entity.remove(Position),
      (entity: Entity) => entity.destroy(),
      (entity: Entity) => entity.attach(new Position()),
    ];

    for (const operation of operations) {
      const world = new World();
      const component = world.component(Position);
      component.onAdd((entity) => operation(entity));
      const entity = world.entity();

      expect(() => entity.add(Position)).toThrow(/while its add hooks are initializing it/);
      expect(entity.has(Position)).toBe(false);
      expect(entity.destroyed).toBe(false);
      expect(component.instanceCount()).toBe(0);
    }
  });

  it("allows an idempotent same add during onAdd", () => {
    const world = new World();
    const component = world.component(Position);
    const hook = vi.fn((entity: Entity) => entity.add(Position));
    component.onAdd(hook);
    const entity = world.entity().add(Position);

    expect(hook).toHaveBeenCalledOnce();
    expect(component.instanceCount()).toBe(1);
    expect(entity.has(Position)).toBe(true);
  });

  it("forbids exclusive displacement of an initializing component", () => {
    const world = new World();
    world.component(Position);
    world.component(Velocity);
    world.setExclusiveComponents(Position, Velocity);
    world.component(Position).onAdd((entity) => entity.add(Velocity));
    const entity = world.entity();

    expect(() => entity.add(Position)).toThrow(/while its add hooks are initializing it/);
    expect(entity.has(Position)).toBe(false);
    expect(entity.has(Velocity)).toBe(false);
  });

  it("initializes concrete and Implements aliases before publishing any Enter", () => {
    abstract class Shape {}
    class Circle {}
    const world = new World();
    world.component(Shape);
    world.component(Circle).set(Implements, { interfaces: [Shape] });
    const events: string[] = [];
    world.component(Circle).onAdd(() => events.push("circle add"));
    world.component(Shape).onAdd(() => events.push("shape add"));
    world
      .query("circles")
      .with(Circle)
      .enter(() => events.push("circle enter"))
      .build();
    world
      .query("shapes")
      .with(Shape)
      .enter(() => events.push("shape enter"))
      .build();

    const entity = world.entity().add(Circle);

    expect(events).toEqual(["circle add", "shape add", "circle enter", "shape enter"]);
    expect(entity.get(Shape)).toBe(entity.get(Circle));
  });

  it("forbids implementer alias eviction while the first implementer initializes", () => {
    abstract class Shape {}
    class Circle {}
    class Square {}
    const world = new World();
    world.component(Shape);
    world.component(Circle).set(Implements, { interfaces: [Shape] });
    world.component(Square).set(Implements, { interfaces: [Shape] });
    world.component(Circle).onAdd((entity) => entity.add(Square));
    const entity = world.entity();

    expect(() => entity.add(Circle)).toThrow(/while its add hooks are initializing it/);
    expect(entity.has(Circle)).toBe(false);
    expect(entity.has(Square)).toBe(false);
    expect(entity.has(Shape)).toBe(false);
  });

  it("initializes a first relationship edge before Enter and rolls it back on failure", () => {
    const world = new World();
    const relationship = world.component(FriendOf);
    const events: string[] = [];
    const query = world
      .query("friends")
      .with(FriendOf)
      .enter(() => events.push("enter"))
      .build();
    const source = world.entity();
    const target = world.entity();
    relationship
      .onTargetAdd((entity, instance, added) => {
        events.push("target add");
        expect(entity.get(FriendOf)).toBe(instance);
        expect(entity.hasTarget(FriendOf, added)).toBe(true);
        expect(added.children(FriendOf)).toContain(entity);
        expect(query.has(entity)).toBe(false);
      })
      .onAdd(() => {
        events.push("add");
        throw new Error("relationship failed");
      });

    expect(() => source.add(FriendOf, target)).toThrow("relationship failed");
    expect(events).toEqual(["target add", "add"]);
    expect(source.has(FriendOf)).toBe(false);
    expect(source.targets(FriendOf)).toEqual([]);
    expect(target.children(FriendOf)).not.toContain(source);
    expect(relationship.instanceCount()).toBe(0);
    expect(query.has(source)).toBe(false);
  });

  it("keeps compiled and target terms out until their authoritative attachments are live", () => {
    const world = new World();
    world.component(Position);
    world.component(Velocity);
    const relationship = world.component(FriendOf);
    const events: string[] = [];
    world
      .query("merged")
      .with({ any: [Position, { all: [Position, Velocity] }] })
      .enter(() => events.push("merged enter"))
      .build();
    world
      .query("target")
      .with({ target: [FriendOf, Velocity] })
      .enter(() => events.push("target enter"))
      .build();
    world.component(Position).onAdd((entity) => {
      events.push("position add start");
      entity.add(Velocity);
      expect(events).not.toContain("merged enter");
      events.push("position add end");
    });
    relationship
      .onTargetAdd((_source, _instance, target) => {
        events.push("target add start");
        target.add(Velocity);
        expect(events).not.toContain("target enter");
        events.push("target add end");
      })
      .onAdd(() => events.push("relationship add"));

    world.entity().add(Position);
    const source = world.entity();
    source.add(FriendOf, world.entity());

    expect(events).toEqual([
      "position add start",
      "position add end",
      "merged enter",
      "target add start",
      "target add end",
      "relationship add",
      "target enter",
    ]);
  });

  it("rolls back recursively added first-relationship edges and reverse indexes", () => {
    const world = new World();
    const relationship = world.component(FriendOf);
    const source = world.entity();
    const first = world.entity();
    const second = world.entity();
    relationship
      .onTargetAdd((entity, _instance, target) => {
        if (target === first) {
          entity.add(FriendOf, second);
        }
      })
      .onAdd(() => {
        throw new Error("relationship failed");
      });

    expect(() => source.add(FriendOf, first)).toThrow("relationship failed");
    expect(source.targets(FriendOf)).toEqual([]);
    expect(first.children(FriendOf)).not.toContain(source);
    expect(second.children(FriendOf)).not.toContain(source);
    expect(relationship.instanceCount()).toBe(0);
  });

  it("forbids first-edge removal and exclusive replacement during target initialization", () => {
    for (const replace of [false, true]) {
      const world = new World();
      const relationship = world.component(FriendOf).add(Exclusive);
      const source = world.entity();
      const first = world.entity();
      const second = world.entity();
      relationship.onTargetAdd((entity) => {
        if (replace) {
          entity.add(FriendOf, second);
        } else {
          entity.remove(FriendOf, first);
        }
      });

      expect(() => source.add(FriendOf, first)).toThrow(/while its add hooks are initializing it/);
      expect(source.has(FriendOf)).toBe(false);
      expect(first.children(FriendOf)).not.toContain(source);
      expect(second.children(FriendOf)).not.toContain(source);
    }
  });

  it("forbids destroying a target when cleanup would remove the initializing final edge", () => {
    const world = new World();
    const relationship = world.component(FriendOf);
    const source = world.entity();
    const target = world.entity();
    relationship.onTargetAdd((_entity, _instance, added) => added.destroy());

    expect(() => source.add(FriendOf, target)).toThrow(/while its add hooks are initializing it/);
    expect(target.destroyed).toBe(false);
    expect(source.has(FriendOf)).toBe(false);
    expect(relationship.instanceCount()).toBe(0);
  });

  it("applies initialization authority to plain entity component keys", () => {
    const world = new World();
    const key = world.entity();
    const query = world.query("plain key").with(key).build();
    key.onAdd((entity, value) => {
      expect(entity.get(key)).toBe(value);
      expect(key.instanceCount()).toBe(1);
      expect(query.has(entity)).toBe(false);
      entity.remove(key);
    });
    const carrier = world.entity();

    expect(() => carrier.add(key)).toThrow(/while its add hooks are initializing it/);
    expect(carrier.has(key)).toBe(false);
    expect(key.instanceCount()).toBe(0);
    expect(query.has(carrier)).toBe(false);
  });

  it("rolls back failed deferred initialization and consumes the failed command", () => {
    const world = new World();
    const component = world.component(Position);
    const entity = world.entity();
    component.onAdd((carrier) => carrier.destroy());

    expect(() => world.defer(() => entity.add(Position))).toThrow(
      /while its add hooks are initializing it/
    );
    expect(entity.destroyed).toBe(false);
    expect(entity.has(Position)).toBe(false);
    expect(component.instanceCount()).toBe(0);

    component.onAdd(undefined);
    expect(() => world.flush()).not.toThrow();
    expect(entity.has(Position)).toBe(false);
  });

  it("preserves a pending ensure side effect queued by a failing deferred onAdd", () => {
    const world = new World();
    const position = world.component(Position);
    const velocity = world.component(Velocity);
    const failing = world.entity();
    const sideEffect = world.entity();
    position.onAdd(() => {
      sideEffect.ensure(Velocity);
      throw new Error("position failed");
    });

    expect(() => world.defer(() => failing.add(Position))).toThrow("position failed");

    expect(failing.has(Position)).toBe(false);
    expect(position.instanceCount()).toBe(0);
    expect(velocity.meta._pendingEnsures?.has(sideEffect)).toBe(true);

    expect(() => world.flush()).not.toThrow();
    expect(sideEffect.has(Velocity)).toBe(true);
    expect(velocity.meta._pendingEnsures?.has(sideEffect)).toBe(false);
  });

  it("clears self-modified dirtiness after deferred attachment rollback", () => {
    const world = new World();
    const component = world.component(Position);
    const onSet = vi.fn();
    const update = vi.fn();
    component.onSet(onSet).onAdd((entity) => {
      entity.modified(Position);
      throw new Error("position failed");
    });
    world.query("position updates").with(Position).update(Position, update).build();
    const entity = world.entity();

    expect(() => world.defer(() => entity.add(Position))).toThrow("position failed");
    expect(entity.has(Position)).toBe(false);
    expect(() => world.flush()).not.toThrow();

    component.onAdd(undefined);
    entity.add(Position);
    onSet.mockClear();
    update.mockClear();

    entity.modified(Position);

    expect(onSet).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });
});
