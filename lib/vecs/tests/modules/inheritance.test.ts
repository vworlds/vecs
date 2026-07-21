import { describe, expect, it, vi } from "vitest";
import {
  CleanupPolicy,
  type ComponentClass,
  DontInherit,
  type Entity,
  Exclusive,
  Implements,
  Inherit,
  IsA,
  OneOf,
  OnInstantiate,
  Override,
  Relationship,
  Singleton,
  With,
  World,
} from "../../src/index.js";

class Position {
  x = 0;
  nested = { value: 0 };
}
class Shared {
  value = 0;
}
class Skipped {}
class Other {}
class Rel extends Relationship {}
abstract class Alias {}
class First {}
class Second {}
class FakePolicy {}
class WithDependency {}
class WithDependent {}
class FrozenShared {
  constructor() {
    Object.preventExtensions(this);
  }
}

describe("InheritanceModule", () => {
  it("configures the public built-ins", () => {
    const world = new World();
    const onInstantiate = world.component(OnInstantiate);

    expect(world.component(IsA).has(Exclusive)).toBe(true);
    expect(world.component(IsA).meta.onDeleteTarget).toBe(CleanupPolicy.Delete);
    expect(onInstantiate.has(Exclusive)).toBe(true);
    expect(onInstantiate.hasTarget(OneOf, onInstantiate)).toBe(true);
    expect(world.component(Override).parent).toBe(onInstantiate);
    expect(world.component(Inherit).parent).toBe(onInstantiate);
    expect(world.component(DontInherit).parent).toBe(onInstantiate);
  });

  it("applies default Override, explicit Override, Inherit, DontInherit, and child wins", () => {
    const world = new World();
    world.component(Position);
    world.component(Shared).add(OnInstantiate, Inherit);
    world.component(Skipped).add(OnInstantiate, DontInherit);
    world.component(Other).add(OnInstantiate, Override);
    const nested = { value: 7 };
    const template = world
      .entity()
      .set(Position, { x: 1, nested })
      .set(Shared, { value: 2 })
      .add(Skipped)
      .add(Other);
    const child = world.entity().set(Position, { x: 9 }).add(IsA, template);

    expect(child.get(Position)?.x).toBe(9);
    expect(child.get(Shared)).toBe(template.get(Shared));
    expect(child.has(Skipped)).toBe(false);
    expect(child.get(Other)).not.toBe(template.get(Other));

    const copied = world.entity().add(IsA, template);
    expect(copied.get(Position)).not.toBe(template.get(Position));
    expect(copied.get(Position)).toEqual(template.get(Position));
    expect(copied.get(Position)?.nested).toBe(nested);
  });

  it("instantiates transitively for top-down and leaf-first hierarchy construction", () => {
    for (const leafFirst of [false, true]) {
      const world = new World();
      world.component(Position);
      world.component(Shared).add(OnInstantiate, Inherit);
      const root = world.entity().set(Position, { x: 3 }).set(Shared, { value: 4 });
      const middle = world.entity();
      const leaf = world.entity();

      if (leafFirst) {
        leaf.add(IsA, middle);
        middle.add(IsA, root);
      } else {
        middle.add(IsA, root);
        leaf.add(IsA, middle);
      }

      expect(middle.get(Position)?.x).toBe(3);
      expect(leaf.get(Position)?.x).toBe(3);
      expect(leaf.get(Position)).not.toBe(middle.get(Position));
      expect(leaf.get(Shared)).toBe(root.get(Shared));
    }
  });

  it("propagates late Inherit additions but leaves Override additions snapshot-only", () => {
    const world = new World();
    world.component(Position);
    world.component(Shared).add(OnInstantiate, Inherit);
    const root = world.entity();
    const child = world.entity().add(IsA, root);
    const leaf = world.entity().add(IsA, child);

    root.set(Shared, { value: 8 });
    root.set(Position, { x: 2 });

    expect(child.get(Shared)).toBe(root.get(Shared));
    expect(leaf.get(Shared)).toBe(root.get(Shared));
    expect(child.has(Position)).toBe(false);
    expect(leaf.has(Position)).toBe(false);
  });

  it("propagates the pointer produced by reentrant child copy-on-write", () => {
    const world = new World();
    world.component(Shared).add(OnInstantiate, Inherit);
    const root = world.entity();
    const child = world.entity().add(IsA, root);
    const leaf = world.entity().add(IsA, child);
    world
      .query("reentrant shared entry")
      .with(Shared)
      .enter((entity) => {
        if (entity === child) {
          entity.set(Shared, { value: 2 });
        }
      })
      .build();

    root.set(Shared, { value: 1 });

    expect(child.get(Shared)).not.toBe(root.get(Shared));
    expect(child.get(Shared)?.value).toBe(2);
    expect(leaf.get(Shared)).toBe(child.get(Shared));
  });

  it("prunes late propagation below an existing child value", () => {
    const world = new World();
    world.component(Shared).add(OnInstantiate, Inherit);
    const root = world.entity();
    const child = world.entity().set(Shared, { value: 2 }).add(IsA, root);
    const leaf = world.entity().add(IsA, child);

    root.set(Shared, { value: 1 });

    expect(child.get(Shared)?.value).toBe(2);
    expect(leaf.get(Shared)).toBe(child.get(Shared));
  });

  it("copy-on-write repoints only the changed branch and does not clone an owner repeatedly", () => {
    const world = new World();
    world.component(Shared).add(OnInstantiate, Inherit);
    const root = world.entity().set(Shared, { value: 1 });
    const child = world.entity().add(IsA, root);
    const sibling = world.entity().add(IsA, root);
    const leaf = world.entity().add(IsA, child);
    const original = root.get(Shared);

    child.set(Shared, { value: 2 });
    const childCopy = child.get(Shared);

    expect(childCopy).not.toBe(original);
    expect(leaf.get(Shared)).toBe(childCopy);
    expect(root.get(Shared)).toBe(original);
    expect(sibling.get(Shared)).toBe(original);

    child.set(Shared, { value: 3 });
    expect(child.get(Shared)).toBe(childCopy);
    expect(leaf.get(Shared)).toBe(childCopy);
  });

  it("notifies only the explicit setter while descendants observe the shared value", () => {
    const world = new World();
    const onSet = vi.fn();
    const updates: number[] = [];
    world
      .component(Shared)
      .add(OnInstantiate, Inherit)
      .on("set", (entity) => onSet(entity));
    const query = world
      .query("shared updates")
      .update(Shared, (entity) => updates.push(entity.eid))
      .build();
    const root = world.entity().set(Shared, { value: 1 });
    const child = world.entity().add(IsA, root);
    const leaf = world.entity().add(IsA, child);
    onSet.mockClear();
    updates.length = 0;

    child.set(Shared, { value: 5 });

    expect(onSet.mock.calls.map(([entity]) => entity.eid)).toEqual([child.eid]);
    expect(updates).toEqual([child.eid]);
    expect(leaf.get(Shared)?.value).toBe(5);
    void query;
  });

  it("silently enters structural queries without firing descendant add hooks", () => {
    const world = new World();
    const adds: number[] = [];
    const enters: number[] = [];
    world
      .component(Shared)
      .add(OnInstantiate, Inherit)
      .on("add", (entity) => adds.push(entity.eid));
    const query = world
      .query("shared")
      .with(Shared)
      .enter((entity) => enters.push(entity.eid))
      .build();
    const template = world.entity();
    const child = world.entity().add(IsA, template);

    template.set(Shared, { value: 1 });

    expect(adds).toEqual([template.eid]);
    expect(new Set(enters)).toEqual(new Set([template.eid, child.eid]));
    expect(query.has(child)).toBe(true);
  });

  it("stops multi-component instantiation when query entry destroys the child", () => {
    const world = new World();
    const first = world.component(First);
    const second = world.component(Second);
    const template = world.entity().add(First).add(Second);
    const child = world.entity();
    const query = world
      .query("destroy inherited child")
      .with(First)
      .enter((entity) => {
        if (entity === child) {
          entity.destroy();
        }
      })
      .build();

    child.add(IsA, template);

    expect(child.destroyed).toBe(true);
    expect(world.getEntity(child.eid)).toBeUndefined();
    expect(child.components.size).toBe(0);
    expect(child.componentBitmask.has(first.eid)).toBe(false);
    expect(child.componentBitmask.has(second.eid)).toBe(false);
    expect(first.meta.usageCount).toBe(1);
    expect(second.meta.usageCount).toBe(1);
    expect(query.has(child)).toBe(false);
  });

  it("keeps carrier counts, storage, and bitmasks consistent", () => {
    const world = new World();
    const component = world.component(Shared).add(OnInstantiate, Inherit);
    const root = world.entity().set(Shared, { value: 1 });
    const child = world.entity().add(IsA, root);

    expect(component.meta.usageCount).toBe(2);
    expect(root.components.get(component.eid)).toBe(root.get(Shared));
    expect(child.components.get(component.eid)).toBe(root.get(Shared));
    expect(root.componentBitmask.has(component.eid)).toBe(true);
    expect(child.componentBitmask.has(component.eid)).toBe(true);

    child.set(Shared, { value: 2 });
    expect(component.meta.usageCount).toBe(2);
  });

  it("materializes Override interface aliases once without copying alias scan entries", () => {
    const world = new World();
    world.component(Alias);
    const shared = world.component(Shared).set(Implements, { interfaces: [Alias] });
    const template = world.entity().set(Shared, { value: 3 });
    const child = world.entity();
    let aliasWasReadyOnEntry = false;
    world
      .query("alias staging")
      .with(Shared)
      .enter((entity) => {
        if (entity === child) {
          aliasWasReadyOnEntry = entity.get(Alias) === entity.get(Shared);
        }
      })
      .build();

    child.add(IsA, template);

    expect(aliasWasReadyOnEntry).toBe(true);
    expect(child.get(Shared)).not.toBe(template.get(Shared));
    expect(child.get(Alias)).toBe(child.get(Shared));
    expect(shared.meta.usageCount).toBe(2);
    expect(world.component(Alias).meta.usageCount).toBe(2);
  });

  it("enforces immutable acyclic IsA edges and cascades target destruction", () => {
    const world = new World();
    const root = world.entity();
    const child = world.entity().add(IsA, root);
    const leaf = world.entity().add(IsA, child);
    const other = world.entity();

    expect(() => child.add(IsA, root)).not.toThrow();
    expect(() => child.remove(IsA)).toThrow("cannot be removed or retargeted");
    expect(() => child.add(IsA, other)).toThrow("cannot be removed or retargeted");
    expect(() => root.add(IsA, leaf)).toThrow("cycle");

    root.destroy();
    expect(child.destroyed).toBe(true);
    expect(leaf.destroyed).toBe(true);
  });

  it("supports clearAllEntities with live inheritance trees", () => {
    const world = new World();
    const shared = world.component(Shared).add(OnInstantiate, Inherit);
    const root = world.entity().set(Shared, { value: 1 });
    world.entity().add(IsA, root);

    expect(shared.has(Inherit)).toBe(true);
    expect(world.component(Inherit).meta.usageCount).toBe(1);

    expect(() => world.clearAllEntities()).not.toThrow();
    expect(world.entities.size).toBe(0);
  });

  it("keeps referenced policy marker entities alive and policies intact", () => {
    const world = new World();
    const configurations = [
      [world.component(Position).add(OnInstantiate, Override), Override],
      [world.component(Shared).add(OnInstantiate, Inherit), Inherit],
      [world.component(Skipped).add(OnInstantiate, DontInherit), DontInherit],
    ] as [Entity, ComponentClass][];

    for (const [component, Marker] of configurations) {
      const marker = world.component(Marker);
      const instance = component.get(Marker);
      expect(instance).toBeDefined();

      expect(() => component.remove(Marker)).toThrow("policy marker cannot be removed or replaced");
      expect(component.get(Marker)).toBe(instance);
      expect(component.target(OnInstantiate)).toBe(marker);

      expect(() => component.attach(Marker, new Marker())).toThrow(
        "policy marker cannot be removed or replaced"
      );
      expect(component.get(Marker)).toBe(instance);
      expect(component.target(OnInstantiate)).toBe(marker);

      expect(() => component.attach(Marker, instance!)).not.toThrow();
      expect(component.get(Marker)).toBe(instance);
      expect(component.target(OnInstantiate)).toBe(marker);

      expect(() => marker.destroy()).toThrow("still in use");
      expect(marker.alive).toBe(true);
      expect(world.getEntity(marker.meta.Class)).toBe(marker);
      expect(component.target(OnInstantiate)).toBe(marker);
      expect(component.get(Marker)).toBe(instance);
    }

    expect(() => world.clearAllEntities()).not.toThrow();
    expect(world.entities.size).toBe(0);
  });

  it("keeps policy marker deletion policy runtime-immutable", () => {
    const world = new World();

    for (const Marker of [Override, Inherit, DontInherit]) {
      const marker = world.component(Marker);
      expect(marker.meta.onDelete).toBe(CleanupPolicy.Throw);
      expect(() => {
        marker.meta.onDelete = CleanupPolicy.Remove;
      }).toThrow();
      expect(marker.meta.onDelete).toBe(CleanupPolicy.Throw);
      expect(() => {
        marker.meta.onDelete = CleanupPolicy.Delete;
      }).toThrow();
      expect(marker.meta.onDelete).toBe(CleanupPolicy.Throw);
    }

    expect(() => world.clearAllEntities()).not.toThrow();
    expect(world.entities.size).toBe(0);
  });

  it("installs shared policy before policy-marker query entry can create carriers", () => {
    const world = new World();
    const component = world.component(Shared);
    let carrier: Entity | undefined;
    world
      .query("inherit policy marker entry")
      .with(Inherit)
      .enter((entity) => {
        if (entity === component) {
          carrier = world.entity().add(Shared);
        }
      })
      .build();

    component.add(OnInstantiate, Inherit);

    expect(carrier?.has(Shared)).toBe(true);
    expect(() => carrier!.getMut(Shared, (shared) => shared.value++)).not.toThrow();
    expect(() => carrier!.modified(Shared)).not.toThrow();
    expect(carrier?.get(Shared)?.value).toBe(1);
  });

  it("rejects destroying an Inherit component after a late deletion-policy change", () => {
    for (const policy of [CleanupPolicy.Remove, CleanupPolicy.Delete]) {
      const world = new World();
      const component = world.component(Shared).add(OnInstantiate, Inherit);
      const carrier = world.entity().set(Shared, { value: 1 });
      component.meta.onDelete = policy;

      expect(() => component.destroy()).toThrow("non-default deletion policy");
      expect(component.alive).toBe(true);
      expect(world.getEntity(Shared)).toBe(component);
      expect(carrier.alive).toBe(true);
      expect(carrier.has(Shared)).toBe(true);
      expect(component.meta.usageCount).toBe(1);
    }
  });

  it("guards late deletion-policy changes in internal destruction cascades", () => {
    const world = new World();
    const component = world.component(Shared).add(OnInstantiate, Inherit);
    const parent = world.entity();
    component.childOf(parent);
    component.meta.onDelete = CleanupPolicy.Delete;

    expect(() => parent.destroy()).toThrow("non-default deletion policy");
    expect(component.alive).toBe(true);
    expect(world.getEntity(Shared)).toBe(component);
  });

  it("rejects fake OnInstantiate policy children by exact identity", () => {
    const world = new World();
    const fake = world.component(FakePolicy).childOf(world.component(OnInstantiate));
    const component = world.component(Shared);

    expect(() => component.add(OnInstantiate, fake)).toThrow(
      "policy must be Override, Inherit, or DontInherit"
    );
    expect(component.has(OnInstantiate)).toBe(false);
    expect(component.has(fake)).toBe(false);
  });

  it("rejects non-extensible Inherit instances before structural mutation", () => {
    const world = new World();
    const component = world.component(FrozenShared).add(OnInstantiate, Inherit);
    const query = world.query("frozen shared").with(FrozenShared).build();
    const entity = world.entity();

    expect(() => entity.add(FrozenShared)).toThrow("instances must be extensible");
    expect(entity.has(FrozenShared)).toBe(false);
    expect(entity.componentBitmask.has(component.eid)).toBe(false);
    expect(component.meta.usageCount).toBe(0);
    expect(query.count).toBe(0);

    expect(() => entity.ensure(FrozenShared, () => undefined)).toThrow(
      "instances must be extensible"
    );
    expect(entity.has(FrozenShared)).toBe(false);
    expect(component.meta.usageCount).toBe(0);
    expect(query.count).toBe(0);
  });

  it("skips With components during Override materialization", () => {
    const world = new World();
    const dependency = world.component(WithDependency).add(OnInstantiate, DontInherit);
    world.component(WithDependent).add(With, dependency);
    const template = world.entity().add(WithDependent);

    const child = world.entity().add(IsA, template);

    expect(template.has(WithDependent)).toBe(true);
    expect(template.has(WithDependency)).toBe(true);
    expect(child.has(WithDependent)).toBe(false);
    expect(child.has(WithDependency)).toBe(false);
  });

  it("restricts shared mutation APIs and permits owner mutation APIs", () => {
    const world = new World();
    world.component(Shared).add(OnInstantiate, Inherit);
    const root = world.entity().set(Shared, { value: 1 });
    const child = world.entity().add(IsA, root);

    expect(() => child.attach(Shared, new Shared())).toThrow("attach");
    expect(() => child.remove(Shared)).toThrow("remove");
    expect(() => world.entity().remove(Shared)).toThrow("remove");
    expect(() => child.modified(Shared)).toThrow("use set");
    expect(() => child.getMut(Shared, () => undefined)).toThrow("use set");
    expect(() => child.ensure(Shared, () => undefined)).toThrow("use set");
    expect(() => root.getMut(Shared, (value) => value.value++)).not.toThrow();
    expect(() => root.ensure(Shared, (value) => value.value++)).not.toThrow();
  });

  it("performs copy-on-write when a deferred set command applies", () => {
    const world = new World();
    world.component(Shared).add(OnInstantiate, Inherit);
    const root = world.entity().set(Shared, { value: 1 });
    const child = world.entity().add(IsA, root);

    world.beginDefer();
    child.set(Shared, { value: 4 });
    expect(child.get(Shared)).toBe(root.get(Shared));
    world.endDefer();

    expect(child.get(Shared)).not.toBe(root.get(Shared));
    expect(child.get(Shared)?.value).toBe(4);
    expect(root.get(Shared)?.value).toBe(1);
  });

  it("preserves deferred ensure origin after an earlier queued set", () => {
    const world = new World();
    world.component(Shared).add(OnInstantiate, Inherit);
    const entity = world.entity();

    world.beginDefer();
    entity.set(Shared, { value: 1 });
    const ensured = entity.ensure(Shared);
    ensured.value = 2;
    expect(() => world.endDefer()).not.toThrow();

    expect(entity.get(Shared)).toBe(ensured);
    expect(entity.get(Shared)?.value).toBe(2);
  });

  it("validates deferred public attach when the command applies", () => {
    const world = new World();
    const component = world.component(Shared);
    const entity = world.entity();

    world.beginDefer();
    component.add(OnInstantiate, Inherit);
    entity.attach(new Shared());

    expect(() => world.endDefer()).toThrow("attach is not supported for Inherit components");
    expect(entity.has(Shared)).toBe(false);
    expect(component.meta.usageCount).toBe(0);
  });

  it("rejects inherited mutation helpers in deferred mode", () => {
    const world = new World();
    world.component(Shared).add(OnInstantiate, Inherit);
    const root = world.entity().set(Shared, { value: 1 });
    const child = world.entity().add(IsA, root);

    world.beginDefer();
    expect(() => child.getMut(Shared)).toThrow("use set");
    expect(() => child.ensure(Shared)).toThrow("use set");
    expect(() => child.modified(Shared)).toThrow("use set");
    world.endDefer();
  });

  it("fires shared remove hooks only for the owner during teardown", () => {
    const world = new World();
    const removed: number[] = [];
    world
      .component(Shared)
      .add(OnInstantiate, Inherit)
      .on("remove", (entity) => {
        removed.push(entity.eid);
      });
    const root = world.entity().set(Shared, { value: 1 });
    world.entity().add(IsA, root);

    root.destroy();

    expect(removed).toEqual([root.eid]);
  });

  it("rejects policy changes, late configuration, and important unsupported composition", () => {
    const changed = new World();
    const shared = changed.component(Shared).add(OnInstantiate, Inherit);
    expect(() => shared.remove(OnInstantiate)).toThrow("cannot be changed or removed");

    const retargeted = new World();
    const configured = retargeted.component(Shared).add(OnInstantiate, Inherit);
    expect(() => configured.add(OnInstantiate, Override)).toThrow("cannot be changed or removed");

    const overrideRetargeted = new World();
    const overrideConfigured = overrideRetargeted.component(Shared).add(OnInstantiate, Override);
    const overrideInstance = overrideConfigured.get(Override);
    expect(() => overrideConfigured.add(OnInstantiate, Inherit)).toThrow(
      "cannot be changed or removed"
    );
    expect(overrideConfigured.target(OnInstantiate)).toBe(overrideRetargeted.component(Override));
    expect(overrideConfigured.get(Override)).toBe(overrideInstance);
    expect(overrideConfigured.has(Inherit)).toBe(false);
    expect(overrideConfigured.meta._inheritShared).toBe(false);

    const late = new World();
    late.component(Shared);
    late.entity().add(Shared);
    expect(() => late.component(Shared).add(OnInstantiate, Inherit)).toThrow(
      "before the component"
    );

    const relationship = new World();
    expect(() => relationship.component(Rel).add(OnInstantiate, Inherit)).toThrow("Relationship");

    const singleton = new World();
    expect(() => singleton.component(Shared).add(Singleton).add(OnInstantiate, Inherit)).toThrow(
      "Singleton"
    );

    const aliases = new World();
    aliases.component(Alias);
    expect(() =>
      aliases
        .component(Shared)
        .set(Implements, { interfaces: [Alias] })
        .add(OnInstantiate, Inherit)
    ).toThrow("Implements");

    const reverseAliases = new World();
    reverseAliases.component(Alias).add(OnInstantiate, Inherit);
    expect(() => reverseAliases.component(Shared).set(Implements, { interfaces: [Alias] })).toThrow(
      "cannot be an interface"
    );

    const withWorld = new World();
    expect(() =>
      withWorld.component(Shared).add(With, withWorld.component(Other)).add(OnInstantiate, Inherit)
    ).toThrow("With");

    const exclusive = new World();
    exclusive.component(Shared);
    exclusive.component(Other);
    exclusive.setExclusiveComponents(Shared, Other);
    expect(() => exclusive.component(Shared).add(OnInstantiate, Inherit)).toThrow("exclusive");

    const deletion = new World();
    deletion.component(Shared).meta.onDelete = CleanupPolicy.Remove;
    expect(() => deletion.component(Shared).add(OnInstantiate, Inherit)).toThrow(
      "default component deletion policy"
    );
  });
});
