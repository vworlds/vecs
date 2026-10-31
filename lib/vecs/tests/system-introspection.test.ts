import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ALWAYS_TICK_SOURCE,
  BUILTIN_PIPELINE_PHASES,
  DependsOn,
  IntervalTickSource,
  ON_UPDATE,
  RateTickSource,
  System,
  World,
  type ITickSource,
} from "../src/index.js";

describe("System introspection", () => {
  it("types introspection as read-only without hiding system instances", () => {
    expectTypeOf<World["pipeline"]>().toEqualTypeOf<readonly System[]>();
    expectTypeOf<Pick<System, "cadence" | "enabled">>().toEqualTypeOf<{
      readonly cadence: ITickSource;
      readonly enabled: boolean;
    }>();
    expectTypeOf<Pick<IntervalTickSource, "seconds">>().toEqualTypeOf<{
      readonly seconds: number;
    }>();
    expectTypeOf<Pick<RateTickSource, "rate" | "source">>().toEqualTypeOf<{
      readonly rate: number;
      readonly source: ITickSource | undefined;
    }>();
    expectTypeOf<System["callbacks"]>().toEqualTypeOf<
      readonly ("each" | "run" | "enter" | "update" | "exit")[]
    >();
  });

  it("reports registered callbacks and update watches before and after build", () => {
    class A {}
    class B {}
    const world = new World();
    world.component(A);
    world.component(B);
    const each = world.system("each").each([], () => {});
    const run = world.system("run").run(() => {});
    const reactive = world
      .system("reactive")
      .enter(() => {})
      .exit(() => {});
    const oneWatch = world.system("one watch").update(A, () => {});
    const twoWatches = world
      .system("two watches")
      .update(A, () => {})
      .update(B, () => {});
    const mixed = world
      .system("mixed")
      .each([], () => {})
      .run(() => {})
      .enter(() => {})
      .update(B, () => {})
      .exit(() => {});

    expect(each.callbacks).toEqual(["each"]);
    expect(run.callbacks).toEqual(["run"]);
    expect(reactive.callbacks).toEqual(["enter", "exit"]);
    expect(oneWatch.callbacks).toEqual(["update"]);
    expect(oneWatch.watched).toEqual([A]);
    expect(twoWatches.callbacks).toEqual(["update"]);
    expect(twoWatches.watched).toEqual([A, B]);
    expect(mixed.callbacks).toEqual(["each", "run", "enter", "update", "exit"]);
    expect(mixed.watched).toEqual([B]);
    expect(Object.isFrozen(mixed.callbacks)).toBe(true);
    expect(Object.isFrozen(mixed.watched)).toBe(true);

    const beforeBuild = [each.callbacks, run.callbacks, reactive.callbacks, oneWatch.watched];
    world.pipeline;
    expect([each.callbacks, run.callbacks, reactive.callbacks, oneWatch.watched]).toEqual(
      beforeBuild
    );
  });

  it("lists a fresh world's systems in phase order without executing them", () => {
    const world = new World();
    const seen: string[] = [];
    for (const phase of [...BUILTIN_PIPELINE_PHASES].reverse()) {
      world
        .system(`sys:${phase}`)
        .phase(phase)
        .run(() => seen.push(`sys:${phase}`));
    }

    const pipeline = world.pipeline;
    expect(pipeline.map((system) => system.name)).toEqual(
      BUILTIN_PIPELINE_PHASES.map((phase) => `sys:${phase}`)
    );
    expect(seen).toEqual([]);
    expect(world.pipeline).toBe(pipeline);
    world.progress(0, 16);
    expect(seen).toEqual(pipeline.map((system) => system.name));
    expect(world.pipeline).toBe(pipeline);
    for (const system of pipeline) {
      expect(system.entity.get(System)).toBe(system);
      expect(system.entity.target(DependsOn)).toBe(world.entity(system.name!.slice(4)));
    }
  });

  it("reflects same-phase order, DependsOn chains, late additions and destruction", () => {
    const world = new World();
    const seen: string[] = [];
    const later = world.system("later").run(() => seen.push("later"));
    const first = world.system("first").run(() => seen.push("first"));
    const second = world.system("second").run(() => seen.push("second"));
    later.phase(second.entity);
    expect(world.pipeline).toEqual([first, second, later]);
    expect(first.entity.target(DependsOn)).toBe(world.entity(ON_UPDATE));
    world.progress(0, 16);
    expect(seen).toEqual(["first", "second", "later"]);

    const last = world
      .system("last")
      .phase(later.entity)
      .run(() => seen.push("last"));
    expect(world.pipeline).toEqual([first, second, later, last]);
    seen.length = 0;
    world.progress(16, 16);
    expect(seen).toEqual(world.pipeline.map((system) => system.name));
    last.destroy();
    expect(world.pipeline).toEqual([first, second, later]);
  });

  it("respects a custom pipeline's filter and sort order", () => {
    class Selected {}
    const world = new World();
    world.component(Selected);
    const seen: string[] = [];
    const first = world.system("first").run(() => seen.push("first"));
    const second = world.system("second").run(() => seen.push("second"));
    world.system("excluded").run(() => seen.push("excluded"));
    first.entity.add(Selected);
    second.entity.add(Selected);
    world.setPipeline(Selected).orderBy([], (a, _av, b) => b.eid - a.eid);

    expect(world.pipeline).toEqual([second, first]);
    world.progress(0, 16);
    expect(seen).toEqual(["second", "first"]);
  });

  it("does not drain deferred commands and retains the active frame's pipeline", () => {
    const world = new World();
    let active: readonly System[] = [];
    const first = world.system("first").run(() => {
      active = world.pipeline;
      world.system("late").run(() => {});
      expect(world.pipeline).toBe(active);
    });
    const second = world.system("second").run(() => {
      // The prior system's flush has made "late" visible to the pipeline query,
      // but introspection must still return the array this frame is executing.
      expect(world.pipeline).toBe(active);
      expect(world.pipeline.map((system) => system.name)).toEqual(["first", "second"]);
    });
    world.beginDefer();
    second.entity.remove(DependsOn);
    expect(world.pipeline).toEqual([first, second]);
    expect(second.entity.has(DependsOn)).toBe(true);
    world.endDefer();
    expect(world.pipeline).toEqual([first]);
    second.entity.add(DependsOn, world.entity(ON_UPDATE));
    world.progress(0, 16);
    expect(world.pipeline.map((system) => system.name)).toEqual(["first", "second", "late"]);
  });

  it("exposes default, interval, rate and replaced cadence without ticking", () => {
    const world = new World();
    const system = world.system("clock");
    expect(system.cadence).toBe(world.alwaysTickSource);
    system.interval(0.5);
    const interval = system.cadence as IntervalTickSource;
    expect(interval).toBeInstanceOf(IntervalTickSource);
    expect(interval.seconds).toBe(0.5);
    system.rate(3);
    const rate = system.cadence as RateTickSource;
    expect(rate).toBeInstanceOf(RateTickSource);
    expect(rate.rate).toBe(3);
    expect(rate.source).toBe(interval);
    system.rate(2, ALWAYS_TICK_SOURCE);
    expect((system.cadence as RateTickSource).source).toBe(world.alwaysTickSource);
    expect((system.cadence as RateTickSource).rate).toBe(2);
    system.tickSource(interval);
    expect(system.cadence).toBe(interval);
    system.interval(1.25);
    expect((system.cadence as IntervalTickSource).seconds).toBe(1.25);
    const frames = new RateTickSource(4);
    expect(frames.rate).toBe(4);
    expect(frames.source).toBeUndefined();
    const everyOther = world.system("every other").rate(2).cadence as RateTickSource;
    expect(everyOther.rate).toBe(2);
    expect(everyOther.source).toBe(world.alwaysTickSource);
  });

  it("lists disabled systems and reports enable/disable state", () => {
    const world = new World();
    const system = world.system("enabled");
    expect(system.enabled).toBe(true);
    system.disable();
    expect(system.enabled).toBe(false);
    expect(world.pipeline).toEqual([system]);
    system.enable();
    expect(system.enabled).toBe(true);
  });
});
