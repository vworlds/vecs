import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Circle,
  ContactEvents,
  HitEvents,
  LinearVelocity,
  PhysicsModule,
  Position,
  Sensor,
  SensorEvents,
} from "../../src/index.js";
import { getPhysicsEngine } from "../../src/adapter/engine.js";

// Embind values handed out by the event polling APIs. Class handles must be released exactly once.
const OWNED_METHODS = new Set(["GetBeginEvent", "GetEndEvent", "GetHitEvent", "GetMoveEvent"]);
const OWNED_FUNCTIONS = [
  "b2World_GetBodyEvents",
  "b2World_GetContactEvents",
  "b2World_GetSensorEvents",
];

type Handle = { delete: () => void };
type Callable = (...args: unknown[]) => unknown;

function isHandle(value: unknown): value is Handle {
  return typeof value === "object" && value !== null && "delete" in value;
}

/** Tracks creation and release of the owned handles produced by the event APIs. */
function trackOwnedHandles(box2d: object) {
  const live = new Set<Handle>();
  const created = new Map<string, number>();
  const patched = new Set<object>();
  const plain = new Map<string, number>();

  const register = (name: string, value: unknown): unknown => {
    if (!isHandle(value)) {
      plain.set(name, (plain.get(name) ?? 0) + 1);
    }
    if (isHandle(value)) {
      live.add(value);
      created.set(name, (created.get(name) ?? 0) + 1);
      patchPrototypes(Object.getPrototypeOf(value));
    }
    return value;
  };

  const patchPrototypes = (proto: object | null): void => {
    if (proto === null || proto === Object.prototype || patched.has(proto)) {
      return;
    }
    patched.add(proto);
    patchPrototypes(Object.getPrototypeOf(proto));
    for (const key of Object.getOwnPropertyNames(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key)!;
      if (key === "delete" && typeof descriptor.value === "function") {
        const release = descriptor.value as Callable;
        Object.defineProperty(proto, key, {
          ...descriptor,
          value(this: Handle, ...args: unknown[]) {
            live.delete(this);
            return release.apply(this, args);
          },
        });
      } else if (OWNED_METHODS.has(key) && typeof descriptor.value === "function") {
        const method = descriptor.value as Callable;
        Object.defineProperty(proto, key, {
          ...descriptor,
          value(this: unknown, ...args: unknown[]) {
            return register(key, method.apply(this, args));
          },
        });
      }
    }
  };

  const target = box2d as Record<string, Callable>;
  for (const name of OWNED_FUNCTIONS) {
    const original = target[name];
    target[name] = (...args: unknown[]) => register(name, original.apply(box2d, args));
  }
  return { live, created, plain };
}

const STEP_MS = 1000 / 60;

describe("physics event handles", () => {
  it("delivers contact, sensor, hit and body events without any embind event call", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, hitEventThreshold: 0.5 });
    const engine = getPhysicsEngine(world);

    // Contact and hit scene: a box hits a wall, then is sent back out.
    const wallBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 100, y: 0 });
    const wallShape = world
      .entity()
      .childOf(wallBody)
      .set(Box, { width: 2, height: 2 })
      .add(ContactEvents)
      .add(HitEvents);
    const mover = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 103, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    world.entity().childOf(mover).set(Box, { width: 2, height: 2 });

    // Sensor scene: a sensor bullet crosses a sensor wall.
    const sensorWall = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 1.5, y: 11 });
    const sensorWallShape = world
      .entity()
      .childOf(sensorWall)
      .set(Box, { hx: 0.5, hy: 10 })
      .add(SensorEvents);
    const bullet = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 7.39814, y: 4 })
      .set(LinearVelocity, { x: -20, y: 0 });
    const bulletShape = world
      .entity()
      .childOf(bullet)
      .set(Circle, { radius: 0.1 })
      .add(Sensor)
      .add(SensorEvents);

    world.progress(0, STEP_MS);
    const { live, created, plain } = trackOwnedHandles(engine.box2d);

    let sawBegin = false;
    let sawEnd = false;
    let sawHit = false;
    let sawSensor = false;
    for (let tick = 1; tick <= 240; tick++) {
      world.progress(tick * STEP_MS, STEP_MS);
      const events = wallShape.get(ContactEvents)!;
      sawBegin ||= events.begin.length > 0;
      sawEnd ||= events.end.length > 0;
      sawHit ||= wallShape.get(HitEvents)!.hits.length > 0;
      for (const shape of [sensorWallShape, bulletShape]) {
        const sensorEvents = shape.get(SensorEvents)!;
        sawSensor ||= sensorEvents.begin.length + sensorEvents.end.length > 0;
      }
      if (tick === 60) {
        mover.set(LinearVelocity, { x: 10, y: 0 });
      }
    }

    expect(sawBegin).toBe(true);
    expect(sawEnd).toBe(true);
    expect(sawHit).toBe(true);
    expect(sawSensor).toBe(true);
    // The spans and move export create neither event handles nor marshalled value objects.
    expect([...created.keys()]).toEqual([]);
    expect([...plain.keys()]).toEqual([]);
    expect(live.size).toBe(0);
  });
});
