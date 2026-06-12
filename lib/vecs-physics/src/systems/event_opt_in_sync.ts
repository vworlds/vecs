import { type Entity, type World } from "@vworlds/vecs";

import { Chain, Shape } from "../components/geometry.js";
import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { PhysicsSystemTag, type b2ShapeId, type PhysicsState } from "../adapter/state.js";

type EventFlag = "contact" | "hit" | "sensor";

export function installEventOptInSync(world: World, state: PhysicsState, phase: Entity): void {
  world.component(ContactEvents).onAdd((entity) => setEventFlag(state, entity, "contact", true));
  world
    .component(ContactEvents)
    .onRemove((entity) => setEventFlag(state, entity, "contact", false));

  world.component(HitEvents).onAdd((entity) => setEventFlag(state, entity, "hit", true));
  world.component(HitEvents).onRemove((entity) => setEventFlag(state, entity, "hit", false));

  world.component(SensorEvents).onAdd((entity) => setEventFlag(state, entity, "sensor", true));
  world.component(SensorEvents).onRemove((entity) => setEventFlag(state, entity, "sensor", false));

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
  const shape = entity.get(Shape);
  if (shape === undefined || shape instanceof Chain) {
    return;
  }
  const shapeId = shape._shapeId as b2ShapeId | undefined;
  if (shapeId !== undefined) {
    applyEventFlag(state, shapeId, flag, enabled);
  }
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
    case "sensor":
      state.box2d.b2Shape_EnableSensorEvents(shapeId, enabled);
      break;
  }
}
