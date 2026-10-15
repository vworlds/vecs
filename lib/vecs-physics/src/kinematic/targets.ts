import { Module } from "@vworlds/vecs";

import {
  getPhysicsEngine,
  PhysicsSystemTag,
  type b2BodyId,
  type PhysicsEngine,
} from "../adapter/engine.js";
import { Body } from "../body/components.js";
import { KinematicTargetPosition, KinematicTargetRotation } from "./components.js";
import { rev, scr_fastOut } from "../adapter/runtime.js";
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

  const fast = engine.fast;
  fast.module._b2x_Body_GetPosition(bodyId.index1, rev(bodyId), scr_fastOut);
  fast.sync();
  const out = scr_fastOut >> 2;
  const px = fast.f32[out]!;
  const py = fast.f32[out + 1]!;
  const dx = target.x - px;
  const dy = target.y - py;
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
      fast.module._b2x_Body_SetAwake(bodyId.index1, rev(bodyId), 1);
    }
  } else {
    setLinearVelocity(engine, bodyId, 0, 0);
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

  const fast = engine.fast;
  const r = rev(bodyId);
  fast.module._b2x_Body_GetPose(bodyId.index1, r, scr_fastOut);
  fast.sync();
  // The exact Box2D b2Atan2 result used by embind's GetAngle.
  const angle = fast.f32[(scr_fastOut + fast.layout.pose.angle) >> 2]!;
  const da = wrap(target.angle - angle, -Math.PI, Math.PI);
  if (Math.abs(da) > target.tolerance) {
    fast.module._b2x_Body_SetAngularVelocity(bodyId.index1, r, da / dt);
    if (target.wake) {
      fast.module._b2x_Body_SetAwake(bodyId.index1, r, 1);
    }
  } else {
    fast.module._b2x_Body_SetAngularVelocity(bodyId.index1, r, 0);
  }
}

function isKinematicBody(engine: PhysicsEngine, bodyId: b2BodyId): boolean {
  return (
    engine.fast.module._b2x_Body_GetType(bodyId.index1, rev(bodyId)) ===
    engine.box2d.b2BodyType.b2_kinematicBody.value
  );
}

function setLinearVelocity(engine: PhysicsEngine, bodyId: b2BodyId, x: number, y: number): void {
  engine.fast.module._b2x_Body_SetLinearVelocity(bodyId.index1, rev(bodyId), x, y);
}

function wrap(value: number, min: number, max: number): number {
  const range = max - min;
  return ((((value - min) % range) + range) % range) + min;
}
