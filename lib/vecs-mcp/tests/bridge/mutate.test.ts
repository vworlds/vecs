import { describe, expect, it, vi } from "vitest";
import { World, Entity, Relationship, type, range } from "@vworlds/vecs";
import { field } from "../../src/schema/index.js";
import { LocalWorld } from "../../src/bridge/world.js";

describe("mutation boundaries", () => {
  it("revalidates the live merged draft after earlier mutation hooks change untouched state", () => {
    class Trigger {
      value = 0;
    }
    class Rules {
      limit = 10;
      value = 1;
      static vecs_validate(draft: Rules) {
        return draft.value > draft.limit ? "live limit exceeded" : true;
      }
    }
    const world = new World();
    world.component(Rules);
    const entity = world.entity().add(Rules);
    world.component(Trigger).on("set", () => entity.set(Rules, { limit: 0 }));
    const local = new LocalWorld(world);
    expect(
      local.command("vecs_mutate", {
        ops: [
          { set: true, entity: entity.eid, component: "Trigger", value: { value: 1 } },
          { set: true, entity: entity.eid, component: "Rules", value: { value: 2 } },
        ],
      })
    ).toEqual({
      applied: [{ eid: entity.eid }],
      error: { index: 1, message: "live limit exceeded" },
    });
    expect(entity.get(Rules)).toEqual({ limit: 0, value: 1 });
    world.dispose();
  });

  it("rejects core range and static-hook violations before applying any batch writes", () => {
    class Ranged {
      @type("u8") @range(0, 10) value = 1;
    }
    class Rules {
      limit = 10;
      value = 1;
      static vecs_validate(draft: Rules) {
        return draft.value > draft.limit ? "value exceeds current limit" : true;
      }
    }
    const world = new World();
    world.component(Ranged);
    world.component(Rules);
    const entity = world.entity().add(Ranged).add(Rules);
    const local = new LocalWorld(world);
    const violation = world.validate(Object.assign(new Ranged(), { value: 11 }));
    for (const [component, value, message] of [
      [
        "Ranged",
        { value: 11 },
        Array.isArray(violation) ? violation.join("\n") : String(violation),
      ],
      ["Rules", { limit: 0 }, "value exceeds current limit"],
    ] as const) {
      const count = world.entities.size;
      expect(() =>
        local.command("vecs_mutate", {
          ops: [{ create: true }, { set: true, entity: entity.eid, component, value }],
        })
      ).toThrow(`ops[1]: ${message}`);
      expect(world.entities.size).toBe(count);
    }
    expect(entity.get(Ranged)?.value).toBe(1);
    expect(entity.get(Rules)).toEqual({ limit: 10, value: 1 });
    world.dispose();
  });

  it("mirrors indexed name collisions, empty renames and reuse after destroy", () => {
    class Data {
      value = 1;
    }
    const world = new World();
    world.component(Data);
    const a = world.entity("same").add(Data);
    const b = world.entity().add(Data);
    b.name = "same";
    const local = new LocalWorld(world);
    expect(
      local.command("vecs_mutate", {
        ops: [
          { name: true, entity: a.eid, value: "other" },
          { set: true, entity: "same", component: "Data", value: { value: 5 } },
          { name: true, entity: "other", value: "" },
          { destroy: true, entity: "same" },
          { create: true, name: "same" },
          { add: true, entity: "same", component: "Data" },
        ],
      })
    ).toMatchObject({
      applied: [{ eid: a.eid }, { eid: b.eid }, { eid: a.eid }, { eid: b.eid }, {}, {}],
    });
    expect(a.name).toBe("");
    expect(world.getEntity("same")?.get(Data)).toEqual({ value: 1 });
    expect(world.getEntity("same")?.eid).not.toBe(b.eid);
    expect(() => local.command("vecs_mutate", { ops: [{ destroy: true, entity: "" }] })).toThrow(
      "Unknown entity"
    );
    world.dispose();
  });
  it("uses indexed names and own components, with batch rename tombstones and create aliases", () => {
    class Data {
      value = 1;
    }
    const world = new World();
    world.component(Data);
    for (let i = 0; i < 80; i++) {
      world.component(class Unused {});
      world.entity(`unused${i}`);
    }
    const a = world.entity("old").add(Data);
    const local = new LocalWorld(world);
    const registry = local.registry();
    const values = vi.spyOn(world.entities, "values");
    const definitions = vi.spyOn(registry, "values");
    expect(
      local.command("vecs_mutate", {
        ops: [
          { name: true, entity: "old", value: "new" },
          { set: true, entity: "new", component: "Data", value: { value: 2 } },
          { create: true, name: "created" },
          { name: true, entity: "$0", value: "renamed" },
          { add: true, entity: "renamed", component: "Data" },
        ],
      })
    ).toMatchObject({ applied: [{ eid: a.eid }, { eid: a.eid }, {}, {}, {}] });
    expect(a.get(Data)).toEqual({ value: 2 });
    expect(world.getEntity("renamed")?.get(Data)).toEqual({ value: 1 });
    expect(world.getEntity("created")).toBeUndefined();
    expect(values).not.toHaveBeenCalled();
    expect(definitions).not.toHaveBeenCalled();
    for (const ops of [
      [
        { name: true, entity: "new", value: "other" },
        { destroy: true, entity: "new" },
      ],
      [
        { destroy: true, entity: "new" },
        { add: true, entity: "new", component: "Data" },
      ],
      [
        { create: true, name: "temp" },
        { name: true, entity: "$0", value: "moved" },
        { destroy: true, entity: "temp" },
      ],
    ]) {
      expect(() => local.command("vecs_mutate", { ops })).toThrow();
    }
    expect(a.name).toBe("new");
    expect(a.destroyed).toBe(false);
    expect(world.getEntity("temp")).toBeUndefined();
    vi.restoreAllMocks();
    world.dispose();
  });
  it("accepts unrelated writes with invalid current structure but still enforces untouched validators", () => {
    class C {
      existing = 100;
      mixed = [1, "game state"];
      label = "old";
      rule = 0;
      static vecs_validate(draft: C) {
        return draft.label === "blocked" ? "whole-draft rule" : true;
      }
    }
    const world = new World();
    world.component(C);
    const entity = world.entity().add(C);
    const local = new LocalWorld(world);
    expect(
      local.command("vecs_mutate", {
        ops: [{ set: true, entity: entity.eid, component: "C", value: { label: "new" } }],
      })
    ).toEqual({ applied: [{ eid: entity.eid }] });
    expect(entity.get(C)?.label).toBe("new");
    expect(() =>
      local.command("vecs_mutate", {
        ops: [{ set: true, entity: entity.eid, component: "C", value: { label: "blocked" } }],
      })
    ).toThrow("whole-draft rule");
    expect(entity.get(C)?.label).toBe("new");
  });

  it("resolves entity-typed eids to Entity instances without walking them", () => {
    class Target {
      @type("entity") @field({ optional: true }) target: Entity | undefined = undefined;
      @type("f64") count = 1;
      static vecs_validate(draft: Target) {
        return draft.target === undefined || draft.target instanceof Entity
          ? true
          : "expected resolved entity";
      }
    }
    const world = new World();
    world.component(Target);
    const a = world.entity("a").add(Target);
    const b = world.entity("b");
    const local = new LocalWorld(world);
    const ops = [{ set: true, entity: a.eid, component: "Target", value: { target: b.eid } }];
    expect(local.command("vecs_mutate", { ops })).toEqual({ applied: [{ eid: a.eid }] });
    expect(a.get(Target)?.target).toBe(b);
    expect(
      local.command("vecs_mutate", {
        ops: [{ set: true, entity: a.eid, component: "Target", value: { count: 2 } }],
      })
    ).toEqual({ applied: [{ eid: a.eid }] });
    expect(() =>
      local.command("vecs_mutate", {
        ops: [
          { create: true },
          { set: true, entity: a.eid, component: "Target", value: { target: 999999 } },
        ],
      })
    ).toThrow("Unknown entity");
  });

  it("does not allow replacing a container to overwrite nested opaque resources", () => {
    class Handle {}
    class Data {
      nested = { handle: new Handle() };
      handles = [new Handle()];
    }
    const world = new World();
    world.component(Data);
    const a = world.entity().add(Data);
    const local = new LocalWorld(world);
    for (const value of [{ nested: {} }, { handles: [] }]) {
      expect(() =>
        local.command("vecs_mutate", {
          ops: [{ set: true, entity: a.eid, component: "Data", value }],
        })
      ).toThrow("opaque");
    }
    expect(a.get(Data)?.nested.handle).toBeInstanceOf(Handle);
  });

  it("rejects unknown fields, target storage, malformed ops, forward refs and prototype keys before any create", () => {
    class Rel extends Relationship {}
    const world = new World();
    world.component(Rel);
    const a = world.entity();
    const local = new LocalWorld(world);
    const count = world.entities.size;
    for (const op of [
      { set: true, entity: a.eid, component: "Rel", value: { _targets: [] } },
      { set: true, entity: a.eid, component: "Rel", value: JSON.parse('{"__proto__":{}}') },
      { destroy: true, add: true, entity: a.eid },
      { create: true, extra: 1 },
      { link: true, entity: a.eid, relationship: "Rel", to: "$1" },
    ]) {
      expect(() => local.command("vecs_mutate", { ops: [{ create: true }, op] })).toThrow();
      expect(world.entities.size).toBe(count);
    }
  });

  it("projects preceding writes for validators and names, but performs no writes on static rejection", () => {
    class Rules {
      force = 1;
      boost = 0;
      static vecs_validate(d: Rules) {
        return d.boost > d.force ? "too much" : true;
      }
    }
    const world = new World();
    world.component(Rules);
    const a = world.entity("old").add(Rules);
    const local = new LocalWorld(world);
    expect(
      local.command("vecs_mutate", {
        ops: [
          { name: true, entity: "old", value: "new" },
          { set: true, entity: "new", component: "Rules", value: { force: 10 } },
          { set: true, entity: "new", component: "Rules", value: { boost: 5 } },
        ],
      })
    ).toEqual({ applied: [{ eid: a.eid }, { eid: a.eid }, { eid: a.eid }] });
    expect(a.get(Rules)).toEqual({ force: 10, boost: 5 });
    expect(() =>
      local.command("vecs_mutate", {
        ops: [
          { set: true, entity: "new", component: "Rules", value: { force: 20 } },
          { set: true, entity: "new", component: "Rules", value: { boost: 30 } },
        ],
      })
    ).toThrow("too much");
    expect(a.get(Rules)).toEqual({ force: 10, boost: 5 });
  });
});
