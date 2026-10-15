import { beforeAll, expect, it } from "vitest";
import { preloadPhysics } from "@vworlds/vecs-physics";
import { characterize, matrix } from "./harness/render_clock.js";

beforeAll(async () => {
  await preloadPhysics();
});

it("characterizes a small deterministic smoke subset against independent physics truth", () => {
  const scenario = {
    k: 1,
    link: "clean",
    rtt: 100,
    hz: 60,
    pause: 0,
    gate: true,
    scene: "mixed",
    duration: 5_000,
  } as const;
  const first = characterize(scenario);
  expect(characterize(scenario)).toEqual(first);
  expect(first.errors).toEqual([]);
  expect(first.disconnects).toEqual([]);
  expect(first.pose.dr.count).toBeGreaterThan(100);
  expect(first.pose.dr.max).toBeLessThan(0.001);
  expect(first.pose.streamed.max).toBeLessThan(0.001);
  expect(first.packetsPerSecond).toBeCloseTo(30, 0);
});

it("measures sparse-clock cap holds even when the pose matches rendered-time truth", () => {
  const result = characterize({
    k: 8,
    link: "clean",
    rtt: 100,
    hz: 60,
    pause: 0,
    gate: true,
    scene: "drift",
    duration: 5_000,
  });
  expect(result.errors).toEqual([]);
  expect(result.disconnects).toEqual([]);
  expect(result.holds.length).toBeGreaterThan(5);
  expect(result.holds.every((hold) => hold.atCap)).toBe(true);
  expect(result.pose.dr.max).toBeLessThan(0.001);
  expect(result.packetsPerSecond).toBeLessThan(4);
});

it.skipIf(process.env.RUN_RENDER_CLOCK_MATRIX !== "1")(
  "prints the opt-in seeded characterization matrix",
  () => {
    for (const scenario of matrix()) {
      if (scenario.k !== Number(process.env.RENDER_CLOCK_K)) {
        continue;
      }
      const result = characterize(scenario);
      console.log("RENDER_CLOCK_RESULT", JSON.stringify(result));
      expect(result.errors).toEqual([]);
      expect(result.disconnects).toEqual([]);
      expect(result.pose.dr.count).toBe(result.samples);
      if (scenario.scene === "mixed") {
        expect(result.pose.streamed.count).toBe(result.samples);
      }
    }
  },
  120_000
);
