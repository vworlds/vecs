import { describe, expect, it } from "vitest";
import {
  ChildOf,
  ClonePublic,
  ComponentDef,
  CustomSnapshot,
  DontSnapshot,
  Exclusive,
  Identity,
  Implements,
  OnSnapshot,
  OneOf,
  OwnedTarget,
  Phase,
  Query,
  Singleton,
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
  it("marks exactly the eight built-in policy definitions in a fresh world", () => {
    const world = new World();
    const expected = new Set(
      [Exclusive, Traversable, OwnedTarget, With, OneOf, Singleton, Implements, OnSnapshot].map(
        (Class) => world.component(Class)
      )
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
