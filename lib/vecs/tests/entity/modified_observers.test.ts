import { describe, expect, it } from "vitest";
import { type Entity, Implements, World } from "../../src/index.js";

class Health {
  hp = 0;
}
class Armor {}
abstract class Damageable {
  hp = 0;
}
class Hull extends Damageable {}

/** Run `fn` immediately or inside a deferred scope that drains on return. */
function runner(world: World, deferred: boolean): (fn: () => void) => void {
  return (fn) => (deferred ? world.defer(fn) : fn());
}

describe.each([false, true])("modified with and without observers (deferred: %s)", (deferred) => {
  it("does not swallow a later modified after one that nothing observed", () => {
    const world = new World();
    world.component(Health);
    const run = runner(world, deferred);
    const e = world.entity().add(Health);
    // No set hook, watcher or refresh consumer exists yet.
    run(() => e.modified(Health));
    run(() => e.modified(Health));
    const seen: Health[] = [];
    world.component(Health).on("set", (_entity, health) => seen.push(health as Health));
    run(() => e.modified(Health));
    run(() => e.modified(Health));
    expect(seen).toEqual([e.get(Health), e.get(Health)]);
    world.dispose();
  });

  it("delivers to an update watcher built after an unobserved modified", () => {
    const world = new World();
    world.component(Health);
    const run = runner(world, deferred);
    const e = world.entity().add(Health);
    run(() => e.modified(Health));
    const updates: [Entity, Health][] = [];
    world
      .query("health")
      .with(Health)
      .update({ watch: Health }, (entity, health) => updates.push([entity, health]))
      .build();
    run(() => e.modified(Health));
    expect(updates).toEqual([[e, e.get(Health)]]);
    world.dispose();
  });

  it("still re-evaluates a predicate term that watches the component", () => {
    const world = new World();
    world.component(Health);
    const run = runner(world, deferred);
    const e = world.entity().add(Health);
    run(() => e.modified(Health));
    const alive = world.getTerm({
      test: (entity: Entity) => (entity.get(Health)?.hp ?? 0) > 0,
      watch: [Health],
    });
    const events: number[] = [];
    const unsubscribe = alive.subscribe({ onTermEvent: (kind) => events.push(kind) });
    expect(alive.has(e)).toBe(false);
    // An in-place write: only the refresh hint can tell the predicate.
    (e.get(Health) as Health).hp = 5;
    run(() => e.modified(Health));
    expect(alive.has(e)).toBe(true);
    (e.get(Health) as Health).hp = 0;
    run(() => e.modified(Health));
    expect(alive.has(e)).toBe(false);
    expect(events).toEqual([0, 1]);
    unsubscribe();
    world.dispose();
  });

  it("reaches a set hook registered only on an implemented interface", () => {
    const world = new World();
    world.component(Damageable);
    world.component(Hull).set(Implements, { interfaces: [Damageable] });
    const run = runner(world, deferred);
    const e = world.entity().add(Hull);
    let sets = 0;
    world.component(Damageable).on("set", () => sets++);
    run(() => e.modified(Hull));
    expect(sets).toBe(1);
    world.dispose();
  });

  it("leaves unrelated components and membership untouched", () => {
    const world = new World();
    world.component(Health);
    world.component(Armor);
    const run = runner(world, deferred);
    const e = world.entity().add(Health).add(Armor);
    const union = world.getTerm({ any: [Health, Armor] });
    const events: number[] = [];
    const unsubscribe = union.subscribe({ onTermEvent: (kind) => events.push(kind) });
    const health = e.get(Health);
    run(() => e.modified(Health));
    expect(events).toEqual([]);
    expect(union.has(e)).toBe(true);
    expect(e.get(Health)).toBe(health);
    expect(e.has(Armor)).toBe(true);
    unsubscribe();
    world.dispose();
  });
});
