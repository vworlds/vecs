import { describe, expect, it, vi } from "vitest";
import {
  CleanupPolicy,
  DontInherit,
  Implements,
  Inherit,
  IsA,
  OnInstantiate,
  Override,
  Singleton,
  World,
} from "../../src/index.js";

class Position {
  x = 0;
  y = 0;
}

class Velocity {
  x = 0;
}

class Hidden {}

describe("InheritanceModule", () => {
  it("registers the public policy API in every world", () => {
    const world = new World();

    expect(world.component(IsA).meta.relationshipExclusive).toBe(true);
    expect(world.component(Override).parent).toBe(world.component(OnInstantiate));
    expect(world.component(Inherit).parent).toBe(world.component(OnInstantiate));
    expect(world.component(DontInherit).parent).toBe(world.component(OnInstantiate));
  });

  it("shallow-copies Override components by default and skips DontInherit", () => {
    const world = new World();
    world.component(Position);
    world.component(Hidden).add(OnInstantiate, DontInherit);
    const template = world.entity().set(Position, { x: 4 }).add(Hidden);
    const child = world.entity().add(IsA, template);

    expect(child.get(Position)).toEqual({ x: 4, y: 0 });
    expect(child.get(Position)).not.toBe(template.get(Position));
    expect(child.has(Hidden)).toBe(false);

    template.set(Position, { x: 8 });
    expect(child.get(Position)?.x).toBe(4);
  });

  it("preserves components already owned by the inheritor", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const template = world.entity().set(Position, { x: 1 });
    const child = world.entity().set(Position, { x: 9 }).add(IsA, template);

    expect(child.get(Position)?.x).toBe(9);
    template.set(Position, { x: 2 });
    expect(child.get(Position)?.x).toBe(9);
  });

  it("preserves a local member of the inherited component's exclusive group", () => {
    class Walking {}
    class Running {}
    const world = new World();
    world.component(Walking);
    world.component(Running);
    world.setExclusiveComponents(Walking, Running);
    world.component(Walking).add(OnInstantiate, Inherit);
    const template = world.entity().add(Walking);
    const child = world.entity().add(Running).add(IsA, template);

    expect(child.has(Walking)).toBe(false);
    expect(child.has(Running)).toBe(true);
  });

  it("reveals an inherited exclusive component when the local peer is removed", () => {
    class Walking {}
    class Running {}
    const world = new World();
    world.component(Walking).add(OnInstantiate, Inherit);
    world.component(Running);
    world.setExclusiveComponents(Walking, Running);
    const template = world.entity();
    const child = world.entity().add(Running).add(IsA, template);

    template.add(Walking);
    expect(child.has(Walking)).toBe(false);

    child.remove(Running);
    expect(child.get(Walking)).toBe(template.get(Walking));
  });

  it("borrows Inherit components and routes source updates to child queries", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const update = vi.fn();
    world.query("positions").with(Position).update(Position, update).build();
    const template = world.entity().set(Position, { x: 1 });
    const child = world.entity().add(IsA, template);
    update.mockClear();

    expect(child.get(Position)).toBe(template.get(Position));
    template.set(Position, { x: 2 });

    expect(child.get(Position)?.x).toBe(2);
    expect(update).toHaveBeenCalledWith(template, template.get(Position));
    expect(update).toHaveBeenCalledWith(child, child.get(Position));
  });

  it("localizes an inherited component through every mutable API", () => {
    const operations = [
      (child: ReturnType<World["entity"]>) => child.set(Position, { x: 2 }),
      (child: ReturnType<World["entity"]>) =>
        child.getMut(Position, (position) => (position.x = 2)),
      (child: ReturnType<World["entity"]>) =>
        child.ensure(Position, (position) => (position.x = 2)),
      (child: ReturnType<World["entity"]>) => child.attach(Object.assign(new Position(), { x: 2 })),
      (child: ReturnType<World["entity"]>) => child.modified(Position),
    ];

    for (const operate of operations) {
      const world = new World();
      world.component(Position).add(OnInstantiate, Inherit);
      const template = world.entity().set(Position, { x: 1 });
      const child = world.entity().add(IsA, template);

      operate(child);
      expect(child.get(Position)).not.toBe(template.get(Position));

      template.set(Position, { x: 3 });
      expect(child.get(Position)?.x).not.toBe(3);
    }
  });

  it("reconciles source add, replacement, removal, and re-addition", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const template = world.entity();
    const child = world.entity().add(IsA, template);
    const query = world.query("positions").with(Position).build();

    template.set(Position, { x: 1 });
    expect(child.get(Position)).toBe(template.get(Position));
    expect(query.has(child)).toBe(true);

    const replacement = Object.assign(new Position(), { x: 2 });
    template.attach(replacement);
    expect(child.get(Position)).toBe(replacement);

    template.remove(Position);
    expect(child.has(Position)).toBe(false);
    expect(query.has(child)).toBe(false);

    template.set(Position, { x: 3 });
    expect(child.get(Position)).toBe(template.get(Position));
    expect(child.get(Position)?.x).toBe(3);
  });

  it("propagates through arbitrary layers and stops at a local override", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const root = world.entity().set(Position, { x: 1 });
    const middle = world.entity().add(IsA, root);
    const leaf = world.entity().add(IsA, middle);

    expect(leaf.get(Position)).toBe(root.get(Position));
    root.set(Position, { x: 2 });
    expect(middle.get(Position)?.x).toBe(2);
    expect(leaf.get(Position)?.x).toBe(2);

    middle.set(Position, { x: 10 });
    expect(leaf.get(Position)).toBe(middle.get(Position));
    root.set(Position, { x: 3 });
    expect(middle.get(Position)?.x).toBe(10);
    expect(leaf.get(Position)?.x).toBe(10);
  });

  it("supports clean retargeting without retaining borrowed components", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    world.component(Velocity).add(OnInstantiate, Inherit);
    const first = world.entity().set(Position, { x: 1 });
    const second = world.entity().set(Velocity, { x: 2 });
    const child = world.entity().add(IsA, first);

    child.add(IsA, second);

    expect(child.target(IsA)).toBe(second);
    expect(child.has(Position)).toBe(false);
    expect(child.get(Velocity)).toBe(second.get(Velocity));
  });

  it("drops borrowed values but retains Override copies when IsA is removed", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    world.component(Velocity);
    const template = world.entity().set(Position, { x: 1 }).set(Velocity, { x: 2 });
    const child = world.entity().add(IsA, template);

    child.remove(IsA);

    expect(child.has(Position)).toBe(false);
    expect(child.get(Velocity)?.x).toBe(2);
  });

  it("does not recreate a removed Override copy or copy Override additions later", () => {
    class Local {}
    const world = new World();
    world.component(Position);
    world.component(Velocity);
    world.component(Local);
    const template = world.entity().set(Position, { x: 1 });
    const child = world.entity().add(Local).add(IsA, template);

    child.remove(Position);
    expect(child.has(Position)).toBe(false);

    template.set(Velocity, { x: 2 });
    child.remove(Local);
    expect(child.has(Velocity)).toBe(false);
  });

  it("treats removing an inherited value as a local absence override", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const template = world.entity().set(Position, { x: 1 });
    const child = world.entity().add(IsA, template);

    child.remove(Position);
    template.set(Position, { x: 2 });
    expect(child.has(Position)).toBe(false);

    child.set(Position, { x: 3 });
    expect(child.get(Position)?.x).toBe(3);
  });

  it("inherits Implements aliases as the same borrowed or localized instance", () => {
    abstract class Point {
      x = 0;
    }
    class Position2D extends Point {
      y = 0;
    }

    const world = new World();
    world.component(Point);
    world.component(Position2D).set(Implements, { interfaces: [Point] });
    world.component(Position2D).add(OnInstantiate, Inherit);
    const template = world.entity().set(Position2D, { x: 1, y: 2 });
    const child = world.entity().add(IsA, template);

    expect(child.get(Point)).toBe(child.get(Position2D));
    expect(child.get(Position2D)).toBe(template.get(Position2D));

    child.set(Position2D, { x: 3 });
    expect(child.get(Point)).toBe(child.get(Position2D));
    expect(child.get(Position2D)).not.toBe(template.get(Position2D));
  });

  it("restores inheritance after a local interface implementation is removed", () => {
    abstract class Point {
      x = 0;
    }
    class TemplatePoint extends Point {}
    class LocalPoint extends Point {}

    const world = new World();
    world.component(Point);
    world.component(TemplatePoint).set(Implements, { interfaces: [Point] });
    world.component(LocalPoint).set(Implements, { interfaces: [Point] });
    world.component(TemplatePoint).add(OnInstantiate, Inherit);
    const template = world.entity().set(TemplatePoint, { x: 1 });
    const child = world.entity().set(LocalPoint, { x: 2 }).add(IsA, template);

    expect(child.get(Point)).toBe(child.get(LocalPoint));
    child.remove(LocalPoint);
    expect(child.get(Point)).toBe(child.get(TemplatePoint));
    expect(child.get(TemplatePoint)).toBe(template.get(TemplatePoint));

    child.set(LocalPoint, { x: 3 });
    expect(child.has(TemplatePoint)).toBe(false);
    child.remove(LocalPoint);
    expect(child.get(TemplatePoint)).toBe(template.get(TemplatePoint));
  });

  it("never inherits a Singleton after source removal and re-addition", () => {
    class GlobalState {}
    const world = new World();
    const singleton = world.component(GlobalState);
    singleton.add(Singleton);
    singleton.add(OnInstantiate, Inherit);
    const child = world.entity().add(IsA, singleton);

    expect(child.has(GlobalState)).toBe(false);
    singleton.remove(GlobalState);
    singleton.add(GlobalState);
    expect(child.has(GlobalState)).toBe(false);
  });

  it("does not count borrowed components as owned instances or fire ownership hooks", () => {
    const world = new World();
    const position = world.component(Position).add(OnInstantiate, Inherit);
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    position.on("add", onAdd).on("remove", onRemove);
    const template = world.entity().set(Position, { x: 1 });
    onAdd.mockClear();

    const child = world.entity().add(IsA, template);
    expect(position.instanceCount()).toBe(1);
    expect(onAdd).not.toHaveBeenCalled();

    child.remove(IsA);
    expect(position.instanceCount()).toBe(1);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("applies inheritance at the deferred relationship command boundary", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const template = world.entity().set(Position, { x: 1 });
    const child = world.entity();

    world.beginDefer();
    child.add(IsA, template);
    expect(child.has(Position)).toBe(false);
    world.endDefer();

    expect(child.get(Position)).toBe(template.get(Position));
  });

  it("defers inherited ownership transitions until the Modified command", () => {
    const world = new World();
    const position = world.component(Position).add(OnInstantiate, Inherit);
    const onAdd = vi.fn();
    position.on("add", onAdd);
    const template = world.entity().set(Position, { x: 1 });
    const child = world.entity().add(IsA, template);
    onAdd.mockClear();

    world.beginDefer();
    const mutable = child.getMut(Position)!;
    mutable.x = 2;
    expect(child.get(Position)).toBe(template.get(Position));
    expect(position.instanceCount()).toBe(1);
    expect(onAdd).not.toHaveBeenCalled();
    world.endDefer();

    expect(child.get(Position)).toBe(mutable);
    expect(position.instanceCount()).toBe(2);
    expect(onAdd).toHaveBeenCalledWith(child, mutable);
  });

  it("preserves deferred set then getMut changes on one inherited copy", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const template = world.entity().set(Position, { x: 1, y: 1 });
    const child = world.entity().add(IsA, template);

    world.beginDefer();
    child.set(Position, { x: 2 });
    const pending = child.getMut(Position)!;
    pending.y = 3;
    world.endDefer();

    expect(child.get(Position)).toBe(pending);
    expect(child.get(Position)).toEqual({ x: 2, y: 3 });
  });

  it("removes inherited state when the template is destroyed", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const template = world.entity().set(Position, { x: 1 });
    const child = world.entity().add(IsA, template);

    template.destroy();

    expect(child.has(IsA)).toBe(false);
    expect(child.has(Position)).toBe(false);
    expect(child.alive).toBe(true);
  });

  it("reconciles borrowed slots before component-key cleanup unregisters metadata", () => {
    for (const policy of [CleanupPolicy.Remove, CleanupPolicy.Delete]) {
      const world = new World();
      const position = world.component(Position).add(OnInstantiate, Inherit);
      const ceid = position.eid;
      position.meta.onDelete = policy;
      const template = world.entity().set(Position, { x: 1 });
      const child = world.entity().add(IsA, template);

      expect(() => position.destroy()).not.toThrow();
      expect(child.has(ceid)).toBe(false);
      expect(child.alive).toBe(true);
      expect(template.alive).toBe(policy === CleanupPolicy.Remove);
    }
  });

  it("tears down live inheritance trees with clearAllEntities", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const root = world.entity().set(Position, { x: 1 });
    const middle = world.entity().add(IsA, root);
    world.entity().add(IsA, middle);

    expect(() => world.clearAllEntities()).not.toThrow();
    expect(world.entities.size).toBe(0);
  });

  it("rejects self and ancestor cycles", () => {
    const first = new World();
    const self = first.entity();
    expect(() => self.add(IsA, self)).toThrow("IsA cycle detected");
    expect(self.has(IsA)).toBe(false);
    expect(self.children(IsA).size).toBe(0);

    const second = new World();
    const root = second.entity();
    const child = second.entity().add(IsA, root);
    expect(() => root.add(IsA, child)).toThrow("IsA cycle detected");
    expect(root.has(IsA)).toBe(false);
    expect(child.target(IsA)).toBe(root);
  });

  it("finishes source updates through very deep inheritance chains", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const root = world.entity().set(Position, { x: 1 });
    let leaf = root;
    for (let i = 0; i < 3_000; i++) {
      leaf = world.entity().add(IsA, leaf);
    }

    expect(() => root.set(Position, { x: 2 })).not.toThrow();
    expect(leaf.get(Position)?.x).toBe(2);
  });

  it("abandons an old template walk after a reentrant retarget", () => {
    class First {}
    class Second {}
    class Final {}
    const world = new World();
    world.component(First);
    world.component(Second);
    world.component(Final);
    const oldTemplate = world.entity().add(First).add(Second);
    const newTemplate = world.entity().add(Final);
    const child = world.entity();
    world.component(First).on("add", (entity) => {
      if (entity === child) {
        child.add(IsA, newTemplate);
      }
    });

    child.add(IsA, oldTemplate);

    expect(child.target(IsA)).toBe(newTemplate);
    expect(child.has(First)).toBe(false);
    expect(child.has(Second)).toBe(false);
    expect(child.has(Final)).toBe(true);
  });

  it("does not install stale inherited aliases after a reentrant retarget", () => {
    abstract class Value {
      amount = 0;
    }
    class OldValue extends Value {}
    class Final {}
    const world = new World();
    world.component(Value);
    world.component(OldValue).set(Implements, { interfaces: [Value] });
    world.component(OldValue).add(OnInstantiate, Inherit);
    world.component(Final);
    const oldTemplate = world.entity().set(OldValue, { amount: 1 });
    const newTemplate = world.entity().add(Final);
    const child = world.entity();
    world
      .query("old values")
      .with(OldValue)
      .enter((entity) => {
        if (entity === child) {
          child.add(IsA, newTemplate);
        }
      })
      .build();

    child.add(IsA, oldTemplate);

    expect(child.target(IsA)).toBe(newTemplate);
    expect(child.has(OldValue)).toBe(false);
    expect(child.has(Value)).toBe(false);
    expect(child.has(Final)).toBe(true);
  });

  it("clears every old borrowed slot when an exit callback installs a new template", () => {
    class First {}
    class Second {}
    class Final {}
    const world = new World();
    world.component(First).add(OnInstantiate, Inherit);
    world.component(Second).add(OnInstantiate, Inherit);
    world.component(Final).add(OnInstantiate, Inherit);
    const oldTemplate = world.entity().add(First).add(Second);
    const newTemplate = world.entity().add(Final);
    const child = world.entity().add(IsA, oldTemplate);
    world
      .query("first")
      .with(First)
      .exit(() => child.add(IsA, newTemplate))
      .build();

    child.remove(IsA);

    expect(child.target(IsA)).toBe(newTemplate);
    expect(child.has(First)).toBe(false);
    expect(child.has(Second)).toBe(false);
    expect(child.get(Final)).toBe(newTemplate.get(Final));
  });

  it("preserves a shared source instance when source removal triggers retargeting", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const root = world.entity().set(Position, { x: 1 });
    const oldTemplate = world.entity().add(IsA, root);
    const newTemplate = world.entity().add(IsA, root);
    const child = world.entity().add(IsA, oldTemplate);
    world
      .query("positions during retarget")
      .with(Position)
      .exit((entity) => {
        if (entity === child) {
          child.add(IsA, newTemplate);
        }
      })
      .build();

    oldTemplate.remove(Position);

    expect(child.target(IsA)).toBe(newTemplate);
    expect(child.has(Position)).toBe(true);
    expect(child.get(Position)).toBe(root.get(Position));
  });
});
