import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  Circle,
  LinearVelocity,
  PhysicsModule,
  Position,
  Rotation,
} from "../../src/index.js";
import { getPhysicsEngine } from "../../src/adapter/engine.js";

describe("pose output after wasm memory growth", () => {
  it("refreshes previously used views between steps and preserves exact pose and velocity", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: -3 }, enableSleep: false });
    const engine = getPhysicsEngine(world);
    const bodies = [0, 1, 2].map((i) => {
      const body = world
        .entity()
        .set(Body, { type: BodyType.Dynamic })
        .set(Position, { x: i * 10, y: 5 + i })
        .set(Rotation, { angle: 0.2 + i * 0.1 })
        .set(LinearVelocity, { x: 1 + i, y: -0.25 })
        .set(AngularVelocity, { value: 0.5 + i });
      world.entity().childOf(body).set(Circle, { radius: 0.25 });
      return body;
    });
    const dt = 1000 / 60;
    world.progress(0, dt);
    const oldView = engine.fast.f32;
    const oldBuffer = engine.fast.memory.buffer;
    // Allocate more than the entire existing heap through Emscripten, so its own heap views
    // are updated too. The adapter's views remain stale until the following export/sync.
    const allocation = engine.box2d._malloc(oldBuffer.byteLength + 65536);
    try {
      expect(allocation).not.toBe(0);
      expect(engine.fast.memory.buffer).not.toBe(oldBuffer);
      expect(engine.fast.f32).toBe(oldView);
      for (let tick = 1; tick <= 3; tick++) {
        world.progress(tick * dt, dt);
        expect(engine.fast.f32.buffer).toBe(engine.fast.memory.buffer);
        // Compare identity as a boolean: Vitest's diagnostics cannot inspect a detached view.
        expect(engine.fast.f32 === oldView).toBe(false);
        for (const entity of bodies) {
          const id = entity.get(Body)!._bodyId!;
          const position = engine.box2d.b2Body_GetPosition(id);
          const rotation = engine.box2d.b2Body_GetRotation(id);
          const velocity = engine.box2d.b2Body_GetLinearVelocity(id);
          try {
            expect(entity.get(Position)).toMatchObject({ x: position.x, y: position.y });
            expect(entity.get(Rotation)!.angle).toBe(rotation.GetAngle());
            expect(entity.get(LinearVelocity)).toMatchObject({ x: velocity.x, y: velocity.y });
            expect(entity.get(AngularVelocity)!.value).toBe(
              engine.box2d.b2Body_GetAngularVelocity(id)
            );
          } finally {
            position.delete();
            rotation.delete();
            velocity.delete();
          }
        }
      }
    } finally {
      engine.box2d._free(allocation);
      world.dispose();
    }
  });
});
