import { Module, type Entity } from "@vworlds/vecs";

import {
  AngularVelocity,
  Body,
  BodyType,
  LinearVelocity,
  Position,
  Rotation,
} from "./components.js";
import { Damping, GravityScale, MotionLocks, Sleep } from "./tuning.js";
import { type Box2DModule } from "../adapter/runtime.js";
import {
  getPhysicsEngine,
  PhysicsSystemTag,
  type b2BodyId,
  type PhysicsEngine,
} from "../adapter/engine.js";
import { withAllocated } from "../adapter/disposal.js";
import { PhysicsCoreModule } from "../core/module.js";

export class BodyLifecycleModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    const phase = engine.phases.preStep;
    world
      .system("PhysicsBodyLifecycle")
      .with(Body)
      .phase(phase)
      .enter([Body], (entity, [body]) => {
        const bodyId = createWasmBodyId(engine, entity, body);
        body._bodyId = bodyId;
        engine.entityByBodyIndex.set(bodyId.index1, entity.eid);
        engine.bodyEntities[bodyId.index1] = entity;
      })
      .update(Body, (entity, body) => {
        const bodyId = body._bodyId;
        if (bodyId === undefined) {
          return;
        }
        engine.box2d.b2Body_SetType(bodyId, bodyTypeToBox2D(engine.box2d, body.type));
        if (body.enabled) {
          engine.box2d.b2Body_Enable(bodyId);
        } else {
          engine.box2d.b2Body_Disable(bodyId);
        }
        engine.box2d.b2Body_SetBullet(bodyId, body.bullet);
      })
      .entity.add(PhysicsSystemTag);

    // Queries observe exits at flush time, even after the preStep systems ran.
    // Only enqueue here: the cleanup phase destroys children before their bodies.
    world
      .query("PhysicsBodyTeardown")
      .with(Body)
      .exit([Body], (_entity, [body]) => {
        if (body._bodyId !== undefined) {
          engine.pendingBodyDestroys.push(body._bodyId);
          body._bodyId = undefined;
        }
      });

    world
      .system("PhysicsBodyLifecycle:Damping")
      .with(Body, Damping)
      .phase(phase)
      .update({ watch: Damping, onEnter: true, inject: [Body] }, (entity, damping, [body]) => {
        const bodyId = body?._bodyId;
        if (bodyId === undefined) {
          return;
        }
        engine.box2d.b2Body_SetLinearDamping(bodyId, damping.linear);
        engine.box2d.b2Body_SetAngularDamping(bodyId, damping.angular);
      })
      .entity.add(PhysicsSystemTag);

    world
      .system("PhysicsBodyLifecycle:GravityScale")
      .with(Body, GravityScale)
      .phase(phase)
      .update(
        { watch: GravityScale, onEnter: true, inject: [Body] },
        (entity, gravityScale, [body]) => {
          const bodyId = body?._bodyId;
          if (bodyId === undefined) {
            return;
          }
          engine.box2d.b2Body_SetGravityScale(bodyId, gravityScale.value);
        }
      )
      .entity.add(PhysicsSystemTag);

    world
      .system("PhysicsBodyLifecycle:MotionLocks")
      .with(Body, MotionLocks)
      .phase(phase)
      .update({ watch: MotionLocks, onEnter: true, inject: [Body] }, (entity, locks, [body]) => {
        const bodyId = body?._bodyId;
        if (bodyId === undefined) {
          return;
        }
        withAllocated(
          () => new engine.box2d.b2MotionLocks(),
          (motionLocks) => {
            motionLocks.linearX = locks.x;
            motionLocks.linearY = locks.y;
            motionLocks.angularZ = locks.rotation;
            engine.box2d.b2Body_SetMotionLocks(bodyId, motionLocks);
          }
        );
      })
      .entity.add(PhysicsSystemTag);

    world
      .system("PhysicsBodyLifecycle:Sleep")
      .with(Body, Sleep)
      .phase(phase)
      .update({ watch: Sleep, onEnter: true, inject: [Body] }, (entity, sleep, [body]) => {
        const bodyId = body?._bodyId;
        if (bodyId === undefined) {
          return;
        }
        engine.box2d.b2Body_EnableSleeping(bodyId, sleep.enabled);
        engine.box2d.b2Body_SetAwake(bodyId, sleep.awake);
        engine.box2d.b2Body_SetSleepThreshold(bodyId, sleep.threshold);
      })
      .entity.add(PhysicsSystemTag);
  }
}

function createWasmBodyId(engine: PhysicsEngine, entity: Entity, body: Body): b2BodyId {
  const box2d = engine.box2d;
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

    return box2d.b2CreateBody(engine.worldId, def);
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
