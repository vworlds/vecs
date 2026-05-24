import { describe, expect, it } from "vitest";
import { Singleton, SingletonModule, World } from "../../src/index.js";

class Gravity {
  y = -9.8;
}

class Position {
  x = 0;
}

describe("SingletonModule", () => {
  it("loads automatically", () => {
    const world = new World();

    expect(world.module(SingletonModule)).toBe(
      world.entity(world.getComponentMeta(SingletonModule).eid)
    );
    expect(world.getComponentMeta(Singleton).Class).toBe(Singleton);
  });

  it("creates the singleton instance on the component entity", () => {
    const world = new World();
    const gravityComponent = world.component(Gravity);

    gravityComponent.add(Singleton);

    expect(gravityComponent.get(Singleton)).toBeInstanceOf(Singleton);
    expect(gravityComponent.get(Gravity)).toBeInstanceOf(Gravity);
    expect(world.component(Gravity).get(Gravity)).toBe(gravityComponent.get(Gravity));
    expect(world.getComponentMeta(Gravity).usageCount).toBe(1);
  });

  it("throws when adding a second instance", () => {
    const world = new World();
    const gravityComponent = world.component(Gravity);
    const entity = world.entity();

    gravityComponent.add(Singleton);

    expect(() => entity.add(Gravity)).toThrow(/singleton component Gravity/);
  });

  it("is idempotent when the Singleton trait is added repeatedly", () => {
    const world = new World();
    const gravityComponent = world.component(Gravity);

    gravityComponent.add(Singleton);
    const gravity = gravityComponent.get(Gravity);

    expect(() => gravityComponent.add(Singleton)).not.toThrow();
    expect(gravityComponent.get(Gravity)).toBe(gravity);
    expect(world.getComponentMeta(Gravity).usageCount).toBe(1);
  });

  it("rejects making a component singleton after another entity already has it", () => {
    const world = new World();
    const gravityComponent = world.component(Gravity);
    const entity = world.entity().add(Gravity);

    expect(() => gravityComponent.add(Singleton)).toThrow(/1 instance\(s\) already exist/);
    expect(entity.get(Gravity)).toBeInstanceOf(Gravity);
  });

  it("does not affect non-singleton components", () => {
    const world = new World();
    world.component(Position);
    const first = world.entity();
    const second = world.entity();

    first.add(Position);
    second.add(Position);

    expect(first.get(Position)).toBeInstanceOf(Position);
    expect(second.get(Position)).toBeInstanceOf(Position);
    expect(world.getComponentMeta(Position).usageCount).toBe(2);
  });

  it("allows clearing a singleton component entity", () => {
    const world = new World();
    const gravityComponent = world.component(Gravity);
    gravityComponent.add(Singleton);

    world.clearAllEntities();

    expect(world.entity(gravityComponent.eid)).toBeUndefined();
  });
});
