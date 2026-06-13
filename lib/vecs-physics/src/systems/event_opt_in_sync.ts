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

  // Effective sensor detection is `SensorEvents present OR Detectable present`.
  // Each hook reads only the *counterpart* component via `entity.get` — never
  // its own component inside `onRemove`, since it may already be detached.
  world
    .component(SensorEvents)
    .onAdd((entity) => syncSensorDetection(state, entity, true, Detectable));
  world
    .component(SensorEvents)
    .onRemove((entity) => syncSensorDetection(state, entity, false, Detectable));

  world
    .component(Detectable)
    .onAdd((entity) => syncSensorDetection(state, entity, true, SensorEvents));
  world
    .component(Detectable)
    .onRemove((entity) => syncSensorDetection(state, entity, false, SensorEvents));

  const system = world
    .system("PhysicsEventOptInSync")
    .phase(phase)
    .run(() => {
      // Hook-driven: onAdd/onRemove do the work synchronously during command drain.
    });
  system.entity.add(PhysicsSystemTag);
}

function setEventFlag(
  state: PhysicsState,
  entity: Entity,
  flag: EventFlag,
  enabled: boolean
): void {
  const shapeId = readShapeId(entity);
  if (shapeId !== undefined) {
    applyEventFlag(state, shapeId, flag, enabled);
  }
}

// effective = thisPresent || (counterpart present)
function syncSensorDetection(
  state: PhysicsState,
  entity: Entity,
  selfPresent: boolean,
  counterpart: typeof SensorEvents | typeof Detectable
): void {
  const shapeId = readShapeId(entity);
  if (shapeId === undefined) {
    return;
  }
  const effective = selfPresent || entity.get(counterpart) !== undefined;
  state.box2d.b2Shape_EnableSensorEvents(shapeId, effective);
}

function readShapeId(entity: Entity): b2ShapeId | undefined {
  const shape = entity.get(Shape);
  if (shape === undefined || shape instanceof Chain) {
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
