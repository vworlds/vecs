import { describe, it, expect } from "vitest";
import { World, Component } from "../src/index.js";

class Walking extends Component {}
class Running extends Component {}
class Idle extends Component {}
class Jumping extends Component {}
class Health extends Component {}

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

    const walkingType = w.getComponentType(Walking);
    const runningType = w.getComponentType(Running);
    const idleType = w.getComponentType(Idle);

    const walkingMeta = w.getComponentMeta(Walking);
    expect(walkingMeta.exclusive).not.toContain(walkingType);
    expect(walkingMeta.exclusive).toContain(runningType);
    expect(walkingMeta.exclusive).toContain(idleType);

    const runningMeta = w.getComponentMeta(Running);
    expect(runningMeta.exclusive).toContain(walkingType);
    expect(runningMeta.exclusive).not.toContain(runningType);
    expect(runningMeta.exclusive).toContain(idleType);
  });

  it("adding the first component in an exclusive group attaches it normally", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running, Idle);
    const e = w.createEntity();
    e.add(Walking);
    expect(e.get(Walking)).toBeDefined();
  });

  it("adding a second exclusive component removes the first", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running, Idle);
    const e = w.createEntity();
    e.add(Walking);
    e.add(Running);
    expect(e.get(Running)).toBeDefined();
    expect(e.get(Walking)).toBeUndefined();
  });

  it("switching to any member of the group evicts all others", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running, Idle);
    const e = w.createEntity();
    e.add(Walking);
    e.add(Idle);
    expect(e.get(Idle)).toBeDefined();
    expect(e.get(Walking)).toBeUndefined();
    expect(e.get(Running)).toBeUndefined();
  });

  it("add is idempotent — re-adding the same exclusive component keeps it", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running);
    const e = w.createEntity();
    const first = e.add(Walking);
    const second = e.add(Walking);
    expect(second).toBe(first);
    expect(e.get(Walking)).toBeDefined();
  });

  it("non-exclusive components are unaffected", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running);
    const e = w.createEntity();
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
    const e = w.createEntity();
    e.add(Walking);
    e.add(Idle);
    expect(e.get(Walking)).toBeDefined();
    expect(e.get(Idle)).toBeDefined();
  });

  it("exclusive switch via Entity.set also evicts conflicting members", () => {
    const w = makeWorld();
    w.setExclusiveComponents(Walking, Running);
    const e = w.createEntity();
    e.set(Walking, {});
    e.set(Running, {});
    expect(e.get(Running)).toBeDefined();
    expect(e.get(Walking)).toBeUndefined();
  });

  it("unregistered component throws from setExclusiveComponents", () => {
    const w = new World();
    class Unknown extends Component {}
    expect(() => w.setExclusiveComponents(Unknown)).toThrow();
  });
});
