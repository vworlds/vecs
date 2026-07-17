import { describe, expect, it, vi } from "vitest";
import { CleanupPolicy, Exclusive, Implements, Relationship, World } from "../src/index.js";

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

  it.each([false, true])(
    "propagates forbidden query construction from %s deferred onAdd",
    (deferred) => {
      const world = new World();
      world.component(Position).onAdd(() => world.query("illegal").with(Position).build());
      const entity = world.entity();

      const add = () => {
        if (deferred) {
          world.defer(() => entity.add(Position));
        } else {
          entity.add(Position);
        }
      };

      expect(add).toThrow("queries cannot be built while component add hooks are initializing");
    }
  );

  it("allows cached term reads during onAdd", () => {
    const world = new World();
    const component = world.component(Position);
    const cached = world.getTerm(Position);
    component.onAdd(() => expect(world.getTerm(Position)).toBe(cached));

    world.entity().add(Position);
  });

  it("propagates uncached term construction from onAdd", () => {
    const world = new World();
    world.component(Position).onAdd(() => world.getTerm(Velocity));
    world.component(Velocity);

    expect(() => world.entity().add(Position)).toThrow(/terms cannot be materialized/);
  });

  it.each(["immediate", "deferred"] as const)(
    "propagates callback exceptions at the %s synchronization boundary",
    (mode) => {
      const world = new World();
      world.component(Position).onAdd(() => {
        throw new Error("callback failed");
      });
      const entity = world.entity();

      const add = () => {
        if (mode === "deferred") {
          world.defer(() => entity.add(Position));
        } else {
          entity.add(Position);
        }
      };

      expect(add).toThrow("callback failed");
    }
  );

  it("allows an idempotent same add during onAdd", () => {
    const world = new World();
    const component = world.component(Position);
    const hook = vi.fn((entity) => entity.add(Position));
    component.onAdd(hook);
    const entity = world.entity().add(Position);

    expect(hook).toHaveBeenCalledOnce();
    expect(component.instanceCount()).toBe(1);
    expect(entity.has(Position)).toBe(true);
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

  it("does not publish aliases removed reentrantly during concrete Enter", () => {
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
    const entity = world.entity().add(Point);

    expect(entity.has(Point)).toBe(false);
    expect(entity.has(Located)).toBe(false);
    expect(aliases.has(entity)).toBe(false);
    expect(aliasEnter).not.toHaveBeenCalled();
    expect(aliasExit).not.toHaveBeenCalled();
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
    world.entity().add(FriendOf, world.entity());

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

  it("supports nested non-exclusive target additions during relationship initialization", () => {
    const world = new World();
    const relationship = world.component(FriendOf);
    const source = world.entity();
    const first = world.entity();
    const second = world.entity();
    relationship.onTargetAdd((entity, _instance, target) => {
      if (target === first) {
        entity.add(FriendOf, second);
      }
    });

    source.add(FriendOf, first);

    expect(source.targets(FriendOf)).toEqual([first, second]);
    expect(first.children(FriendOf)).toContain(source);
    expect(second.children(FriendOf)).toContain(source);
  });

  it.each([
    ["remove", (entity: any) => entity.remove(Position)],
    ["destroy", (entity: any) => entity.destroy()],
    ["replace", (entity: any) => entity.attach(new Position())],
  ])("propagates illegal %s of an initializing attachment", (_name, operation) => {
    const world = new World();
    world.component(Position).onAdd(operation);

    expect(() => world.entity().add(Position)).toThrow(/while its add hooks are initializing it/);
  });

  it("propagates exclusive displacement of an initializing attachment", () => {
    const world = new World();
    world.component(Position);
    world.component(Velocity);
    world.setExclusiveComponents(Position, Velocity);
    world.component(Position).onAdd((entity) => entity.add(Velocity));

    expect(() => world.entity().add(Position)).toThrow(/while its add hooks are initializing it/);
  });

  it("propagates first-edge removal during relationship initialization", () => {
    const world = new World();
    const relationship = world.component(FriendOf).add(Exclusive);
    const target = world.entity();
    relationship.onTargetAdd((entity) => entity.remove(FriendOf, target));

    expect(() => world.entity().add(FriendOf, target)).toThrow(
      /while its add hooks are initializing it/
    );
  });
});
