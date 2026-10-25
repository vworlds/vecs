import { afterEach, describe, expect, it, vi } from "vitest";
import { Delta, Now, ON_LOAD, World } from "../src/index.js";

class Value {
  n = 0;
}

afterEach(() => vi.restoreAllMocks());

describe("idle systems", () => {
  it.each(["reactive", "each"] as const)(
    "avoids deferred scopes for idle %s systems and enters one when work arrives",
    (kind) => {
      const world = new World();
      const defer = vi.spyOn(world, "defer");
      world.component(Value);
      const callback = vi.fn();
      const system = world.system(kind).with(Value);
      const entity = world.entity();
      if (kind === "reactive") {
        system.enter(callback).update(Value, callback);
        entity.add(Value);
      } else {
        system.each([Value], callback);
      }
      // Finish building and drain the reactive member's initial entry before counting.
      world.progress(0, 10);
      expect(system.belongs(entity)).toBe(kind === "reactive");
      defer.mockClear();
      callback.mockClear();

      for (let frame = 1; frame <= 3; frame++) {
        world.progress(frame * 10, 10);
      }
      expect(defer).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();

      entity.set(Value, { n: 7 });
      world.progress(40, 10);
      expect(defer).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledTimes(1);
    }
  );

  it("enters one deferred scope per frame for run systems without members", () => {
    const world = new World();
    const defer = vi.spyOn(world, "defer");
    const callback = vi.fn();
    world.system("run").run(callback);
    world.progress(0, 10);
    defer.mockClear();
    callback.mockClear();

    for (let frame = 1; frame <= 3; frame++) {
      world.progress(frame * 10, 10);
      expect(defer).toHaveBeenCalledTimes(frame);
      expect(callback).toHaveBeenCalledTimes(frame);
    }
  });

  it("delivers entry, update and exit normally after idle frames, even with members", () => {
    const world = new World();
    world.component(Value);
    const events: string[] = [];
    world
      .system("reactive")
      .with(Value)
      .enter(() => events.push("enter"))
      .update(Value, (_entity, value) => events.push(`update:${value.n}`))
      .exit([Value], (_entity, [value]) => events.push(`exit:${value.n}`));
    world.progress(10, 10);
    world.progress(20, 10);
    expect(events).toEqual([]);
    const entity = world.entity().set(Value, { n: 1 });
    world.progress(30, 10);
    expect(events).toEqual(["enter"]);
    world.progress(40, 10);
    world.progress(50, 10);
    expect(events).toEqual(["enter"]);
    entity.set(Value, { n: 2 });
    world.progress(60, 10);
    entity.remove(Value);
    world.progress(70, 10);
    world.progress(80, 10);
    expect(events).toEqual(["enter", "update:2", "exit:2"]);
  });

  it("drains an inbox filled by an earlier system in the same frame", () => {
    const world = new World();
    world.component(Value);
    const entity = world.entity().add(Value);
    let write = false;
    world
      .system("producer")
      .phase(ON_LOAD)
      .run(() => {
        if (write) {
          entity.set(Value, { n: 7 });
        }
      });
    const values: number[] = [];
    world.system("consumer").update(Value, (_entity, value) => values.push(value.n));
    world.progress(10, 10);
    expect(values).toEqual([]);
    write = true;
    world.progress(20, 10);
    expect(values).toEqual([7]);
  });

  it.each([false, true])(
    "resumes an empty each query (ordered=%s) and stops on removal",
    (ordered) => {
      const world = new World();
      world.component(Value);
      const entity = world.entity();
      let addMember = false;
      world
        .system("producer")
        .phase(ON_LOAD)
        .run(() => {
          if (addMember) {
            entity.set(Value, { n: 3 });
            addMember = false;
          }
        });
      const visits: number[] = [];
      const system = world.system("each").with(Value);
      if (ordered) {
        system.orderBy([Value], (_a, [a], _b, [b]) => a.n - b.n);
      }
      system.each([Value], (_entity, [value]) => visits.push(value.n));
      world.progress(10, 10);
      world.progress(20, 10);
      expect(visits).toEqual([]);
      addMember = true;
      world.progress(30, 10);
      world.progress(40, 10);
      expect(visits).toEqual([3, 3]);
      entity.remove(Value);
      world.progress(50, 10);
      expect(visits).toEqual([3, 3]);
    }
  );

  it("never skips run callbacks, including those combined with an empty each query", () => {
    const world = new World();
    world.component(Value);
    const run = vi.fn();
    const combined = vi.fn();
    const each = vi.fn();
    world.system("run").run(run);
    world.system("combined").with(Value).each([Value], each).run(combined);
    for (let frame = 1; frame <= 3; frame++) {
      world.progress(frame * 10, 10);
    }
    expect(run.mock.calls).toEqual([
      [10, 10],
      [20, 10],
      [30, 10],
    ]);
    expect(combined.mock.calls).toEqual(run.mock.calls);
    expect(each).not.toHaveBeenCalled();
  });

  it("records admitted idle systems in stats but not disabled or cadence-gated runs", () => {
    const world = new World();
    world.component(Value);
    const reactive = world.system("reactive").update(Value, vi.fn());
    const each = world.system("each").with(Value).each([], vi.fn());
    const empty = world.system("empty");
    const rate = world.system("rate").rate(2);
    const disabled = world.system("disabled").disable();
    world.stats.enableSystems();
    vi.spyOn(performance, "now").mockReturnValue(0);
    for (let frame = 1; frame <= 3; frame++) {
      world.progress(frame * 10, 10);
    }
    expect(world.stats.systems()).toEqual(
      [reactive, each, empty, rate, disabled].map((system, index) => ({
        system,
        runs: [3, 3, 3, 1, 0][index],
        totalMs: 0,
        maxMs: 0,
      }))
    );
  });

  it("preserves interval residue, rate ticks and injection clocks across idle fires", () => {
    const world = new World();
    world.component(Value);
    const times: number[][] = [];
    const source = world
      .system("interval")
      .with(Value)
      .interval(0.025)
      .each([Now, Delta], (_entity, [now, delta]) => times.push([now, delta]));
    const downstream = vi.fn();
    world.system("downstream").rate(2, source).run(downstream);
    for (let frame = 1; frame <= 4; frame++) {
      world.progress(frame * 10, 10);
    }
    expect(times).toEqual([]);
    expect(source.didTick).toBe(false);
    expect(source.lastFireDelta).toBe(30);
    expect([source._injectNow, source._injectDelta]).toEqual([30, 30]);
    world.entity().add(Value);
    world.progress(50, 10);
    expect(times).toEqual([[50, 20]]);
    expect(downstream.mock.calls).toEqual([[50, 50]]);
    world.progress(60, 10);
    world.progress(70, 10);
    expect(times).toEqual([[50, 20]]);
    world.progress(80, 10);
    expect(times).toEqual([
      [50, 20],
      [80, 30],
    ]);
  });
});
