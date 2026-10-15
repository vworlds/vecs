import { describe, expect, it } from "vitest";
import { World, Entity, Relationship } from "@vworlds/vecs";
import { field } from "../../src/schema/index.js";
import { LocalWorld } from "../../src/bridge/world.js";

describe("mutation boundaries", () => {
  it("resolves entity-typed eids to Entity instances without walking them", () => {
    class Target {
      @field({ type: "entity", optional: true }) target: Entity | undefined = undefined;
      count = 1;
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
      @field({ validate: (v, d) => ((v as number) > (d.force as number) ? "too much" : undefined) })
      boost = 0;
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
