import { afterEach, describe, expect, it, vi } from "vitest";
import { ON_LOAD, System, World } from "../../src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("World system timing", () => {
  it("resets temporarily excluded systems and follows current pipeline membership", () => {
    class Hidden {}
    const world = new World();
    world.component(Hidden);
    const system = world.system("temporary").run(() => {});
    world.setPipeline({ all: [System, { not: Hidden }] });
    world.stats.enableSystems();
    vi.spyOn(performance, "now").mockReturnValue(0);
    world.progress(10, 10);
    expect(world.stats.systems()[0].runs).toBe(1);
    system.entity.add(Hidden);
    world.progress(20, 10);
    expect(world.stats.systems()).toEqual([]);
    world.stats.resetSystems();
    system.entity.remove(Hidden);
    world.progress(30, 10);
    expect(world.stats.systems()).toEqual([{ system, runs: 1, totalMs: 0, maxMs: 0 }]);
    system.destroy();
    world.progress(40, 10);
    expect(world.stats.systems()).toEqual([]);
  });
  it("is off by default and resumes without resetting", () => {
    const world = new World();
    const callback = vi.fn();
    const system = world.system("tick").run(callback);
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    world.progress(0, 10);
    expect(clock).not.toHaveBeenCalled();
    expect(world.stats.systems()).toEqual([{ system, runs: 0, totalMs: 0, maxMs: 0 }]);
    world.stats.enableSystems();
    world.progress(10, 10);
    world.stats.disableSystems();
    clock.mockClear();
    world.progress(20, 10);
    expect(clock).not.toHaveBeenCalled();
    expect(world.stats.systems()[0].runs).toBe(1);
    world.stats.enableSystems();
    world.progress(30, 10);
    expect(world.stats.systems()[0].runs).toBe(2);
    expect(callback).toHaveBeenCalledTimes(4);
  });

  it("counts only admitted executions, respects cadence and pipeline order, and resets", () => {
    const world = new World();
    const every = world.system("every").run(vi.fn());
    const interval = world.system("interval").interval(0.03).run(vi.fn());
    const rate = world.system("rate").rate(2).run(vi.fn());
    const disabled = world.system("disabled").run(vi.fn()).disable();
    const early = world.system("early").phase(ON_LOAD).run(vi.fn());
    world.stats.enableSystems();
    let clockMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clockMs++);
    for (let tick = 1; tick <= 12; tick++) {
      world.progress(tick * 10, 10);
    }
    expect(world.stats.systems()).toEqual(
      [early, every, interval, rate, disabled].map((system, index) => ({
        system,
        runs: [12, 12, 4, 6, 0][index],
        totalMs: [12, 12, 4, 6, 0][index],
        maxMs: index === 4 ? 0 : 1,
      }))
    );
    world.stats.resetSystems();
    expect(
      world.stats.systems().every((row) => row.runs === 0 && row.totalMs === 0 && row.maxMs === 0)
    ).toBe(true);
    expect(world.stats.systemsEnabled).toBe(true);
  });

  it("includes flush costs, exposes snapshots, and keeps total/max monotonic", () => {
    class Value {
      n = 0;
    }
    const world = new World();
    let clockMs = 0;
    let callbackMs = 2;
    world.component(Value).on("set", () => {
      clockMs += 7;
    });
    const entity = world.entity().add(Value);
    world.system("write").run(() => {
      clockMs += callbackMs;
      entity.set(Value, { n: 1 });
    });
    world.stats.enableSystems();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => clockMs);
    world.progress(10, 10);
    const snapshot = world.stats.systems()[0];
    expect(snapshot).toMatchObject({ runs: 1, totalMs: 9, maxMs: 9 });
    callbackMs = 5;
    world.progress(20, 10);
    expect(world.stats.systems()[0]).toMatchObject({ runs: 2, totalMs: 21, maxMs: 12 });
    expect(snapshot.totalMs).toBe(9);
    expect(clock).toHaveBeenCalledTimes(4);
  });

  it("counts an admitted idle reactive system but not a skipped tick source", () => {
    class Tag {}
    const world = new World();
    world.component(Tag);
    const reactive = world.system("idle").with(Tag).enter(vi.fn());
    const source = world.system("source").interval(1).run(vi.fn());
    const dependent = world.system("dependent").tickSource(source).run(vi.fn());
    world.stats.enableSystems();
    vi.spyOn(performance, "now").mockReturnValue(0);
    world.progress(10, 10);
    expect(world.stats.systems().map(({ system, runs }) => [system, runs])).toEqual([
      [reactive, 1],
      [source, 0],
      [dependent, 0],
    ]);
  });
});
