import { ClientWorld } from "@vworlds/vecs-client";
import {
  Motion,
  MotionClock,
  Position,
  Rotation,
  phaserMotionComponents,
  phaserNetworkComponents,
} from "@vworlds/vecs-phaser";
import { expect, test, vi } from "vitest";

import type { DeadReckonedModuleConfig } from "../src/headless.js";

vi.mock("phaser", () => {
  throw new Error("phaser must not load");
});

test("the headless entry loads without Phaser and supplies a dead-reckoned client pose", async () => {
  const headless = await import("../src/headless.js");
  expect(Object.keys(headless).sort()).toEqual([
    "DeadReckonedModule",
    "phaserInterpolators",
    "rotationInterpolator",
  ]);
  const config: DeadReckonedModuleConfig = { blendMs: 0 };
  const world = new ClientWorld({
    networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
    interpolators: headless.phaserInterpolators(),
  });
  world.module(headless.DeadReckonedModule, config);
  world.entity().set(MotionClock, { stepSeconds: 1 / 30 });
  const body = world.entity().set(Motion, { frame: 0, x: 3, y: 4, angle: 0.5, rest: true });
  world.progress(0, 16);
  expect(body.get(Position)).toMatchObject({ x: 3, y: 4 });
  expect(body.get(Rotation)).toMatchObject({ angle: 0.5 });
  world.dispose();
});
