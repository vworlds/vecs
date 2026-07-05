// Joint lifecycle: creates/destroys the Box2D joint that backs a joint entity.
// Mirrors the shape lifecycle, but works over TWO bodies instead of one ChildOf
// parent: each system injects both connected bodies through the JointBodyA/B
// relationship targets and passes them in. Creation is order-independent: the
// `jointWithBothBodies` predicate only matches once both connected bodies carry a
// `Body`, and the relationship TargetTerms fan out reactively as bodies appear.
//
// Anchors and the reference angle are written straight into the def's embedded
// local-frame transforms (`def.base.localFrameA.p.Set(...)`,
// `...q.SetAngle(...)`), so joint creation allocates nothing beyond the def
// handle wrapped by `withAllocated`. Feature components (motor/limit/spring) are
// baked into the def here so creation-time presence works in any order; runtime
// changes are owned by the feature sync module (`features.ts`).

import { Module, type Entity } from "@vworlds/vecs";

import {
  getPhysicsEngine,
  PhysicsSystemTag,
  type b2BodyId,
  type b2JointDefBase,
  type b2JointId,
  type PhysicsEngine,
} from "../adapter/engine.js";
import { Body } from "../body/components.js";
import {
  DistanceJoint,
  FilterJoint,
  Joint,
  JointAngularSpring,
  JointBodyA,
  JointBodyB,
  JointFrame,
  JointLimit,
  JointLinearSpring,
  JointMotor,
  JointSettings,
  MotorJoint,
  PrismaticJoint,
  RevoluteJoint,
  WeldJoint,
  WheelJoint,
} from "./components.js";
import { withAllocated } from "../adapter/disposal.js";
import { PhysicsCoreModule } from "../core/module.js";
import { jointWithBothBodies } from "./predicates.js";

// Inject the `Joint` plus both connected bodies (resolved through the
// JointBodyA/B relationship targets). Body terms are not in `.with`, so they
// resolve as `Body | undefined`.
const bodyAInject = { target: [JointBodyA, [Body]] } as const;
const bodyBInject = { target: [JointBodyB, [Body]] } as const;

export class JointLifecycleModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    const phase = engine.phases.preStep;
    world
      .system("PhysicsJointLifecycle")
      .with(jointWithBothBodies)
      .phase(phase)
      .enter([Joint, bodyAInject, bodyBInject], (entity, [joint, bodyA, bodyB]) => {
        createJointForEntity(engine, entity, joint, bodyA, bodyB);
      })
      // Inject `[Joint]` so the joint handle survives the post-`_destroy` exit
      // snapshot, then defer the b2DestroyJoint to PhysicsReaper (validity-guarded,
      // because a connected body's destroy may have detached this joint already).
      .exit([Joint], (entity, [joint]) => {
        destroyJointForEntity(engine, entity, true, joint);
      })
      // Type-component change (e.g. DistanceJoint.length): destroy + recreate now.
      .update(
        { watch: Joint, inject: [bodyAInject, bodyBInject] },
        (entity, joint, [bodyA, bodyB]) => {
          recreateJointForEntity(engine, entity, joint, bodyA, bodyB);
        }
      )
      .add(PhysicsSystemTag);

    // JointFrame change: anchors/reference angle are create-time only, so recreate.
    world
      .system("PhysicsJointLifecycle:Frame")
      .with(JointFrame, jointWithBothBodies)
      .phase(phase)
      .update(
        { watch: JointFrame, inject: [Joint, bodyAInject, bodyBInject] },
        (entity, _frame, [joint, bodyA, bodyB]) => {
          recreateJointForEntity(engine, entity, joint, bodyA, bodyB);
        }
      )
      .add(PhysicsSystemTag);

    // Retarget either body relationship: rebuild the joint on the new bodies.
    world
      .system("PhysicsJointLifecycle:Retarget")
      .with(JointBodyA, JointBodyB, jointWithBothBodies)
      .phase(phase)
      .update(
        { watch: JointBodyA, inject: [Joint, bodyAInject, bodyBInject] },
        (entity, _rel, [joint, bodyA, bodyB]) => {
          recreateJointForEntity(engine, entity, joint, bodyA, bodyB);
        }
      )
      .update(
        { watch: JointBodyB, inject: [Joint, bodyAInject, bodyBInject] },
        (entity, _rel, [joint, bodyA, bodyB]) => {
          recreateJointForEntity(engine, entity, joint, bodyA, bodyB);
        }
      )
      .add(PhysicsSystemTag);
  }
}

function recreateJointForEntity(
  engine: PhysicsEngine,
  entity: Entity,
  joint: Joint | undefined,
  bodyA: Body | undefined,
  bodyB: Body | undefined
): void {
  destroyJointForEntity(engine, entity, false, joint);
  createJointForEntity(engine, entity, joint, bodyA, bodyB);
}

function createJointForEntity(
  engine: PhysicsEngine,
  entity: Entity,
  joint: Joint | undefined,
  bodyA: Body | undefined,
  bodyB: Body | undefined
): void {
  const bodyAId = bodyA?._bodyId;
  const bodyBId = bodyB?._bodyId;
  if (joint === undefined || bodyAId === undefined || bodyBId === undefined) {
    return;
  }
  const jointId = createBox2dJoint(engine, entity, joint, bodyAId, bodyBId);
  if (jointId !== undefined) {
    joint._jointId = jointId;
  }
}

// `deferDestroy` mirrors the shape lifecycle: an exit defers the b2DestroyJoint to
// PhysicsReaper (joint still live until then), an in-place recreate destroys now.
function destroyJointForEntity(
  engine: PhysicsEngine,
  entity: Entity,
  deferDestroy: boolean,
  joint?: Readonly<Joint>
): void {
  const resolvedJoint = joint ?? entity.get(Joint);
  const jointId = resolvedJoint?._jointId;
  if (jointId === undefined) {
    return;
  }

  if (deferDestroy) {
    engine.pendingJointDestroys.push(jointId);
  } else if (engine.box2d.b2Joint_IsValid(jointId)) {
    engine.box2d.b2DestroyJoint(jointId, true);
  }

  const mutableJoint = entity.get(Joint) as Joint | undefined;
  if (mutableJoint !== undefined) {
    mutableJoint._jointId = undefined;
  }
}

function createBox2dJoint(
  engine: PhysicsEngine,
  entity: Entity,
  joint: Joint,
  bodyAId: b2BodyId,
  bodyBId: b2BodyId
): b2JointId | undefined {
  const box2d = engine.box2d;
  const frame = entity.get(JointFrame);
  const collideConnected = entity.get(JointSettings)?.collideConnected ?? false;
  const motor = entity.get(JointMotor);
  const limit = entity.get(JointLimit);
  const linearSpring = entity.get(JointLinearSpring);
  const angularSpring = entity.get(JointAngularSpring);

  // Write anchors + reference angle into a def's embedded local frames. The
  // reference angle (B's rest angle relative to A) is encoded on frame A's
  // rotation; frame B stays identity.
  const applyBase = (base: b2JointDefBase): void => {
    base.bodyIdA = bodyAId;
    base.bodyIdB = bodyBId;
    base.localFrameA.p.Set(frame?.localAnchorA.x ?? 0, frame?.localAnchorA.y ?? 0);
    base.localFrameA.q.SetAngle(frame?.referenceAngle ?? 0);
    base.localFrameB.p.Set(frame?.localAnchorB.x ?? 0, frame?.localAnchorB.y ?? 0);
    base.collideConnected = collideConnected;
  };

  if (joint instanceof RevoluteJoint) {
    return withAllocated(box2d.b2DefaultRevoluteJointDef, (def) => {
      applyBase(def.base);
      if (motor !== undefined) {
        def.enableMotor = true;
        def.motorSpeed = motor.targetSpeed;
        def.maxMotorTorque = motor.maxForce;
      }
      if (limit !== undefined) {
        def.enableLimit = true;
        def.lowerAngle = limit.lower;
        def.upperAngle = limit.upper;
      }
      if (angularSpring !== undefined) {
        def.enableSpring = true;
        def.hertz = angularSpring.hertz;
        def.dampingRatio = angularSpring.dampingRatio;
      }
      return box2d.b2CreateRevoluteJoint(engine.worldId, def);
    });
  }

  if (joint instanceof DistanceJoint) {
    return withAllocated(box2d.b2DefaultDistanceJointDef, (def) => {
      applyBase(def.base);
      def.length = joint.length;
      if (linearSpring !== undefined) {
        def.enableSpring = true;
        def.hertz = linearSpring.hertz;
        def.dampingRatio = linearSpring.dampingRatio;
      }
      if (limit !== undefined) {
        def.enableLimit = true;
        def.minLength = limit.lower;
        def.maxLength = limit.upper;
      }
      if (motor !== undefined) {
        def.enableMotor = true;
        def.motorSpeed = motor.targetSpeed;
        def.maxMotorForce = motor.maxForce;
      }
      return box2d.b2CreateDistanceJoint(engine.worldId, def);
    });
  }

  if (joint instanceof WeldJoint) {
    return withAllocated(box2d.b2DefaultWeldJointDef, (def) => {
      applyBase(def.base);
      if (linearSpring !== undefined) {
        def.linearHertz = linearSpring.hertz;
        def.linearDampingRatio = linearSpring.dampingRatio;
      }
      if (angularSpring !== undefined) {
        def.angularHertz = angularSpring.hertz;
        def.angularDampingRatio = angularSpring.dampingRatio;
      }
      return box2d.b2CreateWeldJoint(engine.worldId, def);
    });
  }

  if (joint instanceof PrismaticJoint) {
    return withAllocated(box2d.b2DefaultPrismaticJointDef, (def) => {
      applyBase(def.base);
      if (motor !== undefined) {
        def.enableMotor = true;
        def.motorSpeed = motor.targetSpeed;
        def.maxMotorForce = motor.maxForce;
      }
      if (limit !== undefined) {
        def.enableLimit = true;
        def.lowerTranslation = limit.lower;
        def.upperTranslation = limit.upper;
      }
      if (linearSpring !== undefined) {
        def.enableSpring = true;
        def.hertz = linearSpring.hertz;
        def.dampingRatio = linearSpring.dampingRatio;
      }
      return box2d.b2CreatePrismaticJoint(engine.worldId, def);
    });
  }

  if (joint instanceof WheelJoint) {
    return withAllocated(box2d.b2DefaultWheelJointDef, (def) => {
      applyBase(def.base);
      if (motor !== undefined) {
        def.enableMotor = true;
        def.motorSpeed = motor.targetSpeed;
        def.maxMotorTorque = motor.maxForce;
      }
      if (limit !== undefined) {
        def.enableLimit = true;
        def.lowerTranslation = limit.lower;
        def.upperTranslation = limit.upper;
      }
      if (linearSpring !== undefined) {
        def.enableSpring = true;
        def.hertz = linearSpring.hertz;
        def.dampingRatio = linearSpring.dampingRatio;
      }
      return box2d.b2CreateWheelJoint(engine.worldId, def);
    });
  }

  if (joint instanceof FilterJoint) {
    return withAllocated(box2d.b2DefaultFilterJointDef, (def) => {
      applyBase(def.base);
      return box2d.b2CreateFilterJoint(engine.worldId, def);
    });
  }

  if (joint instanceof MotorJoint) {
    return withAllocated(box2d.b2DefaultMotorJointDef, (def) => {
      applyBase(def.base);
      // Unlike `base.localFrameA.p`, `def.linearVelocity` is a plain value
      // property, not a mutable reference: `.Set(...)` on the getter's result
      // is silently discarded. Assign a real (copied-by-value) `b2Vec2` instead.
      withAllocated(
        () => new box2d.b2Vec2(joint.linearVelocity.x, joint.linearVelocity.y),
        (linearVelocity) => {
          def.linearVelocity = linearVelocity;
        }
      );
      def.maxVelocityForce = joint.maxVelocityForce;
      def.angularVelocity = joint.angularVelocity;
      def.maxVelocityTorque = joint.maxVelocityTorque;
      def.linearHertz = joint.linearHertz;
      def.linearDampingRatio = joint.linearDampingRatio;
      def.maxSpringForce = joint.maxSpringForce;
      def.angularHertz = joint.angularHertz;
      def.angularDampingRatio = joint.angularDampingRatio;
      def.maxSpringTorque = joint.maxSpringTorque;
      return box2d.b2CreateMotorJoint(engine.worldId, def);
    });
  }

  return undefined;
}
