import { Module } from "@vworlds/vecs";

import { PhysicsCoreModule } from "../core/module.js";
import { ContactEvents, HitEvents, SensorEvents } from "./components.js";

export class EventsModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    world.component(ContactEvents);
    world.component(SensorEvents);
    world.component(HitEvents);
  }
}
