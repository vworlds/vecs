import { type Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import { AngularVelocity, LinearVelocity, Position, Rotation } from "../../src/index.js";
import { buildFuzzScene } from "./scene.js";

const SEEDS = [1, 2, 3, 5, 8, 13, 42, 1337, 65537, 3735928559];
const STEPS = 300;
const STEP_MS = 1000 / 60;
const MAX_SINGLE_STEP_MS = 5000;

describe("seeded physics fuzz harness", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed} steps without non-finite body state or hangs`, () => {
      const scene = buildFuzzScene(seed);
      let now = 0;

      for (let step = 0; step < STEPS; step++) {
        scene.driveStep(step);
        now += STEP_MS;

        const startedAt = performance.now();
        scene.world.progress(now, STEP_MS);
        const elapsed = performance.now() - startedAt;
        expect(elapsed).toBeLessThan(MAX_SINGLE_STEP_MS);

        assertFiniteBodies(scene.bodies);
      }
    });
  }
});

function assertFiniteBodies(bodies: readonly Entity[]): void {
  for (const body of bodies) {
    const position = body.get(Position);
    if (position !== undefined) {
      expectFinite(position.x);
      expectFinite(position.y);
    }

    const rotation = body.get(Rotation);
    if (rotation !== undefined) {
      expectFinite(rotation.angle);
    }

    const linearVelocity = body.get(LinearVelocity);
    if (linearVelocity !== undefined) {
      expectFinite(linearVelocity.x);
      expectFinite(linearVelocity.y);
    }

    const angularVelocity = body.get(AngularVelocity);
    if (angularVelocity !== undefined) {
      expectFinite(angularVelocity.value);
    }
  }
}

function expectFinite(value: number): void {
  expect(Number.isFinite(value)).toBe(true);
}
