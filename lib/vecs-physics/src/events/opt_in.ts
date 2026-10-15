import { ChildOf, Iter, Module, type Entity } from "@vworlds/vecs";

import {
  getPhysicsEngine,
  PhysicsSystemTag,
  type b2ShapeId,
  type PhysicsEngine,
} from "../adapter/engine.js";
import { Body } from "../body/components.js";
import { Chain, SingleShape } from "../shapes/components.js";
import { ContactEvents, HitEvents, SensorEvents } from "./components.js";
import { Detectable } from "../materials/components.js";
import { PhysicsCoreModule } from "../core/module.js";
import { MaterialsModule } from "../materials/module.js";
import { recreateChainForEntity } from "../shapes/chain.js";
import { ShapesModule } from "../shapes/module.js";
import { chainWithBodyParent } from "../shapes/predicates.js";
import { EventsModule } from "./module.js";

type EventFlag = "contact" | "hit";

export class EventOptInModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);
    world.module(ShapesModule);
    world.module(MaterialsModule);
    world.module(EventsModule);

    const engine = getPhysicsEngine(world);
    const phase = engine.phases.preStep;
    world
      .component(ContactEvents)
      .on("add", (entity) => setEventFlag(engine, entity, "contact", true))
      .on("remove", (entity) => {
        if (!engine.disposed) {
          setEventFlag(engine, entity, "contact", false);
        }
      });

    world
      .component(HitEvents)
      .on("add", (entity) => setEventFlag(engine, entity, "hit", true))
      .on("remove", (entity) => {
        if (!engine.disposed) {
          setEventFlag(engine, entity, "hit", false);
        }
      });

    // Sensor detection: enable if SensorEvents OR Detectable is present.
    // Query only single b2Shape geometries; chains have no runtime sensor-event
    // setter and are recreated by the chain opt-in system below.
    world
      .system("PhysicsEventOptInSync:Sensor")
      .with({ all: [SingleShape, { any: [SensorEvents, Detectable] }] })
      .phase(phase)
      .add(PhysicsSystemTag)
      .enter([SingleShape], (_e, [shape]) => {
        const shapeId = shape._shapeId;
        if (shapeId !== undefined) {
          engine.box2d.b2Shape_EnableSensorEvents(shapeId, true);
        }
      });
    // Disable at the exit flush so a late preStep destroy cannot leave a stale
    // setter in next tick's inbox after cleanup has already freed the shape.
    world
      .query("PhysicsEventOptInTeardown:Sensor")
      .with({ all: [SingleShape, { any: [SensorEvents, Detectable] }] })
      .exit([SingleShape], (_e, [shape]) => {
        // Infrastructure may release the engine before this component leaves.
        if (engine.disposed) {
          return;
        }
        const shapeId = shape._shapeId;
        // No stale-id guard needed: this exit runs at the flush, before cleanup
        // can free or recycle the shape's Box2D slot.
        if (shapeId !== undefined) {
          engine.box2d.b2Shape_EnableSensorEvents(shapeId, false);
        }
      });

    world
      .system("PhysicsEventOptInSync:ChainSensor")
      .with({ all: [Chain, { any: [SensorEvents, Detectable] }] }, chainWithBodyParent)
      .phase(phase)
      .add(PhysicsSystemTag)
      .enter(
        { cursor: Iter, inject: [Chain, { target: [ChildOf, [Body]] }] },
        (it, [chain, body]) => {
          recreateChainForEntity(engine, it.entity, it.entity.target(ChildOf), body, chain);
        }
      )
      .exit((entity) => {
        const chain = entity.get(Chain);
        const parent = entity.parent;
        recreateChainForEntity(engine, entity, parent, parent?.get(Body), chain);
      });
  }
}

function setEventFlag(
  engine: PhysicsEngine,
  entity: Entity,
  flag: EventFlag,
  enabled: boolean
): void {
  const shape = entity.get(SingleShape);
  if (shape !== undefined) {
    const shapeId = shape._shapeId;
    // No stale-id guard: with deferred teardown the shape's slot is never freed
    // mid-pass, so this contact/hit setter never lands on a recycled slot.
    if (shapeId !== undefined) {
      applyEventFlag(engine, shapeId, flag, enabled);
    }
  }
}

function applyEventFlag(
  engine: PhysicsEngine,
  shapeId: b2ShapeId,
  flag: EventFlag,
  enabled: boolean
): void {
  switch (flag) {
    case "contact":
      engine.box2d.b2Shape_EnableContactEvents(shapeId, enabled);
      break;
    case "hit":
      engine.box2d.b2Shape_EnableHitEvents(shapeId, enabled);
      break;
  }
}
