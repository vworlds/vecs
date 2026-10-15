import { World } from "@vworlds/vecs";
import { describe, expect, it, vi } from "vitest";

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
import { getPhysicsEngine } from "../../src/adapter/engine.js";

describe("PhysicsPoseSyncOut fast path", () => {
  it("preserves absent optional components on a position-only body", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: -3 }, enableSleep: false });
    const entity = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { y: 5 });
    world.entity().childOf(entity).set(Box, { width: 1, height: 1 });
    world.progress(0, 16);
    const box2d = getPhysicsEngine(world).box2d;
    const rotation = vi.spyOn(box2d, "b2Body_GetRotation");
    const linear = vi.spyOn(box2d, "b2Body_GetLinearVelocity");
    const angular = vi.spyOn(box2d, "b2Body_GetAngularVelocity");
    try {
      world.progress(16, 16);
      expect(entity.get(Position)!.y).toBeLessThan(5);
      expect(entity.has(Rotation)).toBe(false);
      expect(entity.has(LinearVelocity)).toBe(false);
      expect(entity.has(AngularVelocity)).toBe(false);
      expect(rotation).not.toHaveBeenCalled();
      expect(linear).not.toHaveBeenCalled();
      expect(angular).not.toHaveBeenCalled();
    } finally {
      rotation.mockRestore();
      linear.mockRestore();
      angular.mockRestore();
      world.dispose();
    }
  });

  it("exports moves in one crossing per step without embind handles", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: -3 } });
    const engine = getPhysicsEngine(world);
    const bodies = [];
    for (let i = 0; i < 4; i++) {
      bodies.push(
        world
          .entity()
          .set(Body, { type: BodyType.Dynamic })
          .set(Position, { x: i * 2, y: 5 })
          .set(Rotation, { angle: 0.2 })
          .set(LinearVelocity, { x: 1, y: 1 })
          .set(AngularVelocity, { value: 1 })
          .set(Box, { width: 1, height: 1 })
      );
    }
    world.progress(0, 16);
    const names = [
      "b2World_GetBodyEvents",
      "b2Body_GetLinearVelocity",
      "b2Body_GetAngularVelocity",
      "b2Body_GetPosition",
      "b2Body_GetRotation",
    ] as const;
    const spies = names.map((name) => vi.spyOn(engine.box2d, name));
    const exported = vi.spyOn(engine.box2d, "_b2x_World_ExportMoves");
    try {
      const ticks = 5;
      for (let tick = 1; tick <= ticks; tick++) {
        world.progress(tick * 16, 16);
      }
      expect(exported).toHaveBeenCalledTimes(ticks);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      for (const entity of bodies) {
        const bodyId = entity.get(Body)!._bodyId!;
        const p = engine.box2d.b2Body_GetPosition(bodyId);
        const q = engine.box2d.b2Body_GetRotation(bodyId);
        const v = engine.box2d.b2Body_GetLinearVelocity(bodyId);
        try {
          expect(entity.get(Position)).toMatchObject({ x: p.x, y: p.y });
          expect(entity.get(Rotation)!.angle).toBe(q.GetAngle());
          expect(entity.get(LinearVelocity)).toMatchObject({ x: v.x, y: v.y });
          expect(entity.get(AngularVelocity)!.value).toBe(
            engine.box2d.b2Body_GetAngularVelocity(bodyId)
          );
        } finally {
          p.delete();
          q.delete();
          v.delete();
        }
      }
    } finally {
      exported.mockRestore();
      for (const spy of spies) {
        spy.mockRestore();
      }
      world.dispose();
    }
  });
});
