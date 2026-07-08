// Joint feature sync. Each optional feature (motor, limit, linear spring, angular
// spring) is owned by its own small reactive system, modelled on
// PhysicsMaterialFilterSync: presence of the component enables the feature, a
// change re-tunes it, and removal disables it. Creation-time presence is baked
// into the def by the lifecycle (`lifecycle.ts`); these systems own runtime
// add/change/remove on a live joint via in-place Box2D setters.
//
// Every setter is guarded by `b2Joint_IsValid`: the joint may not exist yet (a
// connected body hasn't appeared) or may have been reaped (a connected body was
// destroyed) by the time a callback runs.

import { Module } from "@vworlds/vecs";

import {
  getPhysicsEngine,
  PhysicsSystemTag,
  type b2JointId,
  type PhysicsEngine,
} from "../adapter/engine.js";
import {
  DistanceJoint,
  Joint,
  JointAngularSpring,
  JointLimit,
  JointLinearSpring,
  JointMotor,
  PrismaticJoint,
  RevoluteJoint,
  WeldJoint,
  WheelJoint,
} from "./components.js";
import { type Box2DModule } from "../adapter/runtime.js";
import { PhysicsCoreModule } from "../core/module.js";
import { jointWithBothBodies } from "./predicates.js";

export class JointFeaturesModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    const phase = engine.phases.preStep;
    const motor = world
      .system("PhysicsJointMotorSync")
      .with(JointMotor, jointWithBothBodies)
      .phase(phase)
      .add(PhysicsSystemTag);
    motor.update({ watch: JointMotor, onEnter: true, inject: [Joint] }, (_e, value, [joint]) => {
      withLiveJoint(engine, joint, (id) => applyMotor(engine.box2d, joint, id, value));
    });
    motor.exit([JointMotor, Joint], (_e, [, joint]) => {
      withLiveJoint(engine, joint, (id) => disableMotor(engine.box2d, joint, id));
    });

    const limit = world
      .system("PhysicsJointLimitSync")
      .with(JointLimit, jointWithBothBodies)
      .phase(phase)
      .add(PhysicsSystemTag);
    limit.update({ watch: JointLimit, onEnter: true, inject: [Joint] }, (_e, value, [joint]) => {
      withLiveJoint(engine, joint, (id) => applyLimit(engine.box2d, joint, id, value));
    });
    limit.exit([JointLimit, Joint], (_e, [, joint]) => {
      withLiveJoint(engine, joint, (id) => disableLimit(engine.box2d, joint, id));
    });

    const linear = world
      .system("PhysicsJointLinearSpringSync")
      .with(JointLinearSpring, jointWithBothBodies)
      .phase(phase)
      .add(PhysicsSystemTag);
    linear.update(
      { watch: JointLinearSpring, onEnter: true, inject: [Joint] },
      (_e, value, [joint]) => {
        withLiveJoint(engine, joint, (id) => applyLinearSpring(engine.box2d, joint, id, value));
      }
    );
    linear.exit([JointLinearSpring, Joint], (_e, [, joint]) => {
      withLiveJoint(engine, joint, (id) => disableLinearSpring(engine.box2d, joint, id));
    });

    const angular = world
      .system("PhysicsJointAngularSpringSync")
      .with(JointAngularSpring, jointWithBothBodies)
      .phase(phase)
      .add(PhysicsSystemTag);
    angular.update(
      { watch: JointAngularSpring, onEnter: true, inject: [Joint] },
      (_e, value, [joint]) => {
        withLiveJoint(engine, joint, (id) => applyAngularSpring(engine.box2d, joint, id, value));
      }
    );
    angular.exit([JointAngularSpring, Joint], (_e, [, joint]) => {
      withLiveJoint(engine, joint, (id) => disableAngularSpring(engine.box2d, joint, id));
    });
  }
}

/** Run `fn` only when the joint exists and its Box2D handle is still valid, then
 * wake the connected bodies so a runtime feature change takes effect even if they
 * had gone to sleep (Box2D's joint setters do not wake bodies on their own). */
function withLiveJoint(
  engine: PhysicsEngine,
  joint: Joint | undefined,
  fn: (jointId: b2JointId) => void
): void {
  const jointId = joint?._jointId;
  if (jointId === undefined || !engine.box2d.b2Joint_IsValid(jointId)) {
    return;
  }
  fn(jointId);
  engine.box2d.b2Joint_WakeBodies(jointId);
}

function applyMotor(box2d: Box2DModule, joint: Joint, jointId: b2JointId, motor: JointMotor): void {
  if (joint instanceof RevoluteJoint) {
    box2d.b2RevoluteJoint_EnableMotor(jointId, true);
    box2d.b2RevoluteJoint_SetMotorSpeed(jointId, motor.targetSpeed);
    box2d.b2RevoluteJoint_SetMaxMotorTorque(jointId, motor.maxForce);
  } else if (joint instanceof DistanceJoint) {
    box2d.b2DistanceJoint_EnableMotor(jointId, true);
    box2d.b2DistanceJoint_SetMotorSpeed(jointId, motor.targetSpeed);
    box2d.b2DistanceJoint_SetMaxMotorForce(jointId, motor.maxForce);
  } else if (joint instanceof PrismaticJoint) {
    box2d.b2PrismaticJoint_EnableMotor(jointId, true);
    box2d.b2PrismaticJoint_SetMotorSpeed(jointId, motor.targetSpeed);
    box2d.b2PrismaticJoint_SetMaxMotorForce(jointId, motor.maxForce);
  } else if (joint instanceof WheelJoint) {
    box2d.b2WheelJoint_EnableMotor(jointId, true);
    box2d.b2WheelJoint_SetMotorSpeed(jointId, motor.targetSpeed);
    box2d.b2WheelJoint_SetMaxMotorTorque(jointId, motor.maxForce);
  }
}

function disableMotor(box2d: Box2DModule, joint: Joint, jointId: b2JointId): void {
  if (joint instanceof RevoluteJoint) {
    box2d.b2RevoluteJoint_EnableMotor(jointId, false);
  } else if (joint instanceof DistanceJoint) {
    box2d.b2DistanceJoint_EnableMotor(jointId, false);
  } else if (joint instanceof PrismaticJoint) {
    box2d.b2PrismaticJoint_EnableMotor(jointId, false);
  } else if (joint instanceof WheelJoint) {
    box2d.b2WheelJoint_EnableMotor(jointId, false);
  }
}

function applyLimit(box2d: Box2DModule, joint: Joint, jointId: b2JointId, limit: JointLimit): void {
  if (joint instanceof RevoluteJoint) {
    box2d.b2RevoluteJoint_EnableLimit(jointId, true);
    box2d.b2RevoluteJoint_SetLimits(jointId, limit.lower, limit.upper);
  } else if (joint instanceof DistanceJoint) {
    box2d.b2DistanceJoint_EnableLimit(jointId, true);
    box2d.b2DistanceJoint_SetLengthRange(jointId, limit.lower, limit.upper);
  } else if (joint instanceof PrismaticJoint) {
    box2d.b2PrismaticJoint_EnableLimit(jointId, true);
    box2d.b2PrismaticJoint_SetLimits(jointId, limit.lower, limit.upper);
  } else if (joint instanceof WheelJoint) {
    box2d.b2WheelJoint_EnableLimit(jointId, true);
    box2d.b2WheelJoint_SetLimits(jointId, limit.lower, limit.upper);
  }
}

function disableLimit(box2d: Box2DModule, joint: Joint, jointId: b2JointId): void {
  if (joint instanceof RevoluteJoint) {
    box2d.b2RevoluteJoint_EnableLimit(jointId, false);
  } else if (joint instanceof DistanceJoint) {
    box2d.b2DistanceJoint_EnableLimit(jointId, false);
  } else if (joint instanceof PrismaticJoint) {
    box2d.b2PrismaticJoint_EnableLimit(jointId, false);
  } else if (joint instanceof WheelJoint) {
    box2d.b2WheelJoint_EnableLimit(jointId, false);
  }
}

function applyLinearSpring(
  box2d: Box2DModule,
  joint: Joint,
  jointId: b2JointId,
  spring: JointLinearSpring
): void {
  if (joint instanceof DistanceJoint) {
    box2d.b2DistanceJoint_EnableSpring(jointId, true);
    box2d.b2DistanceJoint_SetSpringHertz(jointId, spring.hertz);
    box2d.b2DistanceJoint_SetSpringDampingRatio(jointId, spring.dampingRatio);
  } else if (joint instanceof PrismaticJoint) {
    box2d.b2PrismaticJoint_EnableSpring(jointId, true);
    box2d.b2PrismaticJoint_SetSpringHertz(jointId, spring.hertz);
    box2d.b2PrismaticJoint_SetSpringDampingRatio(jointId, spring.dampingRatio);
  } else if (joint instanceof WheelJoint) {
    box2d.b2WheelJoint_EnableSpring(jointId, true);
    box2d.b2WheelJoint_SetSpringHertz(jointId, spring.hertz);
    box2d.b2WheelJoint_SetSpringDampingRatio(jointId, spring.dampingRatio);
  } else if (joint instanceof WeldJoint) {
    box2d.b2WeldJoint_SetLinearHertz(jointId, spring.hertz);
    box2d.b2WeldJoint_SetLinearDampingRatio(jointId, spring.dampingRatio);
  }
}

function disableLinearSpring(box2d: Box2DModule, joint: Joint, jointId: b2JointId): void {
  if (joint instanceof DistanceJoint) {
    box2d.b2DistanceJoint_EnableSpring(jointId, false);
  } else if (joint instanceof PrismaticJoint) {
    box2d.b2PrismaticJoint_EnableSpring(jointId, false);
  } else if (joint instanceof WheelJoint) {
    box2d.b2WheelJoint_EnableSpring(jointId, false);
  } else if (joint instanceof WeldJoint) {
    // A weld has no spring enable flag; zero hertz is a rigid weld.
    box2d.b2WeldJoint_SetLinearHertz(jointId, 0);
    box2d.b2WeldJoint_SetLinearDampingRatio(jointId, 0);
  }
}

function applyAngularSpring(
  box2d: Box2DModule,
  joint: Joint,
  jointId: b2JointId,
  spring: JointAngularSpring
): void {
  if (joint instanceof RevoluteJoint) {
    box2d.b2RevoluteJoint_EnableSpring(jointId, true);
    box2d.b2RevoluteJoint_SetSpringHertz(jointId, spring.hertz);
    box2d.b2RevoluteJoint_SetSpringDampingRatio(jointId, spring.dampingRatio);
  } else if (joint instanceof WeldJoint) {
    box2d.b2WeldJoint_SetAngularHertz(jointId, spring.hertz);
    box2d.b2WeldJoint_SetAngularDampingRatio(jointId, spring.dampingRatio);
  }
}

function disableAngularSpring(box2d: Box2DModule, joint: Joint, jointId: b2JointId): void {
  if (joint instanceof RevoluteJoint) {
    box2d.b2RevoluteJoint_EnableSpring(jointId, false);
  } else if (joint instanceof WeldJoint) {
    box2d.b2WeldJoint_SetAngularHertz(jointId, 0);
    box2d.b2WeldJoint_SetAngularDampingRatio(jointId, 0);
  }
}
