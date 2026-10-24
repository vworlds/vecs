import { expect, it, vi } from "vitest";
import { Component, World } from "@vworlds/vecs";
import * as v from "@vworlds/vecs";
import { LocalWorld } from "../../src/bridge/world.js";

it("reflects live component definitions with identical duplicate naming and no entity enumeration", () => {
  const world = new World();
  const a = world.component(class Duplicate {});
  const local = new LocalWorld(world);
  expect(local.registry().get("Duplicate")).toBe(a);
  const b = world.component(class Duplicate {});
  const expected = [...world.entities.values()].filter(
    (entity): entity is Component => entity instanceof Component
  );
  const counts = new Map<string, number>();
  expected.forEach((c) => counts.set(c.meta.Class.name, (counts.get(c.meta.Class.name) ?? 0) + 1));
  const registry = new Map(
    expected.map((c) => [
      counts.get(c.meta.Class.name) === 1 ? c.meta.Class.name : `${c.meta.Class.name}@${c.eid}`,
      c,
    ])
  );
  const values = vi.spyOn(world.entities, "values");
  try {
    expect(local.registry()).toEqual(registry);
    expect(local.registry().get(`Duplicate@${a.eid}`)).toBe(a);
    expect(local.registry().get(`Duplicate@${b.eid}`)).toBe(b);
    expect(values).not.toHaveBeenCalled();
  } finally {
    values.mockRestore();
    world.dispose();
  }
});

it("releases its schema query exactly once, including after world disposal", () => {
  const world = new World();
  world.flush();
  const baseline = world.queries.length;
  const local = new LocalWorld(world);
  expect(world.queries.filter((q) => q.name === "vecs-mcp.definitions")).toHaveLength(1);
  expect(world.queries.length).toBe(baseline + 2);
  local.dispose();
  local.dispose();
  expect(world.queries.length).toBe(baseline);
  expect(world.queries.filter((q) => q.name === "vecs-mcp.definitions")).toEqual([]);
  expect(world.queries.filter((q) => q.name === "vecs-mcp.traits")).toEqual([]);
  const second = new LocalWorld(world);
  world.dispose();
  expect(() => second.dispose()).not.toThrow();
});

type Definition = {
  name: string;
  kind: string;
  trait: boolean;
  traits: { name: string; targets?: (string | { $entity: number })[] }[];
  module?: string;
};

it("classifies all built-ins by declaration, independently of their usage", () => {
  const world = new World();
  world.module(v.PipelineModule);
  world.module(v.SnapshotModule);
  for (const C of [
    v.ClonePublic,
    v.DontSnapshot,
    v.CustomSnapshot,
    v.Phase,
    v.Query,
    v.System,
    v.SilenceSource,
  ]) {
    world.component(C);
  }
  const local = new LocalWorld(world);
  const rows = new Map(
    (local.command("vecs_components", {}) as Definition[]).map((c) => [c.name, c])
  );
  const groups: [string[], string, boolean][] = [
    [
      [
        "IdentityModule",
        "ImplementsModule",
        "SingletonModule",
        "RelationshipsModule",
        "SnapshotModule",
        "PipelineModule",
      ],
      "module",
      false,
    ],
    [["Trait", "ComponentDef", "Identity"], "component", false],
    [["ChildOf", "DependsOn", "SilenceSource"], "relationship", false],
    [["Exclusive", "Traversable", "OwnedTarget", "Singleton", "Implements"], "component", true],
    [["With", "OneOf", "OnSnapshot"], "relationship", true],
    [
      ["ClonePublic", "DontSnapshot", "CustomSnapshot", "Phase", "Query", "System"],
      "component",
      false,
    ],
  ];
  for (const [names, kind, trait] of groups) {
    for (const name of names) {
      expect(rows.get(name), name).toMatchObject({ name, kind, trait });
    }
  }
  world.dispose();
});

it("reports only declared traits, uniform pair targets, duplicate keys and nearest module provenance", () => {
  class Gravity {
    value = 0;
  }
  class Audited {}
  class Ordinary {}
  class Fruit {}
  class Orange {}
  class Position {}
  class Motion {}
  class Choice extends v.Relationship {}
  class Root extends v.Module {
    public init(): void {}
  }
  const world = new World();
  world.module(v.SnapshotModule);
  const root = world.module(Root);
  const middle = world.entity().childOf(root);
  world.component(Audited).add(v.Trait);
  world.component(Ordinary);
  const ordinaryKey = world.entity();
  const gravity = world
    .component(Gravity)
    .add(v.Singleton)
    .add(Audited)
    .add(Ordinary)
    .add(ordinaryKey)
    .childOf(middle);
  world.component(Fruit);
  world.component(Orange).set(v.Implements, { interfaces: [Fruit] });
  const p1 = world.component(Position);
  const p2 = world.component(class Position {});
  world.component(Motion).add(v.With, p1).add(v.With, p2);
  const parent = world.entity();
  world.component(Choice).add(v.OneOf, parent);
  const local = new LocalWorld(world);
  const rows = () =>
    new Map((local.command("vecs_components", {}) as Definition[]).map((c) => [c.name, c]));
  expect(rows().get("Gravity")).toMatchObject({
    kind: "component",
    trait: false,
    module: "Root",
    traits: [{ name: "Singleton" }, { name: "Audited" }],
  });
  expect(gravity.has(Gravity)).toBe(true);
  expect(rows().get("Orange")?.traits).toEqual([{ name: "Implements" }]);
  expect(rows().get("Motion")?.traits).toEqual([
    { name: "With", targets: [`Position@${p1.eid}`, `Position@${p2.eid}`] },
  ]);
  expect(rows().get("Choice")?.traits).toContainEqual({
    name: "OneOf",
    targets: [{ $entity: parent.eid }],
  });
  expect(rows().get("Trait")?.traits).toContainEqual({
    name: "OnSnapshot",
    targets: ["DontSnapshot"],
  });
  world.component(Audited).remove(v.Trait);
  expect(rows().get("Audited")?.trait).toBe(false);
  expect(rows().get("Gravity")?.traits).toEqual([{ name: "Singleton" }]);
  world.dispose();
});

it("reuses clean name indexes and invalidates duplicate names on definition entry and exit", () => {
  const world = new World();
  const local = new LocalWorld(world);
  const a = world.component(class Duplicate {});
  const first = local.registry();
  expect(local.registry()).toBe(first);
  const b = world.component(class Duplicate {});
  const second = local.registry();
  expect(second).not.toBe(first);
  expect(second.has("Duplicate")).toBe(false);
  expect(second.get(`Duplicate@${a.eid}`)).toBe(a);
  b.remove(v.ComponentDef);
  expect(local.registry().get("Duplicate")).toBe(a);
  b.add(v.ComponentDef);
  expect(local.registry().get(`Duplicate@${b.eid}`)).toBe(b);
  world.dispose();
});

it("does not scan carrier definitions to classify components", () => {
  const world = new World();
  const definitions = Array.from({ length: 80 }, () => world.component(class Data {}));
  const local = new LocalWorld(world);
  const registry = local.registry();
  const has = definitions.map((c) => vi.spyOn(c, "has"));
  expect(local.command("vecs_components", {}) as unknown[]).toHaveLength(registry.size);
  expect(has.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(0);
  has.forEach((spy) => spy.mockRestore());
  world.dispose();
});

it("counts definitions without materializing even a dirty registry", () => {
  const world = new World();
  const local = new LocalWorld(world);
  const definitions = world.query("expected.definitions").with(v.ComponentDef).build();
  const expected = definitions.count;
  const reflection = world.queries.find((q) => q.name === "vecs-mcp.definitions")!;
  const iterate = vi.spyOn(reflection, Symbol.iterator);
  const registryRead = vi.spyOn(local, "registry");
  expect(local.counts()).toEqual({
    entities: world.entities.size,
    components: expected,
    systems: world.pipeline.length,
  });
  expect(registryRead).not.toHaveBeenCalled();
  expect(iterate).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  world.dispose();
});

it("projects own entity components without scanning the registry and reads incoming edges once per relationship", () => {
  class Data {
    value = 3;
  }
  class Link extends v.Relationship {}
  const world = new World();
  world.component(Data);
  world.component(Link);
  for (let i = 0; i < 80; i++) {
    world.component(class Unused {});
  }
  const a = world.entity("a").add(Data);
  const b = world.entity("b").add(Link, a);
  a.add(Link, b);
  const local = new LocalWorld(world);
  const registry = local.registry();
  const iter = vi.spyOn(registry, Symbol.iterator);
  const has = vi.spyOn(a, "has");
  const children = vi.spyOn(a, "children");
  const values = vi.spyOn(world.entities, "values");
  const result = local.command("vecs_entity", { entity: a.eid }) as {
    components: Record<string, unknown>;
    relationships: Record<string, unknown>;
  };
  expect(result.components.Data).toEqual({ value: 3 });
  expect(result.relationships.Link).toEqual({ targets: [b.eid], children: [b.eid] });
  expect(iter).not.toHaveBeenCalled();
  expect(has).not.toHaveBeenCalled();
  expect(children.mock.calls.length).toBe(
    [...registry.values()].filter((c) => c.meta.isRelationship).length
  );
  expect(values).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  a.remove(Link, b);
  b.remove(Link, a);
  expect(
    (local.command("vecs_entity", { entity: a.eid }) as { relationships: object }).relationships
  ).not.toHaveProperty("Link");
  class LateLink extends v.Relationship {}
  world.component(LateLink);
  b.add(LateLink, a);
  expect(
    (local.command("vecs_entity", { entity: a.eid }) as { relationships: object }).relationships
  ).toHaveProperty("LateLink", { targets: [], children: [b.eid] });
  world.dispose();
});

it("uses cached find membership without creating terms and otherwise performs one predicate pass", () => {
  class Data {
    value = 3;
  }
  const world = new World();
  world.component(Data);
  const a = world.entity().add(Data);
  const local = new LocalWorld(world);
  const membership = world.query("cached").with(Data).build();
  const forEach = vi.spyOn(world.entities, "forEach");
  const count = world.queries.length;
  expect(local.command("vecs_find", { where: "Data", include: ["Data"] })).toEqual({
    total: 1,
    entities: [{ eid: a.eid, name: undefined, components: { Data: { value: 3 } } }],
  });
  expect(forEach).not.toHaveBeenCalled();
  expect(world.queries.length).toBe(count);
  membership.destroy();
  // A previously unseen boolean combination has no retained term.
  expect(local.command("vecs_find", { where: { any: ["Data", false] } })).toMatchObject({
    total: 1,
  });
  expect(forEach).toHaveBeenCalledTimes(1);
  expect(world.queries.length).toBe(count - 1);
  forEach.mockRestore();
  world.dispose();
});
