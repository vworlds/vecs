import { Implements, Module } from "@vworlds/vecs";

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

    world.component(JointBodyA);
    world.component(JointBodyB);
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
