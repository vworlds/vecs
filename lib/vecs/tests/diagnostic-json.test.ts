import { stringify } from "@vitest/utils/display";
import { describe, expect, it } from "vitest";
import { World } from "../src/index.js";
import { vecsEqualityTester } from "../src/testing.js";

expect.addEqualityTesters([vecsEqualityTester]);

class Handle {}

describe("diagnostic JSON", () => {
  it("summarizes live, unnamed, changed and destroyed entities", () => {
    const world = new World();
    world.component(Handle);
    const entity = world.entity();
    expect(entity.toJSON()).toEqual({ entity: entity.eid, name: undefined, components: [] });
    entity.add(Handle);
    entity.name = "player";
    expect(entity.toJSON()).toEqual({
      entity: entity.eid,
      name: "player",
      components: ["Handle", "Identity"],
    });
    expect(JSON.parse(JSON.stringify(entity))).toEqual(entity.toJSON());
    entity.remove(Handle);
    expect(entity.toJSON().components).toEqual(["Identity"]);
    entity.destroy();
    expect(entity.toJSON()).toEqual({ entity: entity.eid, name: undefined, destroyed: true });
    expect(JSON.parse(JSON.stringify(entity))).toEqual({ entity: entity.eid, destroyed: true });
  });

  it("summarizes worlds using class names and the live count, including infrastructure", () => {
    class Scene extends World {}
    for (const world of [new World(), new Scene()]) {
      const count = world.entities.size;
      expect(world.toJSON()).toEqual({ world: world.constructor.name, entities: count });
      const entity = world.entity();
      expect(world.toJSON().entities).toBe(count + 1);
      entity.destroy();
      expect(world.toJSON().entities).toBe(count);
      world.dispose();
      expect(JSON.parse(JSON.stringify(world))).toEqual({
        world: world.constructor.name,
        entities: 0,
      });
    }
  });

  it("formats failed assertions and snapshots without reading component data", () => {
    const world = new World();
    world.component(Handle);
    const entity = world.getOrCreateEntity(2000).add(Handle);
    entity.name = "player";
    let reads = 0;
    Object.defineProperty(entity.get(Handle)!, "engineHandle", {
      enumerable: true,
      get: () => {
        reads++;
        throw new Error("engine handle must not be read");
      },
    });
    let failure: unknown;
    try {
      expect(entity).toBe(world.entity());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    // Vitest's reporter pretty-formats the assertion payload, not Chai's
    // abbreviated message (which uses a different inspector).
    const received = stringify((failure as { actual: unknown }).actual);
    expect(received).toContain('"entity"');
    expect(received).toContain('"Handle"');
    expect(stringify(entity)).toContain('"player"');
    expect(stringify(world)).toContain('"world": "World"');
    expect(entity).toMatchInlineSnapshot(`
      {
        "components": [
          "Handle",
          "Identity",
        ],
        "entity": 2000,
        "name": "player",
      }
    `);
    expect(reads).toBe(0);
  });
});
