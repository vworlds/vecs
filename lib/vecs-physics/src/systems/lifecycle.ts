import { type Entity, type System, type World } from "@vworlds/vecs";

import {
  AngularVelocity,
  Body,
  BodyType,
  LinearVelocity,
  Position,
  Rotation,
} from "../components/body.js";
import { Damping, GravityScale, MotionLocks, Sleep } from "../components/body_tuning.js";
import { type Box2DModule } from "../adapter/runtime.js";
import { type b2BodyId, type PhysicsState } from "../adapter/state.js";
import { withAllocated } from "../adapter/disposal.js";

export function installBodyLifecycle(world: World, state: PhysicsState, phase: Entity): System {
  const system = world.system("PhysicsBodyLifecycle").with(Body).phase(phase);

  system.enter((entity) => {
    const body = entity.get(Body) as Body;
    const bodyId = createWasmBodyId(state, entity, body);
    body._bodyId = bodyId;
    state.entityByBodyIndex.set(bodyId.index1, entity.eid);
  });

  // Inject `[Body]` so the handle survives the post-`_destroy` snapshot -- by
  // the time the exit callback runs (next tick's inbox drain), `entity.get(Body)`
  // would return `undefined`.
  system.exit([Body], (entity, [body]) => {
    const bodyId = body?._bodyId;
    if (bodyId === undefined) {
      return;
    }
    state.box2d.b2DestroyBody(bodyId);
    state.entityByBodyIndex.delete(bodyId.index1);
  });

  system.update(Body, (entity, body) => {
    const bodyId = body._bodyId;
    if (bodyId === undefined) {
      return;
    }
    state.box2d.b2Body_SetType(bodyId, bodyTypeToBox2D(state.box2d, body.type));
    if (body.enabled) {
      state.box2d.b2Body_Enable(bodyId);
    } else {
      state.box2d.b2Body_Disable(bodyId);
    }
    state.box2d.b2Body_SetBullet(bodyId, body.bullet);
  });

  world
    .system("PhysicsBodyLifecycle:Damping")
    .with(Body, Damping)
    .phase(phase)
    .update(Damping, (entity, damping) => {
      const bodyId = entity.get(Body)?._bodyId;
      if (bodyId === undefined) {
        return;
      }
      state.box2d.b2Body_SetLinearDamping(bodyId, damping.linear);
      state.box2d.b2Body_SetAngularDamping(bodyId, damping.angular);
    });

  world
    .system("PhysicsBodyLifecycle:GravityScale")
    .with(Body, GravityScale)
    .phase(phase)
    .update(GravityScale, (entity, gravityScale) => {
      const bodyId = entity.get(Body)?._bodyId;
      if (bodyId === undefined) {
        return;
      }
      state.box2d.b2Body_SetGravityScale(bodyId, gravityScale.value);
    });

  world
    .system("PhysicsBodyLifecycle:MotionLocks")
    .with(Body, MotionLocks)
    .phase(phase)
    .update(MotionLocks, (entity, locks) => {
      const bodyId = entity.get(Body)?._bodyId;
      if (bodyId === undefined) {
        return;
      }
      withAllocated(
        () => new state.box2d.b2MotionLocks(),
        (motionLocks) => {
          motionLocks.linearX = locks.x;
          motionLocks.linearY = locks.y;
          motionLocks.angularZ = locks.rotation;
          state.box2d.b2Body_SetMotionLocks(bodyId, motionLocks);
        }
      );
    });

  world
    .system("PhysicsBodyLifecycle:Sleep")
    .with(Body, Sleep)
    .phase(phase)
    .update(Sleep, (entity, sleep) => {
      const bodyId = entity.get(Body)?._bodyId;
      if (bodyId === undefined) {
        return;
      }
      state.box2d.b2Body_EnableSleep(bodyId, sleep.enabled);
      state.box2d.b2Body_SetAwake(bodyId, sleep.awake);
      state.box2d.b2Body_SetSleepThreshold(bodyId, sleep.threshold);
    });

  return system;
}

function createWasmBodyId(state: PhysicsState, entity: Entity, body: Body): b2BodyId {
  const box2d = state.box2d;
  return withAllocated(box2d.b2DefaultBodyDef, (def) => {
    const position = entity.get(Position);
    const rotation = entity.get(Rotation);
    const linearVelocity = entity.get(LinearVelocity);
    const angularVelocity = entity.get(AngularVelocity);
    const damping = entity.get(Damping);
    const gravityScale = entity.get(GravityScale);
    const motionLocks = entity.get(MotionLocks);
    const sleep = entity.get(Sleep);

    def.type = bodyTypeToBox2D(box2d, body.type);
    def.position.Set(position?.x ?? 0, position?.y ?? 0);
    def.rotation.SetAngle(rotation?.angle ?? 0);
    def.linearVelocity.Set(linearVelocity?.x ?? 0, linearVelocity?.y ?? 0);
    def.angularVelocity = angularVelocity?.value ?? 0;
    def.linearDamping = damping?.linear ?? 0;
    def.angularDamping = damping?.angular ?? 0;
    def.gravityScale = gravityScale?.value ?? 1;
    def.motionLocks.linearX = motionLocks?.x ?? false;
    def.motionLocks.linearY = motionLocks?.y ?? false;
    def.motionLocks.angularZ = motionLocks?.rotation ?? false;
    def.enableSleep = sleep?.enabled ?? true;
    def.isAwake = sleep?.awake ?? true;
    def.sleepThreshold = sleep?.threshold ?? 0.05;
    def.isEnabled = body.enabled;
    def.isBullet = body.bullet;
    def.allowFastRotation = body.allowFastRotation;

    return box2d.b2CreateBody(state.worldId, def);
  });
}

function bodyTypeToBox2D(
  box2d: Box2DModule,
  type: BodyType
): ReturnType<Box2DModule["b2Body_GetType"]> {
  switch (type) {
    case BodyType.Static:
      return box2d.b2BodyType.b2_staticBody;
    case BodyType.Kinematic:
      return box2d.b2BodyType.b2_kinematicBody;
    case BodyType.Dynamic:
      return box2d.b2BodyType.b2_dynamicBody;
  }
}
