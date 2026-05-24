import { describe, expect, it } from "vitest";
import { Identity, IdentityModule, Module, World } from "../src/index.js";

class Position {
  x = 0;
}

describe("World.module", () => {
  it("loads the built-in IdentityModule automatically", () => {
    const world = new World();
    const entity = world.entity().set(Identity, { name: "player" });

    expect(world.module(IdentityModule)).toBe(
      world.entity(world.getComponentMeta(IdentityModule).eid)
    );
    expect(entity.get(Identity)?.name).toBe("player");
  });

  it("creates a typed module entity and registers metadata for the module class", () => {
    class TestModule extends Module {
      public initCalls = 0;

      public init(): void {
        this.initCalls++;
      }
    }

    const world = new World();
    const mod = world.module(TestModule);

    expect(mod).toBeInstanceOf(TestModule);
    expect(mod.world).toBe(world);
    expect(mod.eid).toBe(3);
    expect(world.entity(mod.eid)).toBe(mod);
    expect(world.getComponentMeta(TestModule).eid).toBe(mod.eid);
    expect(mod.initCalls).toBe(1);
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
          .requires(Position)
          .enter((entity) => {
            this.entered.push(entity.eid);
          });
      }
    }

    const world = new World();
    const mod = world.module(GameplayModule);
    world.start();

    const entity = world.entity().add(Position);
    world.progress(0, 0);

    expect(mod.entered).toEqual([entity.eid]);
  });

  it("cannot register modules after component registration is disabled", () => {
    class TestModule extends Module {
      public init(): void {}
    }

    const world = new World();
    world.start();

    expect(() => world.module(TestModule)).toThrow("World component registration is disabled");
  });
});
