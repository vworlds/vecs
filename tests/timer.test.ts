import { describe, it, expect, vi } from "vitest";
import { Component, World } from "../src/index.js";

class Position extends Component {}

function setup() {
  const world = new World();
  world.registerComponent(Position);
  const phase = world.addPhase("update");
  return { world, phase };
}

describe("Timers and tick sources", () => {
  it("system.interval fires on accumulated milliseconds and preserves drift", () => {
    const { world, phase } = setup();
    const cb = vi.fn();
    world.system("slow").phase(phase).interval(1).run(cb);
    world.start();

    world.runPhase(phase, 1500, 1500);
    world.runPhase(phase, 2000, 500);

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls.map((call) => call[1])).toEqual([1500, 500]);
  });

  it("system.rate fires every nth frame", () => {
    const { world, phase } = setup();
    const cb = vi.fn();
    world.system("every-other").phase(phase).rate(2).run(cb);
    world.start();

    for (let i = 1; i <= 5; i++) {
      world.runPhase(phase, i * 16, 16);
    }

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls.map((call) => call[0])).toEqual([32, 64]);
  });

  it("external timers drive systems", () => {
    const { world, phase } = setup();
    const timer = world.timer("second").interval(1);
    const cb = vi.fn();
    world.system("consumer").phase(phase).tickSource(timer).run(cb);
    world.start();

    world.runPhase(phase, 500, 500);
    world.runPhase(phase, 1000, 500);
    world.runPhase(phase, 1500, 500);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1000, 1000);
  });

  it("timer.rate can derive from another timer", () => {
    const { world, phase } = setup();
    const second = world.timer("second").interval(1);
    const minute = world.timer("minute").rate(60, second);
    const cb = vi.fn();
    world.system("consumer").phase(phase).tickSource(minute).run(cb);
    world.start();

    for (let i = 1; i <= 60; i++) {
      world.runPhase(phase, i * 1000, 1000);
    }

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(60000, 60000);
  });

  it("timers can use a system as their source", () => {
    const { world, phase } = setup();
    const second = world.system("sec").phase(phase).interval(1);
    const minute = world.timer("minute").rate(60, second);
    const cb = vi.fn();
    world.system("consumer").phase(phase).tickSource(minute).run(cb);
    world.start();

    for (let i = 1; i <= 60; i++) {
      world.runPhase(phase, i * 1000, 1000);
    }

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(60000, 60000);
  });

  it("nested timers can produce an hour tick", () => {
    const { world, phase } = setup();
    const second = world.timer("second").interval(1);
    const minute = world.timer("minute").rate(60, second);
    const cb = vi.fn();
    world.system("hour").phase(phase).tickSource(minute).rate(60).run(cb);
    world.start();

    for (let i = 1; i <= 3700; i++) {
      world.runPhase(phase, i * 1000, 1000);
    }

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(3600000, 3600000);
  });

  it("systems can be shared tick sources", () => {
    const { world, phase } = setup();
    const eachSecond = world.system("second").phase(phase).interval(1);
    const eachMinute = world.system("minute").phase(phase).tickSource(eachSecond).rate(60);
    const a = vi.fn();
    const b = vi.fn();
    world.system("a").phase(phase).tickSource(eachMinute).run(a);
    world.system("b").phase(phase).tickSource(eachMinute).run(b);
    world.start();

    for (let i = 1; i <= 120; i++) {
      world.runPhase(phase, i * 1000, 1000);
    }

    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
    expect(a.mock.calls.map((call) => call[0])).toEqual([60000, 120000]);
  });

  it("start and stop freeze timer state without catch-up", () => {
    const { world, phase } = setup();
    const timer = world.timer().interval(1);
    const cb = vi.fn();
    world.system("consumer").phase(phase).tickSource(timer).run(cb);
    world.start();

    world.runPhase(phase, 500, 500);
    timer.stop();
    world.runPhase(phase, 5500, 5000);
    timer.start();
    world.runPhase(phase, 6000, 500);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(6000, 1000);
  });

  it("inbox events accumulate until the next tick frame", () => {
    const { world, phase } = setup();
    const enter = vi.fn();
    world.system("slow").phase(phase).requires(Position).interval(1).enter(enter);
    world.start();

    const entity = world.entity();
    entity.add(Position);
    world.runPhase(phase, 500, 500);
    expect(enter).not.toHaveBeenCalled();

    world.runPhase(phase, 1000, 500);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledWith(entity);
  });

  it("disable clears inbox independently from timer stop/start", () => {
    const { world, phase } = setup();
    const timer = world.timer().interval(1);
    const enter = vi.fn();
    const sys = world.system("slow").phase(phase).requires(Position).tickSource(timer).enter(enter);
    world.start();

    world.entity().add(Position);
    timer.stop();
    sys.disable();
    timer.start();
    sys.enable();
    world.runPhase(phase, 1000, 1000);

    expect(enter).not.toHaveBeenCalled();
  });

  it("throttled run receives accumulated delta and unchanged now", () => {
    const { world, phase } = setup();
    const cb = vi.fn();
    world.system("slow").phase(phase).interval(1).run(cb);
    world.start();

    world.runPhase(phase, 250, 250);
    world.runPhase(phase, 1000, 750);

    expect(cb).toHaveBeenCalledWith(1000, 1000);
  });

  it("detects tick-source cycles", () => {
    const { world } = setup();
    const a = world.timer("a");
    const b = world.timer("b");

    a.tickSource(b);

    expect(() => b.tickSource(a)).toThrow();
  });

  it("validates intervals and rates", () => {
    const { world } = setup();
    const timer = world.timer();

    expect(() => timer.interval(0)).toThrow();
    expect(() => timer.interval(-1)).toThrow();
    expect(() => timer.rate(0)).toThrow();
    expect(() => timer.rate(1.5)).toThrow();
  });

  it("bare runPhase advances timer frames", () => {
    const { world, phase } = setup();
    const cb = vi.fn();
    world.system("every-other").phase(phase).rate(2).run(cb);
    world.start();

    world.runPhase(phase, 16, 16);
    world.runPhase(phase, 32, 16);

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("disabled source systems still tick downstream consumers", () => {
    const { world, phase } = setup();
    const source = world.system("source").phase(phase).interval(1);
    const cb = vi.fn();
    world.system("consumer").phase(phase).tickSource(source).run(cb);
    source.disable();
    world.start();

    world.runPhase(phase, 1000, 1000);

    expect(cb).toHaveBeenCalledTimes(1);
  });
});
