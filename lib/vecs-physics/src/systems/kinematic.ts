import { type Entity, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { KinematicTargetPosition, KinematicTargetRotation } from "../components/target.js";
import { type PhysicsState, type b2BodyId } from "../adapter/state.js";

export function installKinematicTargets(world: World, state: PhysicsState, phase: Entity): System {
  const targetFilter = world.filter({
    all: [Body, { any: [KinematicTargetPosition, KinematicTargetRotation] }],
  });

  return world
    .system("PhysicsKinematicTargets")
    .phase(phase)
    .run(() => {
      const dt = state.fixedTimeStep;
      if (dt <= 0) {
        return;
      }

      targetFilter.forEach((entity) => {
        const bodyId = state.bodyByEntityWasm.get(entity.eid);
        if (bodyId === undefined || !isKinematicBody(state, bodyId)) {
          return;
        }

        drivePositionTarget(state, bodyId, entity.get(KinematicTargetPosition), dt);
        driveRotationTarget(state, bodyId, entity.get(KinematicTargetRotation), dt);
      });
    });
}

function drivePositionTarget(
  state: PhysicsState,
  bodyId: b2BodyId,
  target: KinematicTargetPosition | undefined,
  dt: number
): void {
  if (target === undefined) {
    return;
  }

  const position = state.box2d.b2Body_GetPosition(bodyId);
  try {
    const dx = target.x - position.x;
    const dy = target.y - position.y;
    const dist = Math.hypot(dx, dy);
    if (dist > target.tolerance) {
      let vx = dx / dt;
      let vy = dy / dt;
      const speed = Math.hypot(vx, vy);
      if (speed > state.maximumLinearSpeed) {
        const scale = state.maximumLinearSpeed / speed;
        vx *= scale;
        vy *= scale;
      }
      setLinearVelocity(state, bodyId, vx, vy);
      if (target.wake) {
        state.box2d.b2Body_SetAwake(bodyId, true);
      }
    } else {
      setLinearVelocity(state, bodyId, 0, 0);
    }
  } finally {
    position.delete();
  }
}

function driveRotationTarget(
  state: PhysicsState,
  bodyId: b2BodyId,
  target: KinematicTargetRotation | undefined,
  dt: number
): void {
  if (target === undefined) {
    return;
  }

  const rotation = state.box2d.b2Body_GetRotation(bodyId);
  try {
    const da = wrap(target.angle - rotation.GetAngle(), -Math.PI, Math.PI);
    if (Math.abs(da) > target.tolerance) {
      state.box2d.b2Body_SetAngularVelocity(bodyId, da / dt);
      if (target.wake) {
        state.box2d.b2Body_SetAwake(bodyId, true);
      }
    } else {
      state.box2d.b2Body_SetAngularVelocity(bodyId, 0);
    }
  } finally {
    rotation.delete();
  }
}

function isKinematicBody(state: PhysicsState, bodyId: b2BodyId): boolean {
  return state.box2d.b2Body_GetType(bodyId) === state.box2d.b2BodyType.b2_kinematicBody;
}

function setLinearVelocity(state: PhysicsState, bodyId: b2BodyId, x: number, y: number): void {
  state.scratchVec2.Set(x, y);
  state.box2d.b2Body_SetLinearVelocity(bodyId, state.scratchVec2);
}

function wrap(value: number, min: number, max: number): number {
  const range = max - min;
  return ((((value - min) % range) + range) % range) + min;
}
