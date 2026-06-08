import { describe, expect, it } from "vitest";
import { Module, World } from "../src/index.js";

class Position {
  x = 0;
}

describe("World.module", () => {
  it("creates a typed module entity and registers metadata for the module class", () => {
    class TestModule extends Module {
      public initCalls = 0;

      public init(): void {
        this.initCalls++;
      }
    }

    const world = new World();
    const nextModuleEid = world.peekNextEid("module");
    const mod = world.module(TestModule);

    expect(mod).toBeInstanceOf(TestModule);
    expect(mod.world).toBe(world);
    expect(mod.eid).toBe(nextModuleEid);
    expect(world.entity(mod.eid)).toBe(mod);
    expect(mod.meta.eid).toBe(mod.eid);
    expect(mod.meta.Class).toBe(TestModule);
    expect(mod.initCalls).toBe(1);
  });

  it("accepts an explicit module eid", () => {
    class TestModule extends Module {
      public init(): void {}
    }

    const world = new World();
    const mod = world.module(TestModule, 950);

    expect(mod.eid).toBe(950);
    expect(world.entity(950)).toBe(mod);
  });

  it("is idempotent for the same module class and same eid", () => {
    class TestModule extends Module {
      public init(): void {}
    }

    const world = new World();
    const mod = world.module(TestModule, 950);

    expect(world.module(TestModule, 950)).toBe(mod);
  });

  it("throws for a taken module eid with a different class", () => {
    class FirstModule extends Module {
      public init(): void {}
    }
    class SecondModule extends Module {
      public init(): void {}
    }

    const world = new World();
    world.module(FirstModule, 950);

    expect(() => world.module(SecondModule, 950)).toThrow();
  });

  it("throws for the same module class at a different eid", () => {
    class TestModule extends Module {
      public init(): void {}
    }

    const world = new World();
    world.module(TestModule, 950);

    expect(() => world.module(TestModule, 951)).toThrow();
  });

  it("returns the same module and does not run init twice", () => {
    class TestModule extends Module {
      public initCalls = 0;

      public init(): void {
        this.initCalls++;
      }
    }

    const world = new World();
    const first = world.module(TestModule);
    const second = world.module(TestModule);

    expect(second).toBe(first);
    expect(first.initCalls).toBe(1);
  });

  it("allows init to register components and create systems", () => {
    class GameplayModule extends Module {
      public entered: number[] = [];

      public init(): void {
        this.world.component(Position);
        this.world
          .system("TrackPosition")
          .with(Position)
          .enter((entity) => {
            this.entered.push(entity.eid);
          });
      }
    }

    const world = new World();
    const mod = world.module(GameplayModule);

    const entity = world.entity().add(Position);
    world.progress(0, 0);

    expect(mod.entered).toEqual([entity.eid]);
  });

  it("can register modules anytime", () => {
    class TestModule extends Module {
      public init(): void {
        this.world.component(Position);
      }
    }

    const world = new World();

    const mod = world.module(TestModule);

    expect(mod).toBeInstanceOf(TestModule);
    expect(world.component(Position).meta.Class).toBe(Position);
  });
});
