import { describe, it, expect, vi } from "vitest";
import { IntervalTickSource, RateTickSource, World } from "../src/index.js";
import { makePhase } from "./_helpers.js";

class Position {}

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
  world.component(Position);
  world.setPipeline(true);
  const tick = (now: number, delta: number) => world.progress(now, delta);
  return { world, tick };
}

describe("Timers and tick sources", () => {
  it.each([
    [30, 0.5, 15],
    [30, 1, 30],
    [30, 0.1, 3],
    [60, 0.5, 30],
    [15, 1, 15],
  ])("interval(%s Hz, %s seconds) fires every %s frames", (hz, seconds, k) => {
    const { world, tick } = setup();
    const frames: number[] = [];
    let frame = 0;
    world
      .system("measured")
      .interval(seconds)
      .run(() => frames.push(frame));
    for (frame = 1; frame <= k * 4; frame++) {
      tick(frame * (1000 / hz), 1000 / hz);
    }
    expect(frames).toEqual([k, k * 2, k * 3, k * 4]);
  });

  describe.each([15, 30, 60])("whole-frame intervals at %s Hz", (hz) => {
    it.each([1, 3, 15, 30, 45])("fires every %s frames over 100,000 frames", (k) => {
      const source = new IntervalTickSource(k / hz);
      const mismatches: number[] = [];
      let count = 0;
      for (let frame = 1; frame <= 100_000; frame++) {
        const fired = source._evalTick(1000 / hz, frame);
        if (fired) {
          count++;
        }
        if (fired !== (frame % k === 0) && mismatches.length < 10) {
          mismatches.push(frame);
        }
      }
      expect(mismatches).toEqual([]);
      expect(count).toBe(Math.floor(100_000 / k));
    });

    it("preserves the exact rational schedule with jittered fractional deltas", () => {
      const source = new IntervalTickSource(15 / hz);
      // Eighths of a frame: each four-frame cycle still totals four frames.
      const eighths = [6, 10, 9, 7];
      const mismatches: number[] = [];
      let elapsedEighths = 0;
      let count = 0;
      for (let frame = 1; frame <= 100_000; frame++) {
        const step = eighths[(frame - 1) % eighths.length];
        const before = Math.floor(elapsedEighths / (15 * 8));
        elapsedEighths += step;
        const expected = Math.floor(elapsedEighths / (15 * 8)) > before;
        const fired = source._evalTick((1000 / hz) * (step / 8), frame);
        if (fired) {
          count++;
        }
        if (fired !== expected && mismatches.length < 10) {
          mismatches.push(frame);
        }
      }
      expect(mismatches).toEqual([]);
      expect(count).toBe(Math.floor(elapsedEighths / (15 * 8)));
    });
  });

  it.each([
    [16, 100],
    [8, 100],
    [20, 105],
  ])(
    "preserves non-whole-frame schedules for %s ms frames / %s ms intervals",
    (delta, interval) => {
      const source = new IntervalTickSource(interval / 1000);
      const mismatches: number[] = [];
      let count = 0;
      // Integer millisecond arithmetic is exact here and models the old >= rule.
      for (let frame = 1; frame <= 100_000; frame++) {
        const expected =
          Math.floor((frame * delta) / interval) > Math.floor(((frame - 1) * delta) / interval);
        const fired = source._evalTick(delta, frame);
        if (fired) {
          count++;
        }
        if (fired !== expected && mismatches.length < 10) {
          mismatches.push(frame);
        }
      }
      expect(mismatches).toEqual([]);
      expect(count).toBe(Math.floor((100_000 * delta) / interval));
    }
  );

  it.each([
    {
      hz: 15,
      frames: Array.from({ length: 60 }, (_, i) => i + 1).filter(
        (frame) => ![1, 22, 43].includes(frame)
      ),
    },
    {
      hz: 30,
      frames: [
        3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 45, 47, 49, 51,
        53, 55, 57, 59,
      ],
    },
    { hz: 60, frames: [5, 9, 13, 17, 21, 26, 30, 34, 38, 42, 47, 51, 55, 59] },
  ])("matches the recorded old non-whole-frame schedule at $hz Hz", ({ hz, frames }) => {
    // Recorded using the pre-fix accumulator >= 70 / subtract 70 rule.
    const source = new IntervalTickSource(0.07);
    const actual: number[] = [];
    for (let frame = 1; frame <= 60; frame++) {
      if (source._evalTick(1000 / hz, frame)) {
        actual.push(frame);
      }
    }
    expect(actual).toEqual(frames);
  });

  it("clamps tolerated negative residue instead of accumulating an early-fire debt", () => {
    const source = new IntervalTickSource(1);
    let count = 0;
    for (let frame = 1; frame <= 100_000; frame++) {
      if (source._evalTick(1000 - 0.0000005, frame)) {
        count++;
      }
    }
    expect(count).toBe(100_000);
    expect(source.lastFireDelta).toBe(1000 - 0.0000005);
  });

  it("does not fire before the relative tolerance window", () => {
    const source = new IntervalTickSource(1);
    expect(source._evalTick(1000 - 0.000002, 1)).toBe(false);
    expect(source._evalTick(0.000002, 2)).toBe(true);
    expect(source.lastFireDelta).toBe(1000);
  });

  it("fires only once per frame for large deltas and preserves positive backlog", () => {
    const source = new IntervalTickSource(1);
    expect(source._evalTick(3500, 1)).toBe(true);
    expect(source.lastFireDelta).toBe(3500);
    expect(source._evalTick(3500, 1)).toBe(true); // Memoized, not another subtraction.
    expect(source._evalTick(0, 2)).toBe(true);
    expect(source._evalTick(0, 3)).toBe(true);
    expect(source._evalTick(0, 4)).toBe(false);
    expect(source._evalTick(500, 5)).toBe(true);
    expect(source.lastFireDelta).toBe(500);
  });

  it("system.interval fires on accumulated milliseconds and preserves drift", () => {
    const { world, tick } = setup();
    const cb = vi.fn();
    world.system("slow").interval(1).run(cb);

    tick(1500, 1500);
    tick(2000, 500);

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls.map((call) => call[1])).toEqual([1500, 500]);
  });

  it("system.rate alone counts frames", () => {
    const { world, tick } = setup();
    const cb = vi.fn();
    world.system("every-other").rate(2).run(cb);

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
    world.system("slow").with(Position).interval(1).enter(enter);

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
    const a = makePhase(world, "a");
    const b = makePhase(world, "b");
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

    tick(1000, 1000);

    expect(source.evalCount).toBe(1);
  });
});
