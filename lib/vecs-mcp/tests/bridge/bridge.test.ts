import { describe, expect, it } from "vitest";
import {
  World,
  Module,
  Relationship,
  DontSnapshot,
  Entity,
  Trait,
  type,
  range,
} from "@vworlds/vecs";
import { Router } from "../../src/bridge/router.js";
import { LocalWorld } from "../../src/bridge/world.js";
import { serialize } from "../../src/bridge/serialize.js";
import { field } from "../../src/schema/index.js";

class Position {
  @type("f64") @range(-100, 100) x = 1;
  @type("f64") y = 2;
}
class Dead {}
class Likes extends Relationship {}
class Resource {
  secret = "private";
}
class Data {
  nested = { a: [1, 2] };
  resource = new Resource();
  target: Entity | null = null;
}
class Definitions extends Module {
  public init(): void {
    this.world.component(Position);
  }
}

function fixture(readOnly = false) {
  const world = new World();
  world.module(Definitions);
  [Dead, Likes, Data, Resource].forEach((C) => world.component(C));
  world.component(Resource).snapshotPolicy(DontSnapshot);
  const a = world.entity("alice").add(Position);
  const b = world.entity("bob").add(Dead).add(Position).childOf(a);
  a.add(Likes, b).set(Data, { target: b }).add(Resource);
  world
    .system("move")
    .with(Position)
    .each([], () => {});
  const local = new LocalWorld(world, readOnly);
  const call = (command: string, params: Record<string, unknown> = {}) =>
    local.command(`vecs_${command}`, params) as any;
  return { world, a, b, local, call };
}

describe("local bridge", () => {
  it("discovers schemas, owning modules, traits and carrier counts", () => {
    const { world, call } = fixture();
    world.component(Dead).add(Trait);
    world.component(Position).add(Dead);
    world.component(Position).name = "position-definition";
    expect(call("components", { filter: "Position" })).toEqual([
      expect.objectContaining({
        name: "Position",
        kind: "component",
        module: "Definitions",
        carriers: 2,
        trait: false,
        traits: [{ name: "Dead" }],
        schema: expect.objectContaining({ type: "object" }),
      }),
    ]);
    expect(call("components").find((c: any) => c.name === "Likes").kind).toBe("relationship");
    expect(call("components").find((c: any) => c.name === "Definitions").kind).toBe("module");
    expect(call("components").find((c: any) => c.name === "Dead")).toMatchObject({
      kind: "component",
      trait: true,
    });
    expect(call("components", { filter: "Position" })[0].traits).toEqual([{ name: "Dead" }]);
    for (const component of call("components")) {
      expect(component.traits).not.toContainEqual({ name: "ComponentDef" });
    }
    expect(call("components").find((c: any) => c.name === "Identity").kind).toBe("component");
  });

  it.each([
    ["Position", ["alice", "bob"]],
    [["Position", { not: "Dead" }], ["alice"]],
    [{ all: ["Position", { not: "Dead" }] }, ["alice"]],
    [{ any: ["Dead", "Data"] }, ["alice", "bob"]],
    [{ only: ["Identity", "Position", "Dead", "ChildOf"] }, ["bob"]],
    [{ target: ["Likes", "Dead"] }, ["alice"]],
    [{ source: ["Likes", "Data"] }, ["bob"]],
    [{ parent: "Data" }, ["bob"]],
    [{ children: "Dead" }, ["alice"]],
  ])("runs DSL %# with world.filter", (where, names) => {
    const { call } = fixture();
    const result = call("find", { where, include: ["Position"] });
    expect(result.entities.map((e: any) => e.name).sort()).toEqual(names);
    expect(result.total).toBe(names.length);
    for (const e of result.entities) {
      expect(e.components).toEqual({ Position: { x: 1, y: 2 } });
    }
  });

  it("supports true, false, pagination, empty projection, and rejects test and malformed queries", () => {
    const { world, call } = fixture();
    expect(call("find", { where: true, limit: 1 }).total).toBe(world.entities.size);
    expect(call("find", { where: false })).toEqual({ total: 0, entities: [] });
    expect(call("find", { where: "Position", offset: 1, limit: 1 }).entities[0].components).toEqual(
      {}
    );
    expect(() => call("find", { where: { test: "bad" } })).toThrow("test");
    for (const where of [
      { all: "Position" },
      { only: "Missing" },
      { target: ["Position", true] },
      { wat: true },
      { any: [], not: "Dead" },
    ]) {
      expect(() => call("find", { where })).toThrow();
    }
    expect(() => call("find", { where: true, include: ["Missing"] })).toThrow("include");
  });

  it("dumps relationships, parent, entity references and opaque values", () => {
    const { a, b, call } = fixture();
    const result = call("entity", { entity: "alice" });
    expect(result).toMatchObject({
      eid: a.eid,
      name: "alice",
      parent: null,
      components: {
        Position: { x: 1, y: 2 },
        Data: {
          nested: { a: [1, 2] },
          resource: { $opaque: "Resource" },
          target: { $entity: b.eid },
        },
        Resource: { $opaque: "Resource" },
      },
      relationships: {
        Likes: { targets: [b.eid], children: [] },
        ChildOf: { targets: [], children: [b.eid] },
      },
    });
    expect(call("entity", { entity: b.eid }).parent).toBe(a.eid);
    expect(() => call("entity", { entity: "missing" })).toThrow("Unknown entity");
  });

  it("never walks class values, handles cycles and limits depth", () => {
    class Secret {
      get hidden(): never {
        throw new Error("walked!");
      }
    }
    expect(serialize(new Secret())).toEqual({ $opaque: "Secret" });
    const cycle: any = { a: 1 };
    cycle.self = cycle;
    expect(JSON.stringify(serialize(cycle))).toContain("depth limit");
    expect(serialize({ a: { b: 1 } }, 1)).toEqual({ a: { $opaque: "depth limit" } });
    expect(serialize(Object.assign(Object.create(null), { a: 1 }))).toEqual({ a: 1 });
  });

  it("supports every mutation op and create references, with read-after-write", () => {
    const { world, a, call } = fixture();
    const result = call("mutate", {
      ops: [
        { create: true, name: "new" },
        { add: true, entity: "$0", component: "Position" },
        { set: true, entity: "$0", component: "Position", value: { x: 10 } },
        { set: true, entity: "$0", component: "Position", value: { y: 20 } },
        { link: true, entity: "$0", relationship: "Likes", to: a.eid },
        { unlink: true, entity: "$0", relationship: "Likes", to: a.eid },
        { name: true, entity: "$0", value: "renamed" },
        { remove: true, entity: "$0", component: "Likes" },
      ],
    });
    expect(result.error).toBeUndefined();
    const eid = result.applied[0].eid;
    expect(world.entity(eid).get(Position)).toEqual({ x: 10, y: 20 });
    expect(world.entity(eid).name).toBe("renamed");
    expect(world.entity(eid).targets(Likes)).toEqual([]);
    expect(call("mutate", { ops: [{ destroy: true, entity: eid }] }).applied).toEqual([{ eid }]);
    expect(world.getEntity(eid)).toBeUndefined();
  });

  it.each([
    { set: true, entity: "alice", component: "Position", value: { x: 101 } },
    { add: true, entity: "alice", component: "Missing" },
    { destroy: true, entity: "missing" },
    { set: true, entity: "alice", component: "Resource", value: { secret: "leak" } },
    { set: true, entity: "alice", component: "Data", value: { resource: {} } },
    { add: true, entity: "$1", component: "Position" },
  ])("static rejection applies nothing %#", (op) => {
    const { world, call } = fixture();
    const count = world.entities.size;
    expect(() => call("mutate", { ops: [{ create: true }, op] })).toThrow();
    expect(world.entities.size).toBe(count);
  });

  it("checks readOnly fields, validator drafts, and deferred precondition", () => {
    class Rules {
      @field({ readOnly: true }) heat = 0;
      force = 10;
      boost = 0;
      static vecs_validate(d: Rules) {
        return d.boost > d.force ? "too much" : true;
      }
    }
    const { world, a, call } = fixture();
    world.component(Rules);
    a.add(Rules);
    expect(() =>
      call("mutate", {
        ops: [{ set: true, entity: "alice", component: "Rules", value: { heat: 1 } }],
      })
    ).toThrow("readOnly");
    expect(() =>
      call("mutate", {
        ops: [{ set: true, entity: "alice", component: "Rules", value: { force: 1, boost: 2 } }],
      })
    ).toThrow("too much");
    world.defer(() =>
      expect(() => call("mutate", { ops: [{ create: true }] })).toThrow("world.deferred")
    );
  });

  it("stops at runtime hook failure and reports only completed ops; never replays suffix", () => {
    const { world, a, b, call } = fixture();
    world.component(Position).on("set", (_entity, p) => {
      if (p.x === 7) {
        throw new Error("hook failed");
      }
    });
    const result = call("mutate", {
      ops: [
        { set: true, entity: a.eid, component: "Position", value: { y: 9 } },
        { set: true, entity: a.eid, component: "Position", value: { x: 7 } },
        { destroy: true, entity: b.eid },
      ],
    });
    expect(result).toEqual({
      applied: [{ eid: a.eid }],
      error: { index: 1, message: "hook failed" },
    });
    world.flush();
    expect(world.getEntity(b.eid)).toBe(b);
    expect(a.get(Position)?.y).toBe(9);
  });

  it("lists systems, toggles them, and reports stats without enabling collection", () => {
    const { world, call } = fixture();
    expect(call("systems")).toEqual([
      expect.objectContaining({
        name: "move",
        phase: "vecs::OnUpdate",
        enabled: true,
        callbacks: ["each"],
        watched: [],
        timing: { runs: 0, totalMs: 0, maxMs: 0 },
      }),
    ]);
    expect(call("systems", { disable: "move" })[0].enabled).toBe(false);
    expect(call("systems", { enable: "move" })[0].enabled).toBe(true);
    expect(call("stats")).toEqual({
      systems: [{ name: "move", runs: 0, totalMs: 0, maxMs: 0 }],
      operations: [],
    });
    expect(world.stats.systemsEnabled).toBe(false);
    expect(() => call("systems", { enable: "missing" })).toThrow("Unknown system");
  });

  it("rejects writes on readOnly nodes without affecting reads", () => {
    const { call } = fixture(true);
    expect(() => call("mutate", { ops: [] })).toThrow("readOnly");
    expect(() => call("systems", { enable: "move" })).toThrow("readOnly");
    expect(() => call("systems", { disable: "move" })).toThrow("readOnly");
    expect(call("find", { where: "Position" }).total).toBe(2);
  });

  it("routes through first segment table and provides omission errors with paths", async () => {
    const { world } = fixture();
    const router = new Router("node", { name: "node" });
    router.register(world, "one");
    const request = { id: "1", command: "vecs_find", params: { where: "Position" } };
    expect(await router.dispatch(request)).toMatchObject({ id: "1", result: { total: 2 } });
    router.register(new World(), "two");
    expect(await router.dispatch(request)).toMatchObject({
      error: { message: "Specify target; available targets: node/one, node/two", hops: ["node"] },
    });
    router.destinations.set("peer", {
      paths: () => ["peer/remote"],
      dispatch: () => ({ remote: true }),
    });
    expect(await router.dispatch({ ...request, target: "peer/remote" })).toEqual({
      id: "1",
      result: { remote: true },
    });
    expect(() => router.register(world, "one")).toThrow("Duplicate world");
    expect(await router.dispatch({ ...request, target: "node/one/extra" })).toMatchObject({
      error: { message: "Unknown target node/one/extra" },
    });
  });

  it("disambiguates duplicate component names with @eid", () => {
    const { world, call } = fixture();
    const A = class Duplicate {};
    const B = class Duplicate {};
    const a = world.component(A);
    const b = world.component(B);
    expect(call("components", { filter: "Duplicate" }).map((c: any) => c.name)).toEqual([
      `Duplicate@${a.eid}`,
      `Duplicate@${b.eid}`,
    ]);
    expect(() => call("find", { where: "Duplicate" })).toThrow("Unknown component");
  });
});
