import { Module } from "@vworlds/vecs";

import { BodyModule } from "../body/module.js";
import { PhysicsCoreModule } from "../core/module.js";
import { AngularImpulse, Force, Impulse, Torque } from "./components.js";
import { ForceGatherModule } from "./gather.js";
import { ImpulseAccumulateModule } from "./impulses.js";

export class ForcesModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);
    world.module(BodyModule);

    world.component(Force);
    world.component(Torque);
    world.component(Impulse);
    world.component(AngularImpulse);

    world.module(ForceGatherModule);
    world.module(ImpulseAccumulateModule);
  }
}
