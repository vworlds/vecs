import { type EID, type IPhase, type System, type World } from "@vworlds/vecs";

import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { type b2ShapeId, type PhysicsState } from "../adapter/state.js";

type EventFlag = "contact" | "hit" | "sensor";

export function installEventOptInSync(world: World, state: PhysicsState, phase: IPhase): System {
  world
    .component(ContactEvents)
    .onAdd((entity) => setEventFlag(state, entity.eid, "contact", true));
  world
    .component(ContactEvents)
    .onRemove((entity) => setEventFlag(state, entity.eid, "contact", false));

  world.component(HitEvents).onAdd((entity) => setEventFlag(state, entity.eid, "hit", true));
  world.component(HitEvents).onRemove((entity) => setEventFlag(state, entity.eid, "hit", false));

  world.component(SensorEvents).onAdd((entity) => setEventFlag(state, entity.eid, "sensor", true));
  world
    .component(SensorEvents)
    .onRemove((entity) => setEventFlag(state, entity.eid, "sensor", false));

  return world
    .system("PhysicsEventOptInSync")
    .phase(phase)
    .run(() => {
      // Hook-driven: onAdd/onRemove do the work synchronously during command drain.
    });
}

function setEventFlag(state: PhysicsState, entityId: EID, flag: EventFlag, enabled: boolean): void {
  const shapeId = state.shapeByEntityWasm.get(entityId);
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
