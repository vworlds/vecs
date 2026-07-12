import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { Lifetime, LifetimeModule } from "../src/index.js";

describe("LifetimeModule", () => {
  it("destroys an entity when its lifetime runs out (deltas in ms)", () => {
    const world = new World();
    world.module(LifetimeModule);
    const entity = world.entity().set(Lifetime, { seconds: 0.1 });

    world.progress(0, 50);
    expect(entity.alive).toBe(true);

    world.progress(50, 60);
    expect(entity.alive).toBe(false);
  });

  it("leaves entities without Lifetime alone and supports many countdowns", () => {
    const world = new World();
    world.module(LifetimeModule);
    const eternal = world.entity();
    const quick = world.entity().set(Lifetime, { seconds: 0.01 });
    const slow = world.entity().set(Lifetime, { seconds: 10 });

    world.progress(0, 16);

    expect(eternal.alive).toBe(true);
    expect(quick.alive).toBe(false);
    expect(slow.alive).toBe(true);
    expect(slow.get(Lifetime)!.seconds).toBeCloseTo(9.984);
  });
});
