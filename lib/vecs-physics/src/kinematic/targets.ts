import { Module } from "@vworlds/vecs";

import {
  getPhysicsEngine,
  PhysicsSystemTag,
  type b2BodyId,
  type PhysicsEngine,
} from "../adapter/engine.js";
import { Body } from "../body/components.js";
import { KinematicTargetPosition, KinematicTargetRotation } from "./components.js";
import { scr_b2Vec2 } from "../adapter/runtime.js";
import { PhysicsCoreModule } from "../core/module.js";

export class KinematicTargetsModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    const dt = engine.fixedTimeStep;
    if (dt <= 0) {
      return;
    }

    world
      .system("PhysicsKinematicTargets")
      .with({ all: [Body, { any: [KinematicTargetPosition, KinematicTargetRotation] }] })
      .phase(engine.phases.preStep)
      .each(
        [Body, KinematicTargetPosition, KinematicTargetRotation],
        (_entity, [body, positionTarget, rotationTarget]) => {
          const bodyId = body._bodyId;
          if (bodyId === undefined || !isKinematicBody(engine, bodyId)) {
            return;
          }

          drivePositionTarget(engine, bodyId, positionTarget, dt);
          driveRotationTarget(engine, bodyId, rotationTarget, dt);
        }
      )
      .add(PhysicsSystemTag);
  }
}

function drivePositionTarget(
  engine: PhysicsEngine,
  bodyId: b2BodyId,
  target: KinematicTargetPosition | undefined,
  dt: number
): void {
  if (target === undefined) {
    return;
  }

  const position = engine.box2d.b2Body_GetPosition(bodyId);
  try {
    const dx = target.x - position.x;
    const dy = target.y - position.y;
    const dist = Math.hypot(dx, dy);
    if (dist > target.tolerance) {
      let vx = dx / dt;
      let vy = dy / dt;
      const speed = Math.hypot(vx, vy);
      if (speed > engine.maximumLinearSpeed) {
        const scale = engine.maximumLinearSpeed / speed;
        vx *= scale;
        vy *= scale;
      }
      setLinearVelocity(engine, bodyId, vx, vy);
      if (target.wake) {
        engine.box2d.b2Body_SetAwake(bodyId, true);
      }
    } else {
      setLinearVelocity(engine, bodyId, 0, 0);
    }
  } finally {
    position.delete();
  }
}

function driveRotationTarget(
  engine: PhysicsEngine,
  bodyId: b2BodyId,
  target: KinematicTargetRotation | undefined,
  dt: number
): void {
  if (target === undefined) {
    return;
  }

  const rotation = engine.box2d.b2Body_GetRotation(bodyId);
  try {
    const da = wrap(target.angle - rotation.GetAngle(), -Math.PI, Math.PI);
    if (Math.abs(da) > target.tolerance) {
      engine.box2d.b2Body_SetAngularVelocity(bodyId, da / dt);
      if (target.wake) {
        engine.box2d.b2Body_SetAwake(bodyId, true);
      }
    } else {
      engine.box2d.b2Body_SetAngularVelocity(bodyId, 0);
    }
  } finally {
    rotation.delete();
  }
}

function isKinematicBody(engine: PhysicsEngine, bodyId: b2BodyId): boolean {
  return engine.box2d.b2Body_GetType(bodyId) === engine.box2d.b2BodyType.b2_kinematicBody;
}

function setLinearVelocity(engine: PhysicsEngine, bodyId: b2BodyId, x: number, y: number): void {
  const vec = scr_b2Vec2[0];
  vec.Set(x, y);
  engine.box2d.b2Body_SetLinearVelocity(bodyId, vec);
}

function wrap(value: number, min: number, max: number): number {
  const range = max - min;
  return ((((value - min) % range) + range) % range) + min;
}
