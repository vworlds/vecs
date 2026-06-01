import { type Entity, type IPhase, type System, type World } from "@vworlds/vecs";

import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { type b2ShapeId, type PhysicsState } from "../adapter/state.js";
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
type LegacyTouchEvent = {
  shapeA: { index: number; generation: number };
  shapeB: { index: number; generation: number };
  entityEidA: number;
  entityEidB: number;
};
type LegacySensorEvent = {
  sensorShape: { index: number; generation: number };
  visitorShape: { index: number; generation: number };
  sensorEntityEid: number;
  visitorEntityEid: number;
};
type LegacyHitEvent = LegacyTouchEvent & {
  pointX: number;
  pointY: number;
  normalX: number;
  normalY: number;
  approachSpeed: number;
};

export function installEvents(world: World, state: PhysicsState, phase: IPhase): System {
  let previouslyTouchedContact = new Set<number>();
  let previouslyTouchedSensor = new Set<number>();
  let previouslyTouchedHit = new Set<number>();

  return world
    .system("PhysicsEvents")
    .phase(phase)
    .run(() => {
      const touchedContact = new Set<number>();
      const touchedSensor = new Set<number>();
      const touchedHit = new Set<number>();

      publishContactEvents(world, state, touchedContact);
      publishSensorEvents(world, state, touchedSensor);
      publishHitEvents(world, state, touchedHit);
      publishLegacyTeardownEvents(state, touchedContact, touchedSensor, touchedHit);

      markModified(world, touchedContact, ContactEvents);
      markModified(world, touchedSensor, SensorEvents);
      markModified(world, touchedHit, HitEvents);

      clearUntouchedContactEvents(world, previouslyTouchedContact, touchedContact);
      clearUntouchedSensorEvents(world, previouslyTouchedSensor, touchedSensor);
      clearUntouchedHitEvents(world, previouslyTouchedHit, touchedHit);

      previouslyTouchedContact = touchedContact;
      previouslyTouchedSensor = touchedSensor;
      previouslyTouchedHit = touchedHit;

      state.contactBeginEvents.length = 0;
      state.contactEndEvents.length = 0;
      state.sensorBeginEvents.length = 0;
      state.sensorEndEvents.length = 0;
      state.contactHitEvents.length = 0;
    });
}

function publishContactEvents(world: World, state: PhysicsState, touched: Set<number>): void {
  const events = state.box2d.b2World_GetContactEvents(state.worldId);
  try {
    for (let i = 0; i < events.beginCount; i++) {
      const event = events.GetBeginEvent(i);
      try {
        emitContactEvent(world, state, touched, event, "begin");
      } finally {
        deleteIfPresent(event);
      }
    }

    for (let i = 0; i < events.endCount; i++) {
      const event = events.GetEndEvent(i);
      emitContactEvent(world, state, touched, event, "end");
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

function publishHitEvents(world: World, state: PhysicsState, touched: Set<number>): void {
  const events = state.box2d.b2World_GetContactEvents(state.worldId);
  try {
    for (let i = 0; i < events.hitCount; i++) {
      const event = events.GetHitEvent(i);
      try {
        emitHitEvent(world, state, touched, event);
      } finally {
        event.delete();
      }
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
  const entityA = resolveShapeEntity(world, state, event.shapeIdA);
  const entityB = resolveShapeEntity(world, state, event.shapeIdB);
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
  const sensor = resolveShapeEntity(world, state, event.sensorShapeId);
  const visitor = resolveShapeEntity(world, state, event.visitorShapeId);
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
  const entityA = resolveShapeEntity(world, state, event.shapeIdA);
  const entityB = resolveShapeEntity(world, state, event.shapeIdB);
  if (entityA === undefined || entityB === undefined) {
    return;
  }

  emitHitToEntity(touched, entityA, entityB, event);
  emitHitToEntity(touched, entityB, entityA, event);
}

function publishLegacyTeardownEvents(
  state: PhysicsState,
  touchedContact: Set<number>,
  touchedSensor: Set<number>,
  touchedHit: Set<number>
): void {
  for (const event of state.contactBeginEvents) {
    emitLegacyContactEvent(state, touchedContact, event, "begin");
  }
  for (const event of state.contactEndEvents) {
    emitLegacyContactEvent(state, touchedContact, event, "end");
  }
  for (const event of state.sensorBeginEvents) {
    emitLegacySensorEvent(state, touchedSensor, event, "begin");
  }
  for (const event of state.sensorEndEvents) {
    emitLegacySensorEvent(state, touchedSensor, event, "end");
  }
  for (const event of state.contactHitEvents) {
    emitLegacyHitEvent(state, touchedHit, event);
  }
}

function emitLegacyContactEvent(
  state: PhysicsState,
  touched: Set<number>,
  event: LegacyTouchEvent,
  kind: "begin" | "end"
): void {
  const entityA = resolveLegacyShapeEntity(state, event.shapeA, event.entityEidA);
  const entityB = resolveLegacyShapeEntity(state, event.shapeB, event.entityEidB);
  if (entityA === undefined || entityB === undefined) {
    return;
  }

  emitContactToEntity(touched, entityA, entityB, kind);
  emitContactToEntity(touched, entityB, entityA, kind);
}

function emitLegacySensorEvent(
  state: PhysicsState,
  touched: Set<number>,
  event: LegacySensorEvent,
  kind: "begin" | "end"
): void {
  const sensor = resolveLegacyShapeEntity(state, event.sensorShape, event.sensorEntityEid);
  const visitor = resolveLegacyShapeEntity(state, event.visitorShape, event.visitorEntityEid);
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

function emitLegacyHitEvent(
  state: PhysicsState,
  touched: Set<number>,
  event: LegacyHitEvent
): void {
  const entityA = resolveLegacyShapeEntity(state, event.shapeA, event.entityEidA);
  const entityB = resolveLegacyShapeEntity(state, event.shapeB, event.entityEidB);
  if (entityA === undefined || entityB === undefined) {
    return;
  }

  emitLegacyHitToEntity(touched, entityA, entityB, event);
  emitLegacyHitToEntity(touched, entityB, entityA, event);
}

function emitLegacyHitToEntity(
  touched: Set<number>,
  entity: Entity,
  other: Entity,
  event: LegacyHitEvent
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
    x: event.pointX,
    y: event.pointY,
    normalX: event.normalX,
    normalY: event.normalY,
    speed: event.approachSpeed,
  });
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

function resolveShapeEntity(
  world: World,
  state: PhysicsState,
  shapeId: b2ShapeId
): Entity | undefined {
  const entityId = resolveShapeEntityId(state, shapeId);
  if (entityId === undefined) {
    return undefined;
  }

  const entity = world.getEntity(entityId);
  if (entity === undefined || isDestroyed(entity)) {
    return undefined;
  }
  return entity;
}

function resolveShapeEntityId(state: PhysicsState, shapeId: b2ShapeId): number | undefined {
  const direct = state.entityByShape.get(shapeId);
  if (direct !== undefined) {
    return direct;
  }

  for (const [knownShapeId, entityId] of state.entityByShape) {
    if (sameShapeId(knownShapeId, shapeId)) {
      return entityId;
    }
  }
  return undefined;
}

function resolveLegacyShapeEntity(
  state: PhysicsState,
  shape: { index: number; generation: number },
  entityId: number
): Entity | undefined {
  if (!state.shapes.idPool.isValid(shape as never)) {
    return undefined;
  }
  return state.shapeEntityByEid.get(entityId);
}

function sameShapeId(a: b2ShapeId, b: b2ShapeId): boolean {
  return a.index1 === b.index1 && a.world0 === b.world0 && a.generation === b.generation;
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
