import { describe, expect, it, vi } from "vitest";
import { type Entity, Module, Query, Singleton, World } from "../src/index.js";

describe("module remove hooks", () => {
  it("fires instance and static hooks once with the definition entity and the module value", () => {
    const removed = vi.fn();
    class Feature extends Module {
      public static vecs_remove(entity: Entity, mod: Feature): void {
        removed(entity, mod);
      }
      public init(): void {}
    }
    class NoHook extends Module {
      public init(): void {}
    }
    const world = new World();
    const feature = world.module(Feature);
    const instanceRemoved = vi.fn();
    feature.entity.on("remove", instanceRemoved);
    world.module(NoHook);
    world.dispose();
    world.dispose();
    expect(removed.mock.calls).toEqual([[feature.entity, feature]]);
    expect(instanceRemoved.mock.calls).toEqual([[feature.entity, feature]]);
    expect(world.has(Feature)).toBe(false);
    expect(world.entities.size).toBe(0);
  });

  it("removes nested and sibling values after application cleanup and before infrastructure", () => {
    const order: string[] = [];
    class Resource {}
    class Application {}
    class QueuedCleanup {}
    class First extends Module {
      public init(): void {
        this.entity.on("remove", () => order.push("first"));
      }
    }
    class Child extends Module {
      public init(): void {
        this.entity.on("remove", () => {
          expect(this.entity.parent).toBe(this.world.module(Parent).entity);
          expect(this.world.get(Parent)?.entity).toBe(this.entity.parent);
          expect(this.world.get(First)).toBe(this.world.module(First));
          expect(this.world.get(Resource)).toBe(resource);
          expect(this.world.getEntity(Query)?.destroyed).toBe(false);
          order.push("child");
        });
      }
    }
    class Parent extends Module {
      public init(): void {
        this.world.module(Child);
        this.entity.on("remove", () => order.push("parent"));
      }
    }
    class Last extends Module {
      public init(): void {
        this.entity.on("remove", () => order.push("last"));
      }
    }
    const world = new World();
    const resource = world.component(Resource).add(Singleton).get(Resource)!;
    world.component(Resource).on("remove", () => order.push("resource"));
    world.component(QueuedCleanup).on("remove", () => order.push("queued"));
    world.component(Application).on("remove", () => {
      order.push("application");
      world.defer(() => world.entity().add(QueuedCleanup));
    });
    world.module(First, 980);
    world.module(Parent, 970);
    world.module(Last, 960);
    world.entity().add(Application);
    world.dispose();
    expect(order).toEqual([
      "application",
      "queued",
      "last",
      "child",
      "parent",
      "first",
      "resource",
    ]);
  });

  it("propagates a module remove error without retrying teardown", () => {
    const error = new Error("cannot release module");
    const removed = vi.fn(() => {
      throw error;
    });
    class Feature extends Module {
      public init(): void {
        this.entity.on("remove", removed);
      }
    }
    const world = new World();
    world.module(Feature);
    expect(() => world.dispose()).toThrow(error);
    expect(() => world.dispose()).not.toThrow();
    expect(removed).toHaveBeenCalledTimes(1);
  });
});
