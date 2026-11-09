import { describe, expect, it } from "vitest";
import { RateTickSource, World } from "../src/index.js";

describe("per-world always tick source", () => {
  it("gives each world its own every-frame clock", () => {
    const a = new World();
    const b = new World();
    expect(a.alwaysTickSource).not.toBe(b.alwaysTickSource);
    const s = a.system("s");
    expect(s.hasDefaultCadence).toBe(true);
    expect(s.cadence).toBe(s.world.alwaysTickSource);
    a.progress(0, 5);
    b.progress(0, 9);
    expect(a.alwaysTickSource.didTick).toBe(true);
    expect(a.alwaysTickSource.lastFireDelta).toBe(5);
    expect(b.alwaysTickSource.lastFireDelta).toBe(9);
  });

  it("reports the exact world clock from a standalone rate source", () => {
    const world = new World();
    const rate = new RateTickSource(1, world.alwaysTickSource);
    expect(rate.source).toBe(world.alwaysTickSource);
  });

  it("keeps deltas separate when world B is stepped inside a system of world A", () => {
    const a = new World();
    const b = new World();
    const seen: string[] = [];
    a.system("a-first").run((_now, delta) => seen.push(`a-first:${delta}`));
    a.system("a-driver").run(() => b.progress(0, 7));
    a.system("a-last").run((_now, delta) => seen.push(`a-last:${delta}`));
    b.system("b-sys").run((_now, delta) => seen.push(`b:${delta}`));
    a.progress(0, 100);
    expect(seen).toEqual(["a-first:100", "b:7", "a-last:100"]);
    expect(a.alwaysTickSource).not.toBe(b.alwaysTickSource);
    expect(a.pipeline.every((system) => system.cadence === a.alwaysTickSource)).toBe(true);
    expect(b.pipeline.every((system) => system.cadence === b.alwaysTickSource)).toBe(true);
    expect(a.alwaysTickSource.lastFireDelta).toBe(100);
    expect(b.alwaysTickSource.lastFireDelta).toBe(7);
  });
});
