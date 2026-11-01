import { describe, expect, it, vi } from "vitest";
import {
  ChildOf,
  ClonePublic,
  ComponentDef,
  CustomSnapshot,
  DontSnapshot,
  type Entity,
  Exclusive,
  Identity,
  Implements,
  ImplementsModule,
  OnSnapshot,
  OneOf,
  OwnedTarget,
  Phase,
  Query,
  RelationshipsModule,
  Requires,
  Singleton,
  SingletonModule,
  SnapshotModule,
  System,
  Trait,
  Traversable,
  With,
  World,
} from "../../src/index.js";

class Audited {}
class Position {
  x = 0;
}

describe("Trait", () => {
  it("bootstraps root metadata with the same eid regardless of installed built-in modules", () => {
    const reference = new World().component(Trait);
    const install = World.prototype.module;
    for (const modules of [
      [],
      [ImplementsModule],
      [SingletonModule],
      [RelationshipsModule],
      [RelationshipsModule, SnapshotModule],
    ]) {
      // Omit constructor-installed modules to exercise core bootstrap independently
      // of their registrations. The constructor does not consume their return values.
      const selected = new Set<unknown>(modules);
      const mock = vi.spyOn(World.prototype, "module").mockImplementation(function (
        this: World,
        ...args
      ) {
        if (selected.has(args[0])) {
          return Reflect.apply(install, this, args);
        }
        return undefined!;
      });
      try {
        const world = new World();
        const trait = world.getEntity(Trait)!;
        // The parent accessor needs the relationship registered even in a world
        // whose RelationshipsModule was deliberately omitted.
        world.component(ChildOf);
        expect(trait.eid).toBe(reference.eid);
        expect(trait.parent).toBeUndefined();
        expect(trait.has(ComponentDef)).toBe(true);
        expect(trait.has(Trait)).toBe(false);
      } finally {
        mock.mockRestore();
      }
    }
    expect(reference.parent).toBeUndefined();
  });

  it("marks exactly the nine built-in policy definitions in a fresh world", () => {
    const world = new World();
    const expected = new Set<Entity>(
      [
        Exclusive,
        Traversable,
        OwnedTarget,
        With,
        Requires,
        OneOf,
        Singleton,
        Implements,
        OnSnapshot,
      ].map((Class) => world.component(Class))
    );
    const definitions = world.query("Definitions").with(ComponentDef).build();
    for (const definition of definitions) {
      expect(definition.has(Trait), definition.meta.Class.name).toBe(expected.has(definition));
    }
    expect(new Set(world.query("Traits").with(ComponentDef, Trait).build())).toEqual(expected);
    for (const Class of [
      ComponentDef,
      Trait,
      Identity,
      ChildOf,
      ClonePublic,
      DontSnapshot,
      CustomSnapshot,
      Phase,
      Query,
      System,
    ]) {
      expect(world.component(Class).has(Trait), Class.name).toBe(false);
    }
  });

  it("tracks later custom declarations, removal and destruction without including carriers", () => {
    const world = new World();
    const traits = world.query("Traits").with(ComponentDef, Trait).build();
    const initial = new Set(traits);
    const audited = world.component(Audited);
    const position = world.component(Position);
    // Unmarked configuration and world-global data remain valid.
    position.add(Audited);
    world.set(Position, { x: 42 });
    expect(position.has(Audited)).toBe(true);
    expect(world.get(Position)).toEqual({ x: 42 });
    expect(new Set(traits)).toEqual(initial);

    audited.add(Trait);
    const carrier = world.entity().add(Audited).add(Trait);
    expect(new Set(traits)).toEqual(new Set([...initial, audited]));
    expect([...traits]).not.toContain(carrier);
    audited.remove(Trait);
    expect(new Set(traits)).toEqual(initial);
    audited.add(Trait);
    position.remove(Audited);
    carrier.destroy();
    audited.destroy();
    expect(new Set(traits)).toEqual(initial);
    world.dispose();
    expect(world.entities.size).toBe(0);
  });

  it("excludes the marker from snapshots and keeps destination declarations local", () => {
    const source = new World();
    const destination = new World();
    source.component(Audited).add(Trait);
    destination.component(Audited);
    source.component(Position);
    destination.component(Position);
    // Definitions cannot be snapshot roots; exercise the policy on an ordinary carrier.
    const carrier = source.entity().add(Trait).add(Audited).set(Position, { x: 42 });
    const snapshot = source.snapshotSubtree(carrier);
    expect(snapshot.entities[0].components.map((component) => component.Class)).toEqual([
      Audited,
      Position,
    ]);
    const restored = source.restoreSubtree(destination, snapshot).roots[0];
    expect(restored.has(Trait)).toBe(false);
    expect(restored.has(Audited)).toBe(true);
    expect(restored.get(Position)).toEqual({ x: 42 });
    expect(destination.component(Audited).has(Trait)).toBe(false);
    expect(destination.component(OwnedTarget).has(Trait)).toBe(true);
    destination.component(Audited).add(Trait);
    expect([...destination.query("Traits").with(ComponentDef, Trait).build()]).toContain(
      destination.component(Audited)
    );
  });
});
