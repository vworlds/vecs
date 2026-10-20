import { describe, expect, it } from "vitest";
import { Component, ComponentDef, Module, Query, System, World } from "../../src/index.js";

class Position {
  x = 0;
}
class LateComponent {}
class Feature extends Module {
  public init(): void {
    this.world.component(LateComponent);
  }
}

describe("ComponentDef", () => {
  it("matches exactly built-in and user definitions, including its own definition", () => {
    const world = new World();
    const position = world.component(Position);
    const ordinary = world.entity().add(Position);
    world.system("ordinary-system").with(Position);
    const definitions = world.query("Definitions").with(ComponentDef).build();
    const expected = world.entities.values().filter((entity) => entity instanceof Component);

    expect(new Set(definitions)).toEqual(new Set(expected));
    expect([...definitions]).toContain(world.component(ComponentDef));
    expect([...definitions]).toContain(world.component(Query));
    expect([...definitions]).toContain(world.component(System));
    expect([...definitions]).toContain(position);
    expect([...definitions]).not.toContain(ordinary);
    expect(world.component(ComponentDef).has(ComponentDef)).toBe(true);
  });

  it("tracks later registrations, module definitions, idempotent lookups and destruction", () => {
    const world = new World();
    const definitions = world.query("Definitions").with(ComponentDef).build();
    const initial = new Set(definitions);
    const position = world.component(Position);
    const feature = world.module(Feature);
    const late = world.component(LateComponent);

    expect(new Set(definitions)).toEqual(new Set([...initial, position, feature, late]));
    expect(world.component(Position)).toBe(position);
    expect(new Set(definitions)).toEqual(new Set([...initial, position, feature, late]));
    position.destroy();
    expect(new Set(definitions)).toEqual(new Set([...initial, feature, late]));
    world.dispose();
    expect(world.entities.size).toBe(0);
  });

  it("does not transfer the marker in a snapshot round trip", () => {
    const source = new World();
    const destination = new World();
    source.component(Position);
    destination.component(Position);
    // Definitions cannot be snapshot roots. Exercise the marker's exclusion
    // policy on an ordinary carrier instead, so the policy itself is covered.
    const carrier = source.entity().add(ComponentDef).set(Position, { x: 42 });
    const snapshot = source.snapshotSubtree(carrier);

    expect(snapshot.entities[0].components.map((component) => component.Class)).toEqual([Position]);
    const restored = source.restoreSubtree(destination, snapshot).roots[0];
    expect(restored.get(Position)).toEqual({ x: 42 });
    expect(restored.has(ComponentDef)).toBe(false);
    expect(destination.component(Position).has(ComponentDef)).toBe(true);
    expect([...destination.query("Definitions").with(ComponentDef).build()]).not.toContain(
      restored
    );
  });
});
