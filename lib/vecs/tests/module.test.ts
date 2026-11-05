import { describe, expect, it } from "vitest";
import {
  ComponentDef,
  Entity,
  IdentityModule,
  ModuleDef,
  Module,
  OnSnapshot,
  Singleton,
  SingletonModule,
  World,
} from "../src/index.js";

class Position {
  x = 0;
}

describe("World.module", () => {
  it("checks singleton presence without registering unknown classes", () => {
    const world = new World();
    expect(world.has(Position)).toBe(false);
    expect(world.getEntity(Position)).toBeUndefined();
    world.component(Position);
    expect(world.has(Position)).toBe(false);
    world.set(Position, { x: 3 });
    expect(world.has(Position)).toBe(true);
    world.component(Position).remove(Position);
    expect(world.has(Position)).toBe(false);
  });

  it("stores the module itself as its singleton value before init", () => {
    class Feature extends Module {
      public init(): void {
        expect(this.world.get(Feature)).toBe(this);
        expect(this.world.has(Feature)).toBe(true);
      }
    }
    const world = new World();
    const feature = world.module(Feature);
    expect(feature.entity).toBe(world.component(Feature));
    expect(feature.entity.has(Singleton)).toBe(true);
    expect(feature.entity.get(Feature)).toBe(feature);
    expect(world.get(Feature)).toBe(feature);
    expect(world.module(Feature)).toBe(feature);
    expect(() => world.entity().attach(feature)).toThrow(/singleton/);
    for (const Class of [IdentityModule, SingletonModule]) {
      expect(world.get(Class)).toBe(world.module(Class));
      expect(world.module(Class).entity.has(Singleton)).toBe(true);
    }
  });

  it("excludes module instances from snapshots and leaves destination modules intact", () => {
    class Feature extends Module {
      public init(): void {}
    }
    const source = new World();
    source.component(Position);
    const root = source.entity();
    const feature = source.module(Feature).entity.childOf(root);
    const child = source.entity().set(Position, { x: 7 }).childOf(feature);
    const snapshot = source.snapshotSubtree(root);
    expect(snapshot.entities.flatMap((record) => record.components.map((c) => c.Class))).toEqual([
      Singleton,
      Position,
    ]);
    expect(feature.has(OnSnapshot)).toBe(false);
    expect(() => source.snapshotSubtree(root, { components: [Feature] })).toThrow(/DontSnapshot/);
    const destination = new World();
    destination.component(Position);
    const installed = destination.module(Feature);
    const restored = source.restoreSubtree(destination, snapshot);
    expect(destination.get(Feature)).toBe(installed);
    expect(restored.entities.get(feature.eid)?.has(Feature)).toBe(false);
    expect(restored.entities.get(child.eid)?.get(Position)?.x).toBe(7);
  });

  it("creates a plain module object on a definition entity registered for its class", () => {
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
    expect(mod).not.toBeInstanceOf(Entity);
    expect(mod.world).toBe(world);
    expect(mod.entity).toBeInstanceOf(Entity);
    expect(mod.entity.eid).toBe(nextModuleEid);
    expect(mod.entity.isComponent).toBe(true);
    expect(world.entity(mod.entity.eid)).toBe(mod.entity);
    expect(world.component(TestModule)).toBe(mod.entity);
    expect(mod.entity.meta.Class).toBe(TestModule);
    expect(mod.initCalls).toBe(1);
  });

  it("constructs the module with its world and entity before field initializers run", () => {
    class Position {}
    class Feature extends Module {
      public readonly definition = this.entity;
      public readonly positions = this.world.query("feature positions").with(Position).track();
      public initEntity: unknown;
      public init(): void {
        this.initEntity = this.entity;
        this.entity.on("remove", () => {});
      }
    }

    const world = new World();
    world.component(Position);
    const feature = world.module(Feature);

    expect(feature.definition).toBe(world.component(Feature));
    expect(feature.initEntity).toBe(feature.entity);
    expect(feature.positions.entity.parent).toBeUndefined();
  });

  it("tags installed module definitions, core modules included, with ModuleDef", () => {
    class Position {}
    class Feature extends Module {
      public init(): void {}
    }
    class Uninstalled extends Module {
      public init(): void {}
    }

    const world = new World();
    const feature = world.module(Feature);
    const modules = world.query("Modules").with(ModuleDef).build();

    expect(feature.entity.has(ModuleDef)).toBe(true);
    expect(feature.entity.has(ComponentDef)).toBe(true);
    for (const Class of [IdentityModule, SingletonModule]) {
      expect(world.module(Class).entity.has(ModuleDef)).toBe(true);
    }
    expect(world.component(Position).has(ModuleDef)).toBe(false);
    expect(world.component(Uninstalled).has(ModuleDef)).toBe(false);
    expect(world.component(ModuleDef).has(ModuleDef)).toBe(false);
    expect([...modules].map((entity) => entity.meta.Class)).toContain(Feature);
    expect([...modules].every((entity) => entity.get(entity) instanceof Module)).toBe(true);
  });

  it("refuses a module class registered only as a component", () => {
    class Feature extends Module {
      public init(): void {}
    }

    const world = new World();
    world.component(Feature);

    expect(() => world.module(Feature)).toThrow("Module Feature is registered but not installed");
  });

  it("accepts an explicit module eid", () => {
    class TestModule extends Module {
      public init(): void {}
    }

    const world = new World();
    const mod = world.module(TestModule, 950);

    expect(mod.entity.eid).toBe(950);
    expect(world.entity(950)).toBe(mod.entity);
  });

  it("passes typed config to init", () => {
    type TestConfig = { enabled: boolean; limit: number };

    class TestModule extends Module<TestConfig> {
      public config: TestConfig | undefined;

      public init(config: TestConfig): void {
        this.config = config;
      }
    }

    const config = { enabled: true, limit: 3 };
    const world = new World();
    const mod = world.module(TestModule, config);

    expect(mod.config).toBe(config);
  });

  it("accepts typed config with an explicit module eid", () => {
    type TestConfig = { label: string };

    class TestModule extends Module<TestConfig> {
      public label = "";

      public init(config: TestConfig): void {
        this.label = config.label;
      }
    }

    const world = new World();
    const mod = world.module(TestModule, { label: "network" }, 950);

    expect(mod.entity.eid).toBe(950);
    expect(mod.label).toBe("network");
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

  it("throws when config is supplied after a module is already registered", () => {
    class TestModule extends Module<{ enabled: boolean } | undefined> {
      public init(): void {}
    }

    const world = new World();
    world.module(TestModule, { enabled: false });

    expect(() => world.module(TestModule, { enabled: true })).toThrow(
      /configuration is only accepted on first registration/
    );
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
