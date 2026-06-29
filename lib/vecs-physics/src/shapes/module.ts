import { Implements, Module } from "@vworlds/vecs";

import { BodyModule } from "../body/module.js";
import { PhysicsCoreModule } from "../core/module.js";
import { ChainLifecycleModule } from "./chain.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment, Shape, SingleShape } from "./components.js";
import { ShapeLifecycleModule } from "./lifecycle.js";
import { ShapePosition, ShapeRotation } from "./pose_components.js";

export class ShapesModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);
    world.module(BodyModule);

    world.component(ShapePosition);
    world.component(ShapeRotation);
    world.component(Shape);
    world.component(SingleShape);
    world.component(Box);
    world.component(Circle);
    world.component(Capsule);
    world.component(Segment);
    world.component(Polygon);
    world.component(Chain);

    world.component(SingleShape).set(Implements, { interfaces: [Shape] });
    world.component(Box).set(Implements, { interfaces: [SingleShape] });
    world.component(Circle).set(Implements, { interfaces: [SingleShape] });
    world.component(Capsule).set(Implements, { interfaces: [SingleShape] });
    world.component(Segment).set(Implements, { interfaces: [SingleShape] });
    world.component(Polygon).set(Implements, { interfaces: [SingleShape] });
    world.component(Chain).set(Implements, { interfaces: [Shape] });

    world.module(ShapeLifecycleModule);
    world.module(ChainLifecycleModule);
  }
}
