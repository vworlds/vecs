import { Module, type EID, type Entity, type World } from "@vworlds/vecs";

import { ContactEvents, HitEvents, SensorEvents } from "./components.js";
import { getPhysicsEngine, PhysicsSystemTag, type PhysicsEngine } from "../adapter/engine.js";
import { PhysicsCoreModule } from "../core/module.js";
import { EventsModule } from "./module.js";

/** Word offsets into event records and span headers, from the generated layout. */
interface EventOffsets {
  contact: {
    beginPtr: number;
    beginCount: number;
    endPtr: number;
    endCount: number;
    hitPtr: number;
    hitCount: number;
  };
  sensor: { beginPtr: number; beginCount: number; endPtr: number; endCount: number };
  begin: PairOffsets;
  end: PairOffsets;
  hit: HitOffsets;
  sensorBegin: PairOffsets;
  sensorEnd: PairOffsets;
}

/** Word stride and word offsets of a record's shape index1 pair. */
interface PairOffsets {
  stride: number;
  a: number;
  b: number;
}

interface HitOffsets extends PairOffsets {
  pointX: number;
  pointY: number;
  normalX: number;
  normalY: number;
  approachSpeed: number;
}

/** Read contact/hit/sensor spans once per tick and publish fresh public event records in order.
 * Native reads allocate no per-event wrappers; event components retain clear-in-place arrays
 * and are marked modified once per receiving entity with new events. */
export class EventPublishModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);
    world.module(EventsModule);

    const engine = getPhysicsEngine(world);
    const offsets = eventOffsets(engine);
    // Span headers and touched sets are allocated once and reused each step.
    const spans = engine.fast.alloc(
      engine.fast.layout.contactSpans.size + engine.fast.layout.sensorSpans.size
    );
    const sensorSpans = spans + engine.fast.layout.contactSpans.size;
    const touchedContact = new Set<EID>();
    const touchedSensor = new Set<EID>();
    const touchedHit = new Set<EID>();
    world
      .system("PhysicsEvents")
      .phase(engine.phases.postStep)
      .run(() => {
        clearSet(touchedContact);
        clearSet(touchedSensor);
        clearSet(touchedHit);

        engine.box2d._b2x_World_GetContactSpans(engine.world, spans);
        engine.box2d._b2x_World_GetSensorSpans(engine.world, sensorSpans);
        engine.fast.sync();
        publishContactAndHitEvents(world, engine, spans, offsets, touchedContact, touchedHit);
        publishSensorEvents(world, engine, sensorSpans, offsets, touchedSensor);

        markModified(world, touchedContact, ContactEvents);
        markModified(world, touchedSensor, SensorEvents);
        markModified(world, touchedHit, HitEvents);

        clearUntouchedContactEvents(world, engine.prevTouchedContact, touchedContact);
        clearUntouchedSensorEvents(world, engine.prevTouchedSensor, touchedSensor);
        clearUntouchedHitEvents(world, engine.prevTouchedHit, touchedHit);

        // Store touched sets on engine for the next step's clear pass.
        copySet(engine.prevTouchedContact, touchedContact);
        copySet(engine.prevTouchedSensor, touchedSensor);
        copySet(engine.prevTouchedHit, touchedHit);
      })
      .entity.add(PhysicsSystemTag);
  }
}

function eventOffsets(engine: PhysicsEngine): EventOffsets {
  const L = engine.fast.layout;
  const pair = (s: { size: number }, a: number, b: number): PairOffsets => ({
    stride: s.size >> 2,
    a: a >> 2,
    b: b >> 2,
  });
  const words = <T extends Record<string, number>>(o: T): T =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v >> 2])) as T;
  return {
    contact: words({
      beginPtr: L.contactSpans.beginPtr,
      beginCount: L.contactSpans.beginCount,
      endPtr: L.contactSpans.endPtr,
      endCount: L.contactSpans.endCount,
      hitPtr: L.contactSpans.hitPtr,
      hitCount: L.contactSpans.hitCount,
    }),
    sensor: words({
      beginPtr: L.sensorSpans.beginPtr,
      beginCount: L.sensorSpans.beginCount,
      endPtr: L.sensorSpans.endPtr,
      endCount: L.sensorSpans.endCount,
    }),
    begin: pair(L.contactBegin, L.contactBegin.shapeA, L.contactBegin.shapeB),
    end: pair(L.contactEnd, L.contactEnd.shapeA, L.contactEnd.shapeB),
    hit: {
      ...pair(L.contactHit, L.contactHit.shapeA, L.contactHit.shapeB),
      pointX: L.contactHit.pointX >> 2,
      pointY: L.contactHit.pointY >> 2,
      normalX: L.contactHit.normalX >> 2,
      normalY: L.contactHit.normalY >> 2,
      approachSpeed: L.contactHit.approachSpeed >> 2,
    },
    sensorBegin: pair(L.sensorBegin, L.sensorBegin.sensorShape, L.sensorBegin.visitorShape),
    sensorEnd: pair(L.sensorEnd, L.sensorEnd.sensorShape, L.sensorEnd.visitorShape),
  };
}

// Poll once per step, reading Box2D's own arrays in begin/end/hit order. Spans are valid
// until the next step or world mutation; the loop does not call allocating Box2D APIs.
function publishContactAndHitEvents(
  world: World,
  engine: PhysicsEngine,
  spans: number,
  offsets: EventOffsets,
  touchedContact: Set<EID>,
  touchedHit: Set<EID>
): void {
  const fast = engine.fast;
  const i32 = fast.i32;
  const u32 = fast.u32;
  const f32 = fast.f32;
  const header = spans >> 2;
  const c = offsets.contact;
  const begin = offsets.begin;
  let at = u32[header + c.beginPtr]! >> 2;
  for (let i = 0, n = i32[header + c.beginCount]!; i < n; i++, at += begin.stride) {
    emitContactEvent(
      world,
      engine,
      touchedContact,
      i32[at + begin.a]!,
      i32[at + begin.b]!,
      "begin"
    );
  }
  const end = offsets.end;
  at = u32[header + c.endPtr]! >> 2;
  for (let i = 0, n = i32[header + c.endCount]!; i < n; i++, at += end.stride) {
    emitContactEvent(world, engine, touchedContact, i32[at + end.a]!, i32[at + end.b]!, "end");
  }
  const hit = offsets.hit;
  at = u32[header + c.hitPtr]! >> 2;
  for (let i = 0, n = i32[header + c.hitCount]!; i < n; i++, at += hit.stride) {
    emitHitEvent(world, engine, touchedHit, i32, f32, at, hit);
  }
}

function publishSensorEvents(
  world: World,
  engine: PhysicsEngine,
  spans: number,
  offsets: EventOffsets,
  touched: Set<EID>
): void {
  const fast = engine.fast;
  const i32 = fast.i32;
  const u32 = fast.u32;
  const header = spans >> 2;
  const s = offsets.sensor;
  const begin = offsets.sensorBegin;
  let at = u32[header + s.beginPtr]! >> 2;
  for (let i = 0, n = i32[header + s.beginCount]!; i < n; i++, at += begin.stride) {
    emitSensorEvent(world, engine, touched, i32[at + begin.a]!, i32[at + begin.b]!, "begin");
  }
  const end = offsets.sensorEnd;
  at = u32[header + s.endPtr]! >> 2;
  for (let i = 0, n = i32[header + s.endCount]!; i < n; i++, at += end.stride) {
    emitSensorEvent(world, engine, touched, i32[at + end.a]!, i32[at + end.b]!, "end");
  }
}

function emitContactEvent(
  world: World,
  engine: PhysicsEngine,
  touched: Set<EID>,
  shapeA: number,
  shapeB: number,
  kind: "begin" | "end"
): void {
  const entityA = getLiveEntity(world, engine.entityByShapeIndex.get(shapeA));
  const entityB = getLiveEntity(world, engine.entityByShapeIndex.get(shapeB));
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
  sensorShape: number,
  visitorShape: number,
  kind: "begin" | "end"
): void {
  const sensor = getLiveEntity(world, engine.entityByShapeIndex.get(sensorShape));
  const visitor = getLiveEntity(world, engine.entityByShapeIndex.get(visitorShape));
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
  i32: Int32Array,
  f32: Float32Array,
  at: number,
  hit: HitOffsets
): void {
  const entityA = getLiveEntity(world, engine.entityByShapeIndex.get(i32[at + hit.a]!));
  const entityB = getLiveEntity(world, engine.entityByShapeIndex.get(i32[at + hit.b]!));
  if (entityA === undefined || entityB === undefined) {
    return;
  }

  emitHitToEntity(touched, entityA, entityB, f32, at, hit);
  emitHitToEntity(touched, entityB, entityA, f32, at, hit);
}

/** Avoid replacing V8's Set backing table when there is nothing to clear. */
function clearSet(set: Set<EID>): void {
  if (set.size > 0) {
    set.clear();
  }
}

function copySet(target: Set<EID>, source: Set<EID>): void {
  clearSet(target);
  if (source.size === 0) {
    return;
  }
  for (const eid of source) {
    target.add(eid);
  }
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
  f32: Float32Array,
  at: number,
  hit: HitOffsets
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
    x: f32[at + hit.pointX]!,
    y: f32[at + hit.pointY]!,
    normalX: f32[at + hit.normalX]!,
    normalY: f32[at + hit.normalY]!,
    speed: f32[at + hit.approachSpeed]!,
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
  if (touched.size === 0) {
    return;
  }
  for (const entityId of touched) {
    world.getEntity(entityId)?.modified(component);
  }
}

function clearUntouchedContactEvents(
  world: World,
  previouslyTouched: Set<EID>,
  touched: Set<EID>
): void {
  if (previouslyTouched.size === 0) {
    return;
  }
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
  if (previouslyTouched.size === 0) {
    return;
  }
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
  if (previouslyTouched.size === 0) {
    return;
  }
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

function isDestroyed(entity: Entity): boolean {
  return entity.destroyed;
}
