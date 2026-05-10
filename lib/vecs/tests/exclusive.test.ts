import { describe, it, expect } from "vitest";
import { World } from "../src/index.js";

class Walking {}
class Running {}
class Idle {}
class Jumping {}
class Health {}

function makeWorld() {
  const w = new World();
  w.registerComponent(Walking);
  w.registerComponent(Running);
  w.registerComponent(Idle);
  w.registerComponent(Jumping);
  w.registerComponent(Health);
  return w;
}

describe("exclusive components", () => {
  it("setExclusiveComponents populates exclusive list with the other members only", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running, Idle);

    const walkingMeta = w.getComponentMeta(Walking);
    const runningMeta = w.getComponentMeta(Running);
    const idleMeta = w.getComponentMeta(Idle);

    expect(walkingMeta._exclusive).not.toContain(walkingMeta);
    expect(walkingMeta._exclusive).toContain(runningMeta);
    expect(walkingMeta._exclusive).toContain(idleMeta);

    expect(runningMeta._exclusive).toContain(walkingMeta);
    expect(runningMeta._exclusive).not.toContain(runningMeta);
    expect(runningMeta._exclusive).toContain(idleMeta);
  });

  it("adding the first component in an exclusive group attaches it normally", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running, Idle);
    const e = w.entity();
    expect(e.add(Walking).get(Walking)).toBeDefined();
  });

  it("adding a second exclusive component removes the first", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running, Idle);
    const e = w.entity();
    e.add(Walking);
    e.add(Running);
    expect(e.get(Running)).toBeDefined();
    expect(e.get(Walking)).toBeUndefined();
  });

  it("switching to any member of the group evicts all others", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running, Idle);
    const e = w.entity();
    e.add(Walking);
    e.add(Idle);
    expect(e.get(Idle)).toBeDefined();
    expect(e.get(Walking)).toBeUndefined();
    expect(e.get(Running)).toBeUndefined();
  });

  it("add is idempotent — re-adding the same exclusive component keeps it", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running);
    const e = w.entity();
    const first = e.add(Walking).get(Walking);
    const second = e.add(Walking).get(Walking);
    expect(second).toBe(first);
    expect(e.get(Walking)).toBeDefined();
  });

  it("non-exclusive components are unaffected", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running);
    const e = w.entity();
    e.add(Walking);
    e.add(Health);
    e.add(Jumping);
    expect(e.get(Walking)).toBeDefined();
    expect(e.get(Health)).toBeDefined();
    expect(e.get(Jumping)).toBeDefined();
  });

  it("does not cross-contaminate independent exclusive groups", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running);
    w.setExclusiveComponents(Idle, Jumping);
    const e = w.entity();
    e.add(Walking);
    e.add(Idle);
    expect(e.get(Walking)).toBeDefined();
    expect(e.get(Idle)).toBeDefined();
  });

  it("exclusive switch via Entity.set also evicts conflicting members", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running);
    const e = w.entity();
    e.set(Walking, {});
    e.set(Running, {});
    expect(e.get(Running)).toBeDefined();
    expect(e.get(Walking)).toBeUndefined();
  });

  it("unregistered component throws from setExclusiveComponents", () => {
    const w = new World();
    class Unknown {}
    expect(() => w.setExclusiveComponents(Unknown)).toThrow();
  });
});
