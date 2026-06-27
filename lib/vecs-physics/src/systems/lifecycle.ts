import { type Entity, type World } from "@vworlds/vecs";

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
import { PhysicsSystemTag, type b2BodyId, type PhysicsEngine } from "../adapter/engine.js";
import { withAllocated } from "../adapter/disposal.js";

export function installBodyLifecycle(world: World, engine: PhysicsEngine, phase: Entity): void {
  const system = world.system("PhysicsBodyLifecycle").with(Body).phase(phase);
  system.entity.add(PhysicsSystemTag);

  system.enter([Body], (entity, [body]) => {
    const bodyId = createWasmBodyId(engine, entity, body);
    body._bodyId = bodyId;
    engine.entityByBodyIndex.set(bodyId.index1, entity.eid);
  });

  // Inject `[Body]` so the handle survives the post-`_destroy` snapshot -- by
  // the time the exit callback runs (next tick's inbox drain), `entity.get(Body)`
  // would return `undefined`.
  system.exit([Body], (entity, [body]) => {
    const bodyId = body?._bodyId;
    if (bodyId === undefined) {
      return;
    }
    // Defer the actual b2DestroyBody (and the reverse-map clear) until after
    // shape + chain teardown -- see PhysicsBodyDestroyDeferred below and the
    // pendingBodyDestroys note in PhysicsEngine. Destroying the body here would
    // cascade-free its shapes' Box2D slots mid-pass, so a child shape created in
    // the same flush could recycle a freed index1 before the dead shape's
    // reverse-map entry is cleared, and the dead shape's exit would then wipe the
    // live child's entry (dropping its sensor/contact events).
    engine.pendingBodyDestroys.push(bodyId);
  });

  system.update(Body, (entity, body) => {
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
  });

  const dampingSystem = world
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
    });
  dampingSystem.entity.add(PhysicsSystemTag);

  const gravityScaleSystem = world
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
    );
  gravityScaleSystem.entity.add(PhysicsSystemTag);

  const motionLocksSystem = world
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
    });
  motionLocksSystem.entity.add(PhysicsSystemTag);

  const sleepSystem = world
    .system("PhysicsBodyLifecycle:Sleep")
    .with(Body, Sleep)
    .phase(phase)
    .update({ watch: Sleep, onEnter: true, inject: [Body] }, (entity, sleep, [body]) => {
      const bodyId = body?._bodyId;
      if (bodyId === undefined) {
        return;
      }
      engine.box2d.b2Body_EnableSleep(bodyId, sleep.enabled);
      engine.box2d.b2Body_SetAwake(bodyId, sleep.awake);
      engine.box2d.b2Body_SetSleepThreshold(bodyId, sleep.threshold);
    });
  sleepSystem.entity.add(PhysicsSystemTag);
}

// Single point of Box2D teardown. Every lifecycle exit enqueues its handle
// (pendingShapeDestroys / pendingChainDestroys / pendingBodyDestroys) and does
// only vecs-side bookkeeping; this reaper performs all the b2Destroy* calls at
// once. Must be registered AFTER every system that touches a being-destroyed
// shape/body on a still-live handle (shape/chain lifecycle, material+filter sync,
// event opt-in sync) and BEFORE PhysicsMassRecompute and the step. Order within:
// shapes and chains first, then bodies -- children before parents, so a body's
// cascade never double-frees an already-reaped shape. Because nothing is
// destroyed until here, no slot is freed-then-recycled mid-pass, which is why the
// lifecycle exits and event opt-in carry no stale-id/cascade guards.
export function installPhysicsReaper(world: World, engine: PhysicsEngine, phase: Entity): void {
  const system = world
    .system("PhysicsReaper")
    .phase(phase)
    .run(() => {
      // Joints first: a body destroy below cascade-destroys its joints, so we
      // tear down explicitly-removed joints before their bodies disappear. Guard
      // with b2Joint_IsValid because a joint queued from a cascaded body entity
      // may already be gone.
      const joints = engine.pendingJointDestroys;
      for (const jointId of joints) {
        if (engine.box2d.b2Joint_IsValid(jointId)) {
          engine.box2d.b2DestroyJoint(jointId, true);
        }
      }
      joints.length = 0;

      const shapes = engine.pendingShapeDestroys;
      for (const shapeId of shapes) {
        engine.entityByShapeIndex.delete(shapeId.index1);
        engine.box2d.b2DestroyShape(shapeId, true);
      }
      shapes.length = 0;

      const chains = engine.pendingChainDestroys;
      for (const chainId of chains) {
        engine.box2d.b2DestroyChain(chainId);
      }
      chains.length = 0;

      const bodies = engine.pendingBodyDestroys;
      for (const bodyId of bodies) {
        engine.entityByBodyIndex.delete(bodyId.index1);
        engine.box2d.b2DestroyBody(bodyId);
      }
      bodies.length = 0;
    });
  system.entity.add(PhysicsSystemTag);
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
