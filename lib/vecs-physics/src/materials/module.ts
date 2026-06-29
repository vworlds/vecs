import { Module } from "@vworlds/vecs";

import { PhysicsCoreModule } from "../core/module.js";
import { ShapesModule } from "../shapes/module.js";
import { CollisionFilter, Detectable, Material, Sensor } from "./components.js";
import { MaterialFilterSyncModule } from "./sync.js";

export class MaterialsModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);
    world.module(ShapesModule);

    world.component(Material);
    world.component(CollisionFilter);
    world.component(Sensor);
    world.component(Detectable);

    world.module(MaterialFilterSyncModule);
  }
}
