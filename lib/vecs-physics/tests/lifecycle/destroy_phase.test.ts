import { insertPhaseAfter, ON_UPDATE, Phase, World, type Entity } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  LinearVelocity,
  Material,
  PhysicsModule,
  Position,
  SensorEvents,
  physics,
} from "../../src/index.js";
import { getPhysicsEngine } from "../../src/adapter/engine.js";

const timings = [
  "default",
  "pre-before",
  "pre-after",
  "between",
  "post-before",
  "post-after",
] as const;

describe("destroying a moving body from the pipeline", () => {
  it.each(timings)("is safe from %s", (timing) => {
    const world = new World();
    let doomed: Entity | undefined;
    let destroy = false;
    const register = (phase: Entity) =>
      world
        .system("DestroyMovingBody")
        .phase(phase)
        .run(() => {
          if (destroy) {
            doomed!.destroy();
            destroy = false;
          }
        });
    // Register on either side of the physics systems without moving those systems.
    if (timing === "pre-before" || timing === "post-before") {
      register(world.entity(timing === "pre-before" ? "physics-pre" : "physics-post").add(Phase));
    }
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const engine = getPhysicsEngine(world);
    if (timing === "default") {
      register(world.entity(ON_UPDATE));
    }
    if (timing === "pre-after") {
      register(engine.phases.preStep);
    }
    if (timing === "post-after") {
      register(engine.phases.postStep);
    }
    if (timing === "between") {
      // The public insertion helper puts this phase after preStep and ahead of cleanup.
      register(
        insertPhaseAfter(world.entity("user-before-step").add(Phase), engine.phases.preStep)
      );
    }

    doomed = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 6, y: 0 });
    world
      .entity()
      .childOf(doomed)
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(Material, { density: 1 })
      .add(SensorEvents);
    const survivor = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 1.25, y: 0 })
      .set(LinearVelocity, { x: -6, y: 0 });
    world.entity().childOf(survivor).set(Box, { hx: 0.5, hy: 0.5 }).set(Material, { density: 1 });
    world.progress(0, 1000 / 60);
    survivor.set(Position, { x: 0.9, y: 0 });
    const bodyId = doomed.get(Body)!._bodyId!;
    expect(engine.box2d.b2Body_IsValid(bodyId)).toBe(true);
    destroy = true;
    expect(() => world.progress(1000 / 60, 1000 / 60)).not.toThrow();
    expect(world.getEntity(doomed.eid)).toBeUndefined();
    const beforeStep = !timing.startsWith("post");
    if (beforeStep) {
      expect(engine.box2d.b2Body_IsValid(bodyId)).toBe(false);
      expect(survivor.get(LinearVelocity)!.x).toBeCloseTo(-6, 5);
      expect(survivor.get(LinearVelocity)!.y).toBeCloseTo(0, 5);
    }
    expect(() => world.progress(2000 / 60, 1000 / 60)).not.toThrow();
    expect(engine.box2d.b2Body_IsValid(bodyId)).toBe(false);
    expect(engine.entityByBodyIndex.get(bodyId.index1)).toBeUndefined();
    expect(engine.entityByShapeIndex.size).toBe(1);
    expect(physics(world).stats().bodyCount).toBe(1);
    expect(physics(world).stats().shapeCount).toBe(1);
  });

  it("the collision fixture changes velocity if both bodies survive", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    for (const [x, vx] of [
      [0, 6],
      [1.25, -6],
    ]) {
      const body = world
        .entity()
        .set(Body, { type: BodyType.Dynamic })
        .set(Position, { x, y: 0 })
        .set(LinearVelocity, { x: vx, y: 0 });
      world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 }).set(Material, { density: 1 });
    }
    world.progress(0, 1000 / 60);
    world.filter({ all: [Body, Position] }).forEach([Position], (entity, [position]) => {
      if (position.x > 1) {
        entity.set(Position, { x: 0.9, y: 0 });
      }
    });
    world.progress(1000 / 60, 1000 / 60);
    world
      .filter({ all: [Body, LinearVelocity] })
      .forEach([LinearVelocity], (_entity, [velocity]) => {
        expect(Math.abs(velocity.x)).toBeLessThan(6);
      });
  });

  it("reaps a late destroy with custom phase names", () => {
    const world = new World();
    world.module(PhysicsModule, {
      preStepPhase: "prepare",
      stepPhase: "integrate",
      postStepPhase: "publish",
    });
    const engine = getPhysicsEngine(world);
    const body = world.entity().set(Body, { type: BodyType.Dynamic }).set(LinearVelocity, { x: 1 });
    world.progress(0, 1000 / 60);
    const bodyId = body.get(Body)!._bodyId!;
    world
      .system("DestroyLate")
      .phase(engine.phases.preStep)
      .run(() => body.destroy());
    expect(() => world.progress(1000 / 60, 1000 / 60)).not.toThrow();
    expect(engine.box2d.b2Body_IsValid(bodyId)).toBe(false);
    expect(engine.entityByBodyIndex.size).toBe(0);
  });

  it("recomputes mass after a late shape removal, before the step", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 } });
    const engine = getPhysicsEngine(world);
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    const removed = world
      .entity()
      .childOf(body)
      .set(Box, { hx: 0.5, hy: 0.5 })
      .set(Material, { density: 1 });
    world.entity().childOf(body).set(Box, { hx: 0.5, hy: 0.5 }).set(Material, { density: 1 });
    world.progress(0, 1000 / 60);
    const bodyId = body.get(Body)!._bodyId!;
    expect(engine.box2d.b2Body_GetMass(bodyId)).toBeCloseTo(2);
    world
      .system("RemoveLateShape")
      .phase(engine.phases.preStep)
      .run(() => removed.destroy());
    world
      .system("CheckMassBeforeStep")
      .phase(engine.phases.cleanup)
      .run(() => {
        expect(engine.box2d.b2Body_GetMass(bodyId)).toBeCloseTo(1);
      });
    world.progress(1000 / 60, 1000 / 60);
    expect(physics(world).stats().shapeCount).toBe(1);
  });
});
