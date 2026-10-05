import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  Box,
  LinearVelocity,
  PhysicsModule,
  Position,
  Rotation,
} from "../../src/index.js";

const TICKS = 120;
const DT_MS = 1000 / 60;

// Recorded from the unmodified pose-out implementation (before handle churn was removed).
const EXPECTED_CHECKSUM = "ce55623b";

// FNV-1a over the IEEE-754 bit patterns, so any single-bit drift changes the result.
function checksumScene(): string {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: -3 } });

  const bodies = [];
  for (let i = 0; i < 6; i++) {
    bodies.push(
      world
        .entity()
        .set(Body, { type: BodyType.Dynamic })
        .set(Position, { x: i * 1.5 - 4, y: 2 + (i % 3) })
        .set(Rotation, { angle: i * 0.3 })
        .set(LinearVelocity, { x: 1 + i * 0.7, y: i % 2 === 0 ? 2.5 : -1.5 })
        .set(AngularVelocity, { value: (i - 2) * 1.3 })
        .set(Box, { width: 1, height: 0.6 })
    );
  }
  world
    .entity()
    .set(Body, { type: BodyType.Static })
    .set(Position, { x: 0, y: -2 })
    .set(Box, { width: 40, height: 1 });

  const view = new DataView(new ArrayBuffer(8));
  let hash = 0x811c9dc5;
  const mix = (value: number): void => {
    view.setFloat64(0, value);
    for (let i = 0; i < 8; i++) {
      hash = Math.imul(hash ^ view.getUint8(i), 0x01000193) >>> 0;
    }
  };

  for (let tick = 0; tick < TICKS; tick++) {
    world.progress(tick * DT_MS, DT_MS);
    for (const entity of bodies) {
      const position = entity.get(Position)!;
      mix(position.x);
      mix(position.y);
      mix(entity.get(Rotation)!.angle);
      const linear = entity.get(LinearVelocity)!;
      mix(linear.x);
      mix(linear.y);
      mix(entity.get(AngularVelocity)!.value);
    }
  }
  return hash.toString(16);
}

describe("PhysicsPoseSyncOut checksum", () => {
  it("writes bit-identical Position, Rotation and velocities for a fixed scene", () => {
    expect(checksumScene()).toBe(EXPECTED_CHECKSUM);
  });
});
