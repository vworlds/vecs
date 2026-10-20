import { expect, it, vi } from "vitest";
import { Component, World } from "@vworlds/vecs";
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
  expect(world.queries.length).toBe(baseline + 1);
  local.dispose();
  local.dispose();
  expect(world.queries.length).toBe(baseline);
  expect(world.queries.filter((q) => q.name === "vecs-mcp.definitions")).toEqual([]);
  const second = new LocalWorld(world);
  world.dispose();
  expect(() => second.dispose()).not.toThrow();
});
