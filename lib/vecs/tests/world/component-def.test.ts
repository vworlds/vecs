import { describe, expect, it } from "vitest";
import { ComponentDef, Module, Query, System, World } from "../../src/index.js";

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
    // Independent of the tag: definitions are what the class registry holds.
    const expected = [...world._classRegistry.values()];
    expect(world.entities.values().filter((entity) => entity.isComponent)).toEqual(
      expect.arrayContaining(expected)
    );
    expect(world.entities.values().filter((entity) => entity.isComponent)).toHaveLength(
      expected.length
    );

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
    const feature = world.module(Feature).entity;
    const late = world.component(LateComponent);

    expect(new Set(definitions)).toEqual(new Set([...initial, position, feature, late]));
    expect(world.component(Position)).toBe(position);
    expect(new Set(definitions)).toEqual(new Set([...initial, position, feature, late]));
    position.destroy();
    expect(new Set(definitions)).toEqual(new Set([...initial, feature, late]));
    world.dispose();
    expect(world.entities.size).toBe(0);
  });

  it("tags a component registered inside a system after deferred commands flush", () => {
    class DeferredComponent {
      value = 0;
    }
    const world = new World();
    const entity = world.entity();
    const definitions = world.query("Definitions").with(ComponentDef).build();
    world.system("LazyRegistration").run(() => {
      expect(world.deferred).toBe(true);
      world.component(DeferredComponent);
      entity.set(DeferredComponent, { value: 42 });
    });
    const initial = new Set(definitions);

    expect(() => world.progress(0, 16)).not.toThrow();

    const definition = world.getEntity(DeferredComponent)!;
    expect(definition.has(ComponentDef)).toBe(true);
    expect(new Set(definitions)).toEqual(new Set([...initial, definition]));
    expect(entity.get(DeferredComponent)).toEqual({ value: 42 });
    expect([...definitions]).not.toContain(entity);
    expect(() => world.progress(16, 16)).not.toThrow();
    expect(new Set(definitions)).toEqual(new Set([...initial, definition]));
  });

  it("does not transfer the marker in a snapshot round trip", () => {
    const source = new World();
    const destination = new World();
    source.component(Position);
    destination.component(Position);
    // Definitions cannot be snapshot roots, and the tag is what identifies
    // one. Exercise the marker's exclusion policy on a hand-tagged child of an
    // ordinary root instead, so the policy itself is covered.
    const root = source.entity();
    const carrier = source.entity().add(ComponentDef).set(Position, { x: 42 }).childOf(root);
    const snapshot = source.snapshotSubtree(root);

    const record = snapshot.entities.find((entity) => entity.source === carrier)!;
    expect(record.components.map((component) => component.Class)).toEqual([Position]);
    const restored = source.restoreSubtree(destination, snapshot).sourceToDestination.get(carrier)!;
    expect(restored.get(Position)).toEqual({ x: 42 });
    expect(restored.has(ComponentDef)).toBe(false);
    expect(destination.component(Position).has(ComponentDef)).toBe(true);
    expect([...destination.query("Definitions").with(ComponentDef).build()]).not.toContain(
      restored
    );
  });
});
