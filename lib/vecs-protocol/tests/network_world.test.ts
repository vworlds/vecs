import { describe, expect, it } from "vitest";
import { ComponentDef, Module, Trait } from "@vworlds/vecs";
import { cid_pack, NetworkWorld } from "../src/index.js";

class Position {}
class Velocity {}
class LocalOnly {}

function makeModule(index: number) {
  class TestModule extends Module {
    public init(): void {}
  }
  Object.defineProperty(TestModule, "name", { value: `Module${index}` });
  return TestModule;
}

function fillModulePool(world: NetworkWorld): void {
  const pool = world.pools.find((candidate) => candidate.name === "module")!;
  const allocated = world.entities
    .values()
    .filter((entity) => entity.eid >= pool.min && entity.eid <= pool.max!).length;
  const capacity = pool.max! - pool.min + 1;
  for (let index = allocated; index < capacity; index++) {
    world.module(makeModule(index));
  }
}

describe("NetworkWorld", () => {
  it.each([ComponentDef, Trait])("rejects local schema metadata %s", (Class) => {
    expect(() => new NetworkWorld({ networkComponents: [Position, Class] })).toThrow(
      `${Class.name} is local schema metadata and cannot be networked`
    );
  });

  it("reserves the requested number of module ids and defaults to 100", () => {
    const expanded = new NetworkWorld({ moduleIdCount: 300 });
    fillModulePool(expanded);
    expect(expanded.pools.find((pool) => pool.name === "module")).toEqual({
      name: "module",
      min: 700,
      max: 999,
    });
    expect(() => expanded.module(makeModule(300))).toThrow("Id pool 'module' is exhausted");

    const defaults = new NetworkWorld();
    fillModulePool(defaults);
    expect(() => defaults.module(makeModule(100))).toThrow("Id pool 'module' is exhausted");
  });

  it.each([0, -1, 1.5])("rejects invalid moduleIdCount %s", (moduleIdCount) => {
    expect(() => new NetworkWorld({ moduleIdCount })).toThrow(
      "moduleIdCount must be a positive safe integer"
    );
  });

  it("rejects an id layout with no room for component ids", () => {
    expect(() => new NetworkWorld({ entityIdStart: 300, moduleIdCount: 300 })).toThrow(
      "entityIdStart and moduleIdCount leave no room for component ids"
    );
  });

  it("registers network components with wire type ids and auto-allocated eids", () => {
    const world = new NetworkWorld({ networkComponents: [Position] });

    expect(world.localComponentMin).toBe(2);
    expect(world.entity(Position).eid).toBeGreaterThanOrEqual(1);
    expect(world.networkComponents).toEqual([
      { Class: Position, wireType: 1, eid: world.entity(Position).eid },
    ]);
    expect(cid_pack(42, 1)).toBeGreaterThan(0);
  });

  it("uses local component and local entity pools after the network ranges", () => {
    const world = new NetworkWorld({
      networkComponents: [Position],
      entityIdStart: 1000,
      localEntityIdStart: 100_000,
    });
    const nextLocalComponentEid = world.peekNextEid("component");
    const nextLocalEntityEid = world.peekNextEid("entity");

    expect(nextLocalComponentEid).toBeGreaterThanOrEqual(1);
    expect(world.component(LocalOnly).eid).toBe(nextLocalComponentEid);
    expect(world.pools).toContainEqual({ name: "module", min: 900, max: 999 });
    expect(world.getOrCreateEntity(1000).eid).toBe(1000);
    expect(world.entity().eid).toBe(nextLocalEntityEid);
  });

  describe("networkEntityReuseWaitFrames", () => {
    const waitOf = (world: NetworkWorld, pool: string): number | undefined =>
      world.pools.find((candidate) => candidate.name === pool)?.reuseWaitFrames;

    it("configures the entity pool when the id space is not split, which is where a server allocates", () => {
      const world = new NetworkWorld({
        networkComponents: [Position],
        networkEntityReuseWaitFrames: 3,
      });

      expect(world.pools.map((pool) => pool.name)).toEqual(["component", "module", "entity"]);
      expect(waitOf(world, "entity")).toBe(3);

      const first = world.entity();
      first.destroy();
      for (let frame = 0; frame < 2; frame++) {
        world.progress(frame, 1);
        expect(world.peekNextEid("entity")).not.toBe(first.eid);
      }
      world.progress(2, 1);
      expect(world.peekNextEid("entity")).toBe(first.eid);
    });

    it("lets an unsplit world free ids at once with 0", () => {
      const world = new NetworkWorld({
        networkComponents: [Position],
        networkEntityReuseWaitFrames: 0,
      });

      const first = world.entity();
      first.destroy();

      expect(world.entity().eid).toBe(first.eid);
    });

    it("configures the network_entity range and leaves the local entity pool alone when the id space is split, as a client's is", () => {
      const world = new NetworkWorld({
        networkComponents: [Position],
        entityIdStart: 1000,
        localEntityIdStart: 100_000,
        networkEntityReuseWaitFrames: 0,
      });

      expect(waitOf(world, "network_entity")).toBe(0);
      expect(waitOf(world, "entity")).toBeUndefined();
    });

    it("keeps the default wait where it is not given", () => {
      const unsplit = new NetworkWorld({ networkComponents: [Position] });
      const split = new NetworkWorld({
        networkComponents: [Position],
        localEntityIdStart: 100_000,
      });

      expect(waitOf(unsplit, "entity")).toBeUndefined();
      expect(waitOf(split, "network_entity")).toBeUndefined();
      expect(waitOf(split, "entity")).toBeUndefined();
    });
  });

  it("requires every NetworkWorld to use the same local component minimum", () => {
    expect(() => new NetworkWorld({ networkComponents: [Position] })).not.toThrow();
    expect(() => new NetworkWorld({ networkComponents: [Position, Velocity] })).toThrow(
      /does not match existing value/
    );
  });
});
