import { describe, expect, it } from "vitest";
import { Relationship, World } from "../../src/index.js";

class Health {
  hp = 7;
}
class Likes extends Relationship {}

/** Run `fn` immediately or inside a deferred scope that drains on return. */
function runner(world: World, deferred: boolean): (fn: () => void) => void {
  return (fn) => (deferred ? world.defer(fn) : fn());
}

describe.each([false, true])("plain add (deferred: %s)", (deferred) => {
  it("materializes an absent component once and leaves a present one alone", () => {
    const world = new World();
    const events: string[] = [];
    world
      .component(Health)
      .on("add", () => events.push("add"))
      .on("set", () => events.push("set"));
    const run = runner(world, deferred);
    const e = world.entity();
    run(() => e.add(Health));
    const health = e.get(Health);
    expect(health).toEqual({ hp: 7 });
    (e.get(Health) as Health).hp = 3;
    run(() => e.add(Health));
    run(() => {
      e.add(Health);
      e.add(Health);
    });
    expect(e.get(Health)).toBe(health);
    expect(e.get(Health)).toEqual({ hp: 3 });
    expect(events).toEqual(["add"]);
    world.dispose();
  });

  it("adds again after a removal, with a fresh instance", () => {
    const world = new World();
    let adds = 0;
    world.component(Health).on("add", () => adds++);
    const run = runner(world, deferred);
    const e = world.entity();
    run(() => e.add(Health));
    const first = e.get(Health);
    run(() => e.remove(Health));
    expect(e.has(Health)).toBe(false);
    run(() => e.add(Health));
    expect(e.get(Health)).not.toBe(first);
    expect(e.get(Health)).toEqual({ hp: 7 });
    expect(adds).toBe(2);
    world.dispose();
  });

  it("keeps the removal when add and remove are queued in one scope", () => {
    const world = new World();
    world.component(Health);
    const run = runner(world, deferred);
    const e = world.entity();
    run(() => {
      e.add(Health);
      e.remove(Health);
    });
    expect(e.has(Health)).toBe(false);
    run(() => {
      e.add(Health);
      e.remove(Health);
      e.add(Health);
    });
    expect(e.get(Health)).toEqual({ hp: 7 });
    world.dispose();
  });

  it("treats a set without data like an add, and never creates a targetless relationship", () => {
    const world = new World();
    let sets = 0;
    world.component(Health).on("set", () => sets++);
    world.component(Likes);
    const run = runner(world, deferred);
    const e = world.entity();
    run(() => e.set(Health, undefined as never));
    expect(e.get(Health)).toEqual({ hp: 7 });
    expect(sets).toBe(0);
    run(() => e.set(Likes, undefined as never));
    expect(e.has(Likes)).toBe(false);
    world.dispose();
  });

  it("ignores an add on a destroyed entity", () => {
    const world = new World();
    let adds = 0;
    world.component(Health).on("add", () => adds++);
    const run = runner(world, deferred);
    const e = world.entity();
    e.destroy();
    run(() => e.add(Health));
    expect(adds).toBe(0);
    expect(e.has(Health)).toBe(false);
    world.dispose();
  });
});
