import { type Entity, type World } from "@vworlds/vecs";

import { Chain, Shape } from "../components/geometry.js";
import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { Detectable } from "../components/material.js";
import { PhysicsSystemTag, type b2ShapeId, type PhysicsState } from "../adapter/state.js";

type EventFlag = "contact" | "hit";

export function installEventOptInSync(world: World, state: PhysicsState, phase: Entity): void {
  world.component(ContactEvents).onAdd((entity) => setEventFlag(state, entity, "contact", true));
  world
    .component(ContactEvents)
    .onRemove((entity) => setEventFlag(state, entity, "contact", false));

  world.component(HitEvents).onAdd((entity) => setEventFlag(state, entity, "hit", true));
  world.component(HitEvents).onRemove((entity) => setEventFlag(state, entity, "hit", false));

  // Sensor detection: enable if SensorEvents OR Detectable is present.
  // Query {all: [Shape, {any: [SensorEvents, Detectable]}]} matches entities
  // with a shape and at least one sensor opt-in component. Enter enables,
  // exit disables (when the last opt-in component is removed).
  const sensorSystem = world
    .system("PhysicsEventOptInSync:Sensor")
    .with({ all: [Shape, { any: [SensorEvents, Detectable] }] })
    .phase(phase)
    .enter([Shape], (_e, [shape]) => {
      const shapeId = readShapeId(shape);
      if (shapeId !== undefined) {
        state.box2d.b2Shape_EnableSensorEvents(shapeId, true);
      }
    })
    .exit([Shape], (_e, [shape]) => {
      const shapeId = readShapeId(shape);
      if (shapeId !== undefined) {
        state.box2d.b2Shape_EnableSensorEvents(shapeId, false);
      }
    });
  sensorSystem.entity.add(PhysicsSystemTag);
}

function setEventFlag(
  state: PhysicsState,
  entity: Entity,
  flag: EventFlag,
  enabled: boolean
): void {
  const shape = entity.get(Shape);
  if (shape !== undefined) {
    const shapeId = readShapeId(shape);
    if (shapeId !== undefined) {
      applyEventFlag(state, shapeId, flag, enabled);
    }
  }
}

function readShapeId(shape: Shape): b2ShapeId | undefined {
  if (shape instanceof Chain) {
    return undefined;
  }
  return shape._shapeId as b2ShapeId | undefined;
}

function applyEventFlag(
  state: PhysicsState,
  shapeId: b2ShapeId,
  flag: EventFlag,
  enabled: boolean
): void {
  switch (flag) {
    case "contact":
      state.box2d.b2Shape_EnableContactEvents(shapeId, enabled);
      break;
    case "hit":
      state.box2d.b2Shape_EnableHitEvents(shapeId, enabled);
      break;
  }
}
