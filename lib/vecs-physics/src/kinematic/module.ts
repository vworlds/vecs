import { Module } from "@vworlds/vecs";

import { BodyModule } from "../body/module.js";
import { PhysicsCoreModule } from "../core/module.js";
import { KinematicTargetPosition, KinematicTargetRotation } from "./components.js";
import { KinematicTargetsModule } from "./targets.js";

export class KinematicModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);
    world.module(BodyModule);

    world.component(KinematicTargetPosition);
    world.component(KinematicTargetRotation);

    world.module(KinematicTargetsModule);
  }
}
