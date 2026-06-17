import { ChildOf, Iter, type Entity, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Chain, SingleShape } from "../components/geometry.js";
import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { Detectable } from "../components/material.js";
import { PhysicsSystemTag, type b2ShapeId, type PhysicsEngine } from "../adapter/engine.js";
import { recreateChainForEntity } from "./chain_lifecycle.js";
import { chainWithBodyParent } from "./shape_predicates.js";

type EventFlag = "contact" | "hit";

export function installEventOptInSync(world: World, engine: PhysicsEngine, phase: Entity): void {
  world.component(ContactEvents).onAdd((entity) => setEventFlag(engine, entity, "contact", true));
  world
    .component(ContactEvents)
    .onRemove((entity) => setEventFlag(engine, entity, "contact", false));

  world.component(HitEvents).onAdd((entity) => setEventFlag(engine, entity, "hit", true));
  world.component(HitEvents).onRemove((entity) => setEventFlag(engine, entity, "hit", false));

  // Sensor detection: enable if SensorEvents OR Detectable is present.
  // Query only single b2Shape geometries; chains have no runtime sensor-event
  // setter and are recreated by the chain opt-in system below.
  const sensorSystem = world
    .system("PhysicsEventOptInSync:Sensor")
    .with({ all: [SingleShape, { any: [SensorEvents, Detectable] }] })
    .phase(phase)
    .enter([SingleShape], (_e, [shape]) => {
      const shapeId = shape._shapeId;
      if (shapeId !== undefined) {
        engine.box2d.b2Shape_EnableSensorEvents(shapeId, true);
      }
    })
    .exit([SingleShape], (_e, [shape]) => {
      const shapeId = shape._shapeId;
      // No stale-id guard needed: PhysicsReaper runs after this system, so a
      // destroyed shape is still live (and not yet slot-recycled) here.
      if (shapeId !== undefined) {
        engine.box2d.b2Shape_EnableSensorEvents(shapeId, false);
      }
    });
  sensorSystem.entity.add(PhysicsSystemTag);

  const chainSensorSystem = world
    .system("PhysicsEventOptInSync:ChainSensor")
    .with({ all: [Chain, { any: [SensorEvents, Detectable] }] }, chainWithBodyParent)
    .phase(phase)
    .enter(
      { cursor: Iter, inject: [Chain, { target: [ChildOf, [Body]] }] },
      (it, [chain, body]) => {
        recreateChainForEntity(engine, it.entity, it.src[1], body, chain);
      }
    )
    .exit((entity) => {
      const chain = entity.get(Chain);
      const parent = entity.parent;
      recreateChainForEntity(engine, entity, parent, parent?.get(Body), chain);
    });
  chainSensorSystem.entity.add(PhysicsSystemTag);
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
