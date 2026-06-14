import { type EID, type Entity, type World } from "@vworlds/vecs";

import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { PhysicsSystemTag, type PhysicsEngine } from "../adapter/engine.js";
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

export function installEvents(world: World, engine: PhysicsEngine, phase: Entity): void {
  const system = world
    .system("PhysicsEvents")
    .phase(phase)
    .run(() => {
      const touchedContact = new Set<EID>();
      const touchedSensor = new Set<EID>();
      const touchedHit = new Set<EID>();

      publishContactAndHitEvents(world, engine, touchedContact, touchedHit);
      publishSensorEvents(world, engine, touchedSensor);

      markModified(world, touchedContact, ContactEvents);
      markModified(world, touchedSensor, SensorEvents);
      markModified(world, touchedHit, HitEvents);

      clearUntouchedContactEvents(world, engine.prevTouchedContact, touchedContact);
      clearUntouchedSensorEvents(world, engine.prevTouchedSensor, touchedSensor);
      clearUntouchedHitEvents(world, engine.prevTouchedHit, touchedHit);

      // Store touched sets on engine for the next step's clear pass.
      engine.prevTouchedContact.clear();
      for (const eid of touchedContact) {
        engine.prevTouchedContact.add(eid);
      }
      engine.prevTouchedSensor.clear();
      for (const eid of touchedSensor) {
        engine.prevTouchedSensor.add(eid);
      }
      engine.prevTouchedHit.clear();
      for (const eid of touchedHit) {
        engine.prevTouchedHit.add(eid);
      }
    });
  system.entity.add(PhysicsSystemTag);
}

// Contact begin/end and hit events all come from a single
// `b2World_GetContactEvents` poll, so fetch the event block once per step and
// fan begin/end into `touchedContact` and hits into `touchedHit` (ARCHITECTURE.md ->
// PhysicsEvents: "poll once per step").
function publishContactAndHitEvents(
  world: World,
  engine: PhysicsEngine,
  touchedContact: Set<EID>,
  touchedHit: Set<EID>
): void {
  const events = engine.box2d.b2World_GetContactEvents(engine.worldId);
  try {
    for (let i = 0; i < events.beginCount; i++) {
      const event = events.GetBeginEvent(i);
      try {
        emitContactEvent(world, engine, touchedContact, event, "begin");
      } finally {
        deleteIfPresent(event);
      }
    }

    for (let i = 0; i < events.endCount; i++) {
      const event = events.GetEndEvent(i);
      emitContactEvent(world, engine, touchedContact, event, "end");
    }

    for (let i = 0; i < events.hitCount; i++) {
      const event = events.GetHitEvent(i);
      try {
        emitHitEvent(world, engine, touchedHit, event);
      } finally {
        event.delete();
      }
    }
  } finally {
    events.delete();
  }
}

function publishSensorEvents(world: World, engine: PhysicsEngine, touched: Set<EID>): void {
  const events = engine.box2d.b2World_GetSensorEvents(engine.worldId);
  try {
    for (let i = 0; i < events.beginCount; i++) {
      emitSensorEvent(world, engine, touched, events.GetBeginEvent(i), "begin");
    }
    for (let i = 0; i < events.endCount; i++) {
      emitSensorEvent(world, engine, touched, events.GetEndEvent(i), "end");
    }
  } finally {
    events.delete();
  }
}

function emitContactEvent(
  world: World,
  engine: PhysicsEngine,
  touched: Set<EID>,
  event: ContactBeginEvent | ContactEndEvent,
  kind: "begin" | "end"
): void {
  const entityA = getLiveEntity(world, engine.entityByShapeIndex.get(event.shapeIdA.index1));
  const entityB = getLiveEntity(world, engine.entityByShapeIndex.get(event.shapeIdB.index1));
  if (entityA === undefined || entityB === undefined) {
    return;
  }

  emitContactToEntity(touched, entityA, entityB, kind);
  emitContactToEntity(touched, entityB, entityA, kind);
}

function emitSensorEvent(
  world: World,
  engine: PhysicsEngine,
  touched: Set<EID>,
  event: SensorEvent,
  kind: "begin" | "end"
): void {
  const sensor = getLiveEntity(world, engine.entityByShapeIndex.get(event.sensorShapeId.index1));
  const visitor = getLiveEntity(world, engine.entityByShapeIndex.get(event.visitorShapeId.index1));
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
  engine: PhysicsEngine,
  touched: Set<EID>,
  event: ContactHitEvent
): void {
  const entityA = getLiveEntity(world, engine.entityByShapeIndex.get(event.shapeIdA.index1));
  const entityB = getLiveEntity(world, engine.entityByShapeIndex.get(event.shapeIdB.index1));
  if (entityA === undefined || entityB === undefined) {
    return;
  }

  emitHitToEntity(touched, entityA, entityB, event);
  emitHitToEntity(touched, entityB, entityA, event);
}

function emitContactToEntity(
  touched: Set<EID>,
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
  touched: Set<EID>,
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

function getLiveEntity(world: World, entityId: EID | undefined): Entity | undefined {
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
  touched: Set<EID>,
  component: new () => T
): void {
  for (const entityId of touched) {
    world.getEntity(entityId)?.modified(component);
  }
}

function clearUntouchedContactEvents(
  world: World,
  previouslyTouched: Set<EID>,
  touched: Set<EID>
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
  previouslyTouched: Set<EID>,
  touched: Set<EID>
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
  previouslyTouched: Set<EID>,
  touched: Set<EID>
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
  return entity.destroyed;
}
