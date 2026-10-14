import { describe, expect, it } from "vitest";
import { Implements, World } from "../src/index.js";

class Trigger {}
class Resource {}
class Alias {}

describe("synchronous top-level disposal hook safety", () => {
  it.each(["add", "set", "remove"] as const)("completes from a %s hook", (event) => {
    const world = new World();
    const removals: number[] = [];
    world.component(Resource).on("remove", (entity) => removals.push(entity.eid));
    const trigger = world.component(Trigger);
    const entity = world.entity().add(Resource);
    const other = world.entity().add(Resource);
    if (event !== "add") {
      entity.add(Trigger);
    }
    let calls = 0;
    let triggerRemovals = 0;
    trigger.on("remove", () => triggerRemovals++);
    trigger.on(event, () => {
      calls++;
      world.dispose();
      expect(world.entities.values()).toEqual([]);
    });

    expect(() => {
      if (event === "add") {
        entity.add(Trigger);
      } else if (event === "set") {
        entity.set(Trigger, {});
      } else {
        entity.remove(Trigger);
      }
    }).not.toThrow();

    expect(calls).toBe(1);
    expect(triggerRemovals).toBe(1);
    expect(removals.sort((a, b) => a - b)).toEqual([entity.eid, other.eid].sort((a, b) => a - b));
    expect([entity.destroyed, other.destroyed]).toEqual([true, true]);
    expect(world.entities.values()).toEqual([]);
  });

  it("does not resume alias attachment after an add hook disposes the world", () => {
    const world = new World();
    const concrete = world.component(Trigger);
    const alias = world.component(Alias);
    concrete.set(Implements, { interfaces: [Alias] });
    const events: string[] = [];
    concrete.on("remove", () => events.push("concrete remove"));
    alias.on("add", () => events.push("alias add"));
    alias.on("remove", () => events.push("alias remove"));
    concrete.on("add", () => world.dispose());
    const entity = world.entity();

    expect(() => entity.add(Trigger)).not.toThrow();
    expect(entity.destroyed).toBe(true);
    expect(world.entities.values()).toEqual([]);
    expect(entity.get(alias.eid)).toBeUndefined();
    expect(events).toEqual(["concrete remove"]);
  });
});
