import { type Entity, type IPhase, type System, type World } from "@vworlds/vecs";

import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { type PhysicsState } from "../adapter/state.js";
import { type Box2DModule } from "../adapter/runtime.js";

type ContactBeginEvent = ReturnType<
  ReturnType<Box2DModule["b2World_GetContactEvents"]>["GetBeginEvent"]
>;
type ContactEndEvent = ReturnType<
  ReturnType<Box2DModule["b2World_GetContactEvents"]>["GetEndEvent"]
>;
type ContactHitEvent = ReturnType<
  ReturnType<Box2DModule["b2World_GetContactEvents"]>["GetHitEvent"]
>;
type SensorEvent = ReturnType<ReturnType<Box2DModule["b2World_GetSensorEvents"]>["GetBeginEvent"]>;

export function installEvents(world: World, state: PhysicsState, phase: IPhase): System {
  return world
    .system("PhysicsEvents")
    .phase(phase)
    .run(() => {
      const touchedContact = new Set<number>();
      const touchedSensor = new Set<number>();
      const touchedHit = new Set<number>();

      publishContactAndHitEvents(world, state, touchedContact, touchedHit);
      publishSensorEvents(world, state, touchedSensor);

      markModified(world, touchedContact, ContactEvents);
      markModified(world, touchedSensor, SensorEvents);
      markModified(world, touchedHit, HitEvents);

      clearUntouchedContactEvents(world, state.prevTouchedContact, touchedContact);
      clearUntouchedSensorEvents(world, state.prevTouchedSensor, touchedSensor);
      clearUntouchedHitEvents(world, state.prevTouchedHit, touchedHit);

      // Store touched sets on state for the next step's clear pass.
      state.prevTouchedContact.clear();
      for (const eid of touchedContact) {
        state.prevTouchedContact.add(eid);
      }
      state.prevTouchedSensor.clear();
      for (const eid of touchedSensor) {
        state.prevTouchedSensor.add(eid);
      }
      state.prevTouchedHit.clear();
      for (const eid of touchedHit) {
        state.prevTouchedHit.add(eid);
      }
    });
}

// Contact begin/end and hit events all come from a single
// `b2World_GetContactEvents` poll, so fetch the event block once per step and
// fan begin/end into `touchedContact` and hits into `touchedHit` (PLAN.md ->
// PhysicsEvents: "poll once per step").
function publishContactAndHitEvents(
  world: World,
  state: PhysicsState,
  touchedContact: Set<number>,
  touchedHit: Set<number>
): void {
  const events = state.box2d.b2World_GetContactEvents(state.worldId);
  try {
    for (let i = 0; i < events.beginCount; i++) {
      const event = events.GetBeginEvent(i);
      try {
        emitContactEvent(world, state, touchedContact, event, "begin");
      } finally {
        deleteIfPresent(event);
      }
    }

    for (let i = 0; i < events.endCount; i++) {
      const event = events.GetEndEvent(i);
      emitContactEvent(world, state, touchedContact, event, "end");
    }

    for (let i = 0; i < events.hitCount; i++) {
      const event = events.GetHitEvent(i);
      try {
        emitHitEvent(world, state, touchedHit, event);
      } finally {
        event.delete();
      }
    }
  } finally {
    events.delete();
  }
}

function publishSensorEvents(world: World, state: PhysicsState, touched: Set<number>): void {
  const events = state.box2d.b2World_GetSensorEvents(state.worldId);
  try {
    for (let i = 0; i < events.beginCount; i++) {
      emitSensorEvent(world, state, touched, events.GetBeginEvent(i), "begin");
    }
    for (let i = 0; i < events.endCount; i++) {
      emitSensorEvent(world, state, touched, events.GetEndEvent(i), "end");
    }
  } finally {
    events.delete();
  }
}

function emitContactEvent(
  world: World,
  state: PhysicsState,
  touched: Set<number>,
  event: ContactBeginEvent | ContactEndEvent,
  kind: "begin" | "end"
): void {
  const entityA = getLiveEntity(world, state.entityByShapeIndex.get(event.shapeIdA.index1));
  const entityB = getLiveEntity(world, state.entityByShapeIndex.get(event.shapeIdB.index1));
  if (entityA === undefined || entityB === undefined) {
    return;
  }

  emitContactToEntity(touched, entityA, entityB, kind);
  emitContactToEntity(touched, entityB, entityA, kind);
}

function emitSensorEvent(
  world: World,
  state: PhysicsState,
  touched: Set<number>,
  event: SensorEvent,
  kind: "begin" | "end"
): void {
  const sensor = getLiveEntity(world, state.entityByShapeIndex.get(event.sensorShapeId.index1));
  const visitor = getLiveEntity(world, state.entityByShapeIndex.get(event.visitorShapeId.index1));
  if (sensor === undefined || visitor === undefined) {
    return;
  }

  const events = sensor.get(SensorEvents) as SensorEvents | undefined;
  if (events === undefined) {
    return;
  }

  if (!touched.has(sensor.eid)) {
    events.begin.length = 0;
    events.end.length = 0;
    touched.add(sensor.eid);
  }

  if (kind === "begin") {
    events.begin.push({ other: visitor });
  } else {
    events.end.push({ other: visitor });
  }
}

function emitHitEvent(
  world: World,
  state: PhysicsState,
  touched: Set<number>,
  event: ContactHitEvent
): void {
  const entityA = getLiveEntity(world, state.entityByShapeIndex.get(event.shapeIdA.index1));
  const entityB = getLiveEntity(world, state.entityByShapeIndex.get(event.shapeIdB.index1));
  if (entityA === undefined || entityB === undefined) {
    return;
  }

  emitHitToEntity(touched, entityA, entityB, event);
  emitHitToEntity(touched, entityB, entityA, event);
}

function emitContactToEntity(
  touched: Set<number>,
  entity: Entity,
  other: Entity,
  kind: "begin" | "end"
): void {
  const events = entity.get(ContactEvents) as ContactEvents | undefined;
  if (events === undefined) {
    return;
  }

  if (!touched.has(entity.eid)) {
    events.begin.length = 0;
    events.end.length = 0;
    touched.add(entity.eid);
  }

  if (kind === "begin") {
    events.begin.push({ other });
  } else {
    events.end.push({ other });
  }
}

function emitHitToEntity(
  touched: Set<number>,
  entity: Entity,
  other: Entity,
  event: ContactHitEvent
): void {
  const events = entity.get(HitEvents) as HitEvents | undefined;
  if (events === undefined) {
    return;
  }

  if (!touched.has(entity.eid)) {
    events.hits.length = 0;
    touched.add(entity.eid);
  }

  events.hits.push({
    other,
    x: event.point.x,
    y: event.point.y,
    normalX: event.normal.x,
    normalY: event.normal.y,
    speed: event.approachSpeed,
  });
}

function getLiveEntity(world: World, entityId: number | undefined): Entity | undefined {
  if (entityId === undefined) {
    return undefined;
  }

  const entity = world.getEntity(entityId);
  if (entity === undefined || isDestroyed(entity)) {
    return undefined;
  }
  return entity;
}

function markModified<T extends object>(
  world: World,
  touched: Set<number>,
  component: new () => T
): void {
  for (const entityId of touched) {
    world.getEntity(entityId)?.modified(component);
  }
}

function clearUntouchedContactEvents(
  world: World,
  previouslyTouched: Set<number>,
  touched: Set<number>
): void {
  for (const entityId of previouslyTouched) {
    if (touched.has(entityId)) {
      continue;
    }
    const events = world.getEntity(entityId)?.get(ContactEvents) as ContactEvents | undefined;
    if (events !== undefined) {
      events.begin.length = 0;
      events.end.length = 0;
    }
  }
}

function clearUntouchedSensorEvents(
  world: World,
  previouslyTouched: Set<number>,
  touched: Set<number>
): void {
  for (const entityId of previouslyTouched) {
    if (touched.has(entityId)) {
      continue;
    }
    const events = world.getEntity(entityId)?.get(SensorEvents) as SensorEvents | undefined;
    if (events !== undefined) {
      events.begin.length = 0;
      events.end.length = 0;
    }
  }
}

function clearUntouchedHitEvents(
  world: World,
  previouslyTouched: Set<number>,
  touched: Set<number>
): void {
  for (const entityId of previouslyTouched) {
    if (touched.has(entityId)) {
      continue;
    }
    const events = world.getEntity(entityId)?.get(HitEvents) as HitEvents | undefined;
    if (events !== undefined) {
      events.hits.length = 0;
    }
  }
}

function deleteIfPresent(value: { delete?: () => void }): void {
  value.delete?.();
}

function isDestroyed(entity: Entity): boolean {
  return (entity as unknown as { _destroyed?: boolean })._destroyed === true;
}
