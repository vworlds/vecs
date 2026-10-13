import { Module, type World } from "@vworlds/vecs";

import {
  getPhysicsEngine,
  PhysicsSystemTag,
  type b2BodyId,
  type PhysicsEngine,
} from "../adapter/engine.js";
import { scr_b2MassData } from "../adapter/runtime.js";
import { PhysicsCoreModule } from "../core/module.js";
import { Body, BodyType } from "./components.js";

const CODE_DYNAMIC_BODY_WITHOUT_DENSITY = "dynamic-body-without-density";

// Real Box2D measurements (#259), unchanged on the owned 6.0.1 package: centered boxes (half extents
// 0.01–100 m, including non-square), a rounded box, circle, capsule, regular
// hexagon, and symmetric boxes had |center| / AABB half-extent <= 1.35e-7.
// 8 * epsilon_f32 gives ~7x headroom over that peak (~9.54e-7 relative).
// For the 0.3 x 0.7 m box this is 6.87e-7 m, >1,400x below a 1e-3 m
// intentional offset. Extent includes Box2D's speculative AABB padding.
const CENTER_NOISE_RELATIVE = 8 * 2 ** -23;

export class BodyMassModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    // The reaper must remove queued shapes before we compute the surviving mass.
    world
      .system("PhysicsMassRecompute")
      .phase(engine.phases.cleanup)
      .run(() => {
        for (const eid of engine.dirtyMassBodies) {
          const bodyId = world.getEntity(eid)?.get(Body)?._bodyId;
          if (bodyId !== undefined) {
            engine.box2d.b2Body_ApplyMassFromShapes(bodyId);
            correctMassCenter(engine, bodyId);
          }
        }
        engine.dirtyMassBodies.clear();

        if (engine.debug) {
          warnOnMasslessDynamicBodies(world, engine);
        }
      })
      .add(PhysicsSystemTag);
  }
}

function correctMassCenter(engine: PhysicsEngine, bodyId: b2BodyId): void {
  const { box2d } = engine;
  // Vecs exposes shape-derived mass only; there is no explicit mass-data API
  // to override. This correction belongs exclusively to that recompute path.
  const data = box2d.b2Body_GetMassData(bodyId);
  try {
    const center = data.center;
    const x = center.x;
    const y = center.y;
    if (data.mass <= 0 || (x === 0 && y === 0)) {
      return;
    }
    const bounds = box2d.b2Body_ComputeAABB(bodyId);
    let extent: number;
    try {
      const lower = bounds.lowerBound;
      const upper = bounds.upperBound;
      extent = Math.max(upper.x - lower.x, upper.y - lower.y) * 0.5;
      // These property wrappers borrow fields owned by bounds, not new structs.
    } finally {
      bounds.delete();
    }
    const tolerance = CENTER_NOISE_RELATIVE * extent;
    if (x * x + y * y <= tolerance * tolerance) {
      const exact = scr_b2MassData!;
      exact.mass = data.mass;
      exact.rotationalInertia = data.rotationalInertia;
      box2d.b2Body_SetMassData(bodyId, exact);
    }
  } finally {
    data.delete();
  }
}

function warnOnMasslessDynamicBodies(world: World, engine: PhysicsEngine): void {
  world.filter(Body).forEach([Body], (entity, [body]) => {
    const eid = entity.eid;
    const bodyId = body._bodyId;
    if (body.type !== BodyType.Dynamic || bodyId === undefined) {
      engine.warn.rearm(eid, CODE_DYNAMIC_BODY_WITHOUT_DENSITY);
      return;
    }

    if (engine.box2d.b2Body_GetMass(bodyId) === 0) {
      engine.warn.warnOnce(
        eid,
        CODE_DYNAMIC_BODY_WITHOUT_DENSITY,
        `Entity${eid} is a dynamic body with zero mass after recompute; it will not fall.`
      );
    } else {
      engine.warn.rearm(eid, CODE_DYNAMIC_BODY_WITHOUT_DENSITY);
    }
  });
}
