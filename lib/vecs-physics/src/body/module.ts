import { Module } from "@vworlds/vecs";

import { PhysicsCoreModule } from "../core/module.js";
import { AngularVelocity, Body, LinearVelocity, Position, Rotation } from "./components.js";
import { BodyLifecycleModule } from "./lifecycle.js";
import { Damping, GravityScale, MotionLocks, Sleep } from "./tuning.js";

export class BodyModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    world.component(Position);
    world.component(Rotation);
    world.component(LinearVelocity);
    world.component(AngularVelocity);
    world.component(Body);
    world.component(Damping);
    world.component(GravityScale);
    world.component(MotionLocks);
    world.component(Sleep);

    world.module(BodyLifecycleModule);
  }
}
