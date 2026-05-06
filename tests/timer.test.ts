import { describe, it, expect, vi } from "vitest";
import { Component, IntervalTickSource, RateTickSource, World } from "../src/index.js";

class Position extends Component {}

class CountingIntervalTickSource extends IntervalTickSource {
  public evalCount = 0;
  private readonly _seenFrames = new Set<number>();

  /** @internal */
  public override _evalTick(delta: number, frameId: number): boolean {
    if (!this._seenFrames.has(frameId)) {
      this._seenFrames.add(frameId);
      this.evalCount++;
    }
    return super._evalTick(delta, frameId);
  }
}

function setup() {
  const world = new World();
  world.registerComponent(Position);
  const phase = world.addPhase("update");
  const tick = (now: number, delta: number) => world.progress(now, delta);
  return { world, phase, tick };
}

describe("Timers and tick sources", () => {
  it("system.interval fires on accumulated milliseconds and preserves drift", () => {
    const { world, tick } = setup();
    const cb = vi.fn();
    world.system("slow").interval(1).run(cb);
    world.start();

    tick(1500, 1500);
    tick(2000, 500);

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls.map((call) => call[1])).toEqual([1500, 500]);
  });

  it("system.rate alone counts frames", () => {
    const { world, tick } = setup();
    const cb = vi.fn();
    world.system("every-other").rate(2).run(cb);
    world.start();

    for (let i = 1; i <= 5; i++) {
      tick(i * 16, 16);
    }

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls.map((call) => call[0])).toEqual([32, 64]);
  });

  it("external interval sources drive systems", () => {
    const { world, tick } = setup();
    const second = new IntervalTickSource(1);
    const cb = vi.fn();
    world.system("consumer").tickSource(second).run(cb);
    world.start();

    tick(500, 500);
    tick(1000, 500);
    tick(1500, 500);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1000, 1000);
  });

  it("rate sources can derive from another tick source", () => {
    const { world, tick } = setup();
    const second = new IntervalTickSource(1);
    const minute = new RateTickSource(60, second);
    const cb = vi.fn();
    world.system("consumer").tickSource(minute).run(cb);
    world.start();

    for (let i = 1; i <= 60; i++) {
      tick(i * 1000, 1000);
    }

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(60000, 60000);
  });

  it("nested chains can produce an hour tick", () => {
    const { world, tick } = setup();
    const second = new IntervalTickSource(1);
    const minute = new RateTickSource(60, second);
    const cb = vi.fn();
    world.system("hour").tickSource(minute).rate(60).run(cb);
    world.start();

    for (let i = 1; i <= 3700; i++) {
      tick(i * 1000, 1000);
    }

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(3600000, 3600000);
  });

  it("systems can be shared tick sources", () => {
    const { world, tick } = setup();
    const eachSecond = world.system("second").interval(1);
    const consumer = vi.fn();
    world.system("consumer").tickSource(eachSecond).run(consumer);
    world.start();

    for (let i = 1; i <= 120; i++) {
      tick(i * 1000, 1000);
    }

    expect(consumer).toHaveBeenCalledTimes(120);
    expect(consumer.mock.calls[0]).toEqual([1000, 1000]);
    expect(consumer.mock.calls[119]).toEqual([120000, 1000]);
  });

  it("start and stop on source implementations freeze cadence without catch-up", () => {
    const { world, tick } = setup();
    const second = new IntervalTickSource(1);
    const cb = vi.fn();
    world.system("consumer").tickSource(second).run(cb);
    world.start();

    tick(500, 500);
    second.stop();
    tick(5500, 5000);
    second.start();
    tick(6000, 500);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(6000, 1000);
  });

  it("inbox events accumulate until the next tick frame", () => {
    const { world, tick } = setup();
    const enter = vi.fn();
    world.system("slow").requires(Position).interval(1).enter(enter);
    world.start();

    const entity = world.entity();
    entity.add(Position);
    tick(500, 500);
    expect(enter).not.toHaveBeenCalled();

    tick(1000, 500);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledWith(entity);
  });

  it("throttled run receives accumulated delta and unchanged now", () => {
    const { world, tick } = setup();
    const cb = vi.fn();
    world.system("slow").interval(1).run(cb);
    world.start();

    tick(250, 250);
    tick(12345, 750);

    expect(cb).toHaveBeenCalledWith(12345, 1000);
  });

  it("validates interval and rate inputs", () => {
    expect(() => new IntervalTickSource(0)).toThrow();
    expect(() => new IntervalTickSource(-1)).toThrow();
    expect(() => new RateTickSource(0)).toThrow();
    expect(() => new RateTickSource(1.5)).toThrow();
  });

  it("systems without cadence fire every frame with raw delta", () => {
    const { world, tick } = setup();
    const cb = vi.fn();
    world.system("always").run(cb);
    world.start();

    tick(16, 16);
    tick(49, 33);

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls).toEqual([
      [16, 16],
      [49, 33],
    ]);
  });

  it("composes interval then rate as every nth interval", () => {
    const { world, tick } = setup();
    const cb = vi.fn();
    world.system("slow").interval(1).rate(2).run(cb);
    world.start();

    for (let i = 1; i <= 4; i++) {
      tick(i * 1000, 1000);
    }

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls.map((call) => call[0])).toEqual([2000, 4000]);
    expect(cb.mock.calls.map((call) => call[1])).toEqual([2000, 2000]);
  });

  it("composes tickSource then rate as every nth source tick", () => {
    const { world, tick } = setup();
    const second = new IntervalTickSource(1);
    const cb = vi.fn();
    world.system("minute").tickSource(second).rate(60).run(cb);
    world.start();

    for (let i = 1; i <= 60; i++) {
      tick(i * 1000, 1000);
    }

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(60000, 60000);
  });

  it("tickSource over an unconfigured system mirrors every frame", () => {
    const { world, tick } = setup();
    const source = world.system("source");
    const cb = vi.fn();
    world.system("consumer").tickSource(source).run(cb);
    world.start();

    tick(10, 10);
    tick(30, 20);

    expect(cb.mock.calls).toEqual([
      [10, 10],
      [30, 20],
    ]);
  });

  it("registers every source in a tickSource chain", () => {
    const { world } = setup();
    const second = new IntervalTickSource(1);
    const minute = new RateTickSource(60, second);
    const hour = new RateTickSource(60, minute);

    world.system("consumer").tickSource(hour);

    const sources = (world as any)._tickSources as Set<unknown>;
    expect(sources.has(second)).toBe(true);
    expect(sources.has(minute)).toBe(true);
    expect(sources.has(hour)).toBe(true);
  });

  it("evaluates a shared source once per progress call across phases", () => {
    const world = new World();
    const a = world.addPhase("a");
    const b = world.addPhase("b");
    const source = new CountingIntervalTickSource(1);
    world
      .system("a")
      .phase(a)
      .tickSource(source)
      .run(() => {});
    world
      .system("b")
      .phase(b)
      .tickSource(source)
      .run(() => {});
    world.start();

    world.progress(1000, 1000);

    expect(source.evalCount).toBe(1);
  });

  it("memoizes a shared source across multiple consumers", () => {
    const { world, tick } = setup();
    const source = new CountingIntervalTickSource(1);
    world
      .system("a")
      .tickSource(source)
      .run(() => {});
    world
      .system("b")
      .tickSource(source)
      .run(() => {});
    world
      .system("c")
      .tickSource(source)
      .run(() => {});
    world.start();

    tick(1000, 1000);

    expect(source.evalCount).toBe(1);
  });
});
