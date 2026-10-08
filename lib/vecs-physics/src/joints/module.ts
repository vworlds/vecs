import { CleanupPolicy, Exclusive, Implements, Module } from "@vworlds/vecs";

import { BodyModule } from "../body/module.js";
import { PhysicsCoreModule } from "../core/module.js";
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
import { JointFeaturesModule } from "./features.js";
import { JointLifecycleModule } from "./lifecycle.js";

export class JointsModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);
    world.module(BodyModule);

    // Destroying a connected body destroys the joint entity, as Box2D destroys a
    // body's joints with it. Without the policy the default `Remove` would only drop
    // the edge and leave a bodiless joint entity behind.
    const jointBodyA = world.component(JointBodyA);
    jointBodyA.add(Exclusive);
    jointBodyA.meta.onDeleteTarget = CleanupPolicy.Delete;

    const jointBodyB = world.component(JointBodyB);
    jointBodyB.add(Exclusive);
    jointBodyB.meta.onDeleteTarget = CleanupPolicy.Delete;

    world.component(Joint);
    world.component(RevoluteJoint);
    world.component(DistanceJoint);
    world.component(PrismaticJoint);
    world.component(WheelJoint);
    world.component(WeldJoint);
    world.component(FilterJoint);
    world.component(MotorJoint);
    world.component(JointFrame);
    world.component(JointMotor);
    world.component(JointLimit);
    world.component(JointLinearSpring);
    world.component(JointAngularSpring);
    world.component(JointSettings);

    world.component(RevoluteJoint).set(Implements, { interfaces: [Joint] });
    world.component(DistanceJoint).set(Implements, { interfaces: [Joint] });
    world.component(PrismaticJoint).set(Implements, { interfaces: [Joint] });
    world.component(WheelJoint).set(Implements, { interfaces: [Joint] });
    world.component(WeldJoint).set(Implements, { interfaces: [Joint] });
    world.component(FilterJoint).set(Implements, { interfaces: [Joint] });
    world.component(MotorJoint).set(Implements, { interfaces: [Joint] });

    world.module(JointLifecycleModule);
    world.module(JointFeaturesModule);
  }
}
