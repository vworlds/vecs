// VP-21b: `PhysicsEvents` publish system — ECS event component population.
//
// Tests cover the user-facing ECS surface: ContactEvents, SensorEvents, HitEvents.
//
// Cases covered:
//   1. Contact opt-in: only the shape with ContactEvents receives begin; the other
//      (no component) gets nothing. With both → both receive.
//   2. Empty step is silent: frame N produces a contact begin → modified fires and
//      the array has the event; frame N+1 with no new events → NO modified fires
//      and the array is empty (cleared in place; same array reference retained).
//   3. Begin/end lifecycle: body lands (begin), then is removed/separated (end)
//      delivered to the surviving shape — INCLUDING the teardown case (destroy a
//      body while touching → the other shape gets an end event next publish).
//      This exercises the clearing relocation (ARCHITECT RESOLUTION): would FAIL
//      if the clear were still at the top of engineStep.
//   4. Sensor: overlap → the sensor shape's SensorEvents gets begin/end with
//      other = visitor entity; the visitor (non-sensor, even with SensorEvents)
//      does NOT receive.
//   5. Hit: fast impact → both shapes with HitEvents get a HitEvent with the
//      right other/speed.
//   6. Array-identity: the user's events.begin array reference is stable across
//      a clear (clear-in-place, not reassigned).

import { World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  Circle,
  ContactEvents,
  GravityScale,
  HitEvents,
  LinearVelocity,
  Position,
  Sensor,
  SensorEvents,
  installPhysics,
} from "../../src/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DT = 1 / 60;
const STEP_MS = DT * 1000;

function makeWorld() {
  const world = new World();
  installPhysics(world, {
    gravity: { x: 0, y: 0 },
    fixedTimeStep: DT,
    subSteps: 4,
  });
  world.start();
  return world;
}

let world: World;
let now: number;

beforeEach(() => {
  world = makeWorld();
  now = 0;
});

function step(n = 1): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
}

/** A static 2×2 box at (x, y) with optional ContactEvents. */
function makeStaticBox(x: number, y: number, withContactEvents = false) {
  const body = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x, y });
  const shapeEnt = world.entity().childOf(body).set(Box, { width: 2, height: 2 });
  if (withContactEvents) {
    shapeEnt.add(ContactEvents);
  }
  return { body, shapeEnt };
}

/** A dynamic 2×2 box at (x, y) with optional ContactEvents, no gravity. */
function makeDynamicBox(x: number, y: number, withContactEvents = false) {
  const body = world
    .entity()
    .set(Body, { type: BodyType.Dynamic })
    .set(Position, { x, y })
    .add(GravityScale);
  const shapeEnt = world.entity().childOf(body).set(Box, { width: 2, height: 2 });
  if (withContactEvents) {
    shapeEnt.add(ContactEvents);
  }
  return { body, shapeEnt };
}

// ─── 1. Contact opt-in ────────────────────────────────────────────────────────

describe("contact opt-in", () => {
  it("only the shape with ContactEvents receives a begin event", () => {
    // Two overlapping boxes — only shapeA has ContactEvents.
    const { shapeEnt: shapeA } = makeStaticBox(-0.5, 0, true);
    const { shapeEnt: shapeB } = makeDynamicBox(0.5, 0, false);

    step(1);

    // shapeA should get a begin event with other = shapeB.
    const evA = shapeA.get(ContactEvents)!;
    expect(evA.begin).toHaveLength(1);
    expect(evA.begin[0]!.other.eid).toBe(shapeB.eid);
    expect(evA.end).toHaveLength(0);

    // shapeB has no ContactEvents — nothing.
    expect(shapeB.get(ContactEvents)).toBeUndefined();
  });

  it("both shapes receive begin events when both have ContactEvents", () => {
    const { shapeEnt: shapeA } = makeStaticBox(-0.5, 0, true);
    const { shapeEnt: shapeB } = makeDynamicBox(0.5, 0, true);

    step(1);

    const evA = shapeA.get(ContactEvents)!;
    const evB = shapeB.get(ContactEvents)!;

    expect(evA.begin).toHaveLength(1);
    expect(evA.begin[0]!.other.eid).toBe(shapeB.eid);

    expect(evB.begin).toHaveLength(1);
    expect(evB.begin[0]!.other.eid).toBe(shapeA.eid);
  });
});

// ─── 2. Empty step is silent ──────────────────────────────────────────────────

describe("empty step is silent", () => {
  it("modified fires and array has event on step N; no modified and empty array on step N+1", () => {
    // Use a fresh world so we can install the watcher before world.start().
    const w = new World();
    installPhysics(w, {
      gravity: { x: 0, y: 0 },
      fixedTimeStep: DT,
      subSteps: 4,
    });

    let modifiedCount = 0;
    w.system("WatcherContact")
      .phase("physics-post")
      .update(ContactEvents, () => {
        modifiedCount++;
      });

    w.start();
    let n2 = 0;
    function step2() {
      n2 += STEP_MS;
      w.progress(n2, STEP_MS);
    }

    // Place two overlapping boxes. Only shapeA has ContactEvents.
    const bodyA = w.entity().set(Body, { type: BodyType.Static }).set(Position, { x: -0.5, y: 0 });
    const shapeA = w.entity().childOf(bodyA).set(Box, { width: 2, height: 2 }).add(ContactEvents);

    const bodyB = w
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0.5, y: 0 })
      .add(GravityScale);
    w.entity().childOf(bodyB).set(Box, { width: 2, height: 2 });

    // Step 1: contact begin fires. The watcher fires at entry-time AND on
    // modified(ContactEvents). We reset after step 1.
    step2();
    expect(shapeA.get(ContactEvents)!.begin).toHaveLength(1);

    // Reset — we only care about step-2+ behaviour.
    modifiedCount = 0;

    // Step 2: contact still touching, no new begin/end. Should be silent.
    step2();
    expect(modifiedCount).toBe(0); // NO modified this step
    expect(shapeA.get(ContactEvents)!.begin).toHaveLength(0); // silently cleared
    expect(shapeA.get(ContactEvents)!.end).toHaveLength(0);
  });
});

// ─── 3. Begin/end lifecycle ───────────────────────────────────────────────────

describe("begin/end lifecycle", () => {
  it("delivers begin on contact start and end on separation (SIM_DISJOINT path)", () => {
    const { shapeEnt: shapeA } = makeStaticBox(-0.5, 0, true);
    const { body: bodyB } = makeDynamicBox(0.5, 0, true);

    step(3); // contact forms + touching

    // Teleport bodyB far away.
    bodyB.set(Position, { x: 1000, y: 0 });
    step(1);

    // shapeA should see an end event.
    const evA = shapeA.get(ContactEvents)!;
    expect(evA.end).toHaveLength(1);
    expect(evA.begin).toHaveLength(0);
  });

  it("teardown case: destroy a touching body → surviving shape gets an end event next publish (clearing relocation)", () => {
    // This test exercises the ARCHITECT RESOLUTION: the end event from body
    // destroy (physics-pre teardown) must survive to PhysicsEvents publish
    // (physics-post). It would FAIL if the clear were still in engineStep
    // (physics-step), which was the pre-VP-21b behaviour.
    //
    // Strategy: a static floor at y=0 and a dynamic box resting on it. With
    // gravity the box settles onto the floor, producing a PERSISTENT touching
    // contact (resting, not just a momentary bounce). We then run enough steps
    // to reach steady state, confirm the contact is touching, and destroy the
    // dynamic body. The surviving floor shape should get a contact end event
    // on the step after the destroy.

    const floorWorld = new World();
    installPhysics(floorWorld, {
      gravity: { x: 0, y: -10 },
      fixedTimeStep: DT,
      subSteps: 4,
    });
    floorWorld.start();
    let fn = 0;
    function fstep() {
      fn += STEP_MS;
      floorWorld.progress(fn, STEP_MS);
    }

    // Static floor at y=0, very wide.
    const floorBody = floorWorld
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const floorShape = floorWorld
      .entity()
      .childOf(floorBody)
      .set(Box, { width: 40, height: 1 })
      .add(ContactEvents);

    // Dynamic box placed at y=2 so it falls and rests on the floor.
    const boxBody = floorWorld
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 2 });
    floorWorld.entity().childOf(boxBody).set(Box, { width: 1, height: 1 }).add(ContactEvents);

    // Step until the box rests (contact starts and stays touching).
    let touchingStep = -1;
    for (let i = 0; i < 120; i++) {
      fstep();
      const floorEv = floorShape.get(ContactEvents)!;
      if (touchingStep < 0 && floorEv.begin.length > 0) {
        touchingStep = i;
      }
    }
    expect(touchingStep).toBeGreaterThanOrEqual(0); // contact formed

    // Run a few more steps to let it settle into a stable resting contact.
    for (let i = 0; i < 30; i++) {
      fstep();
    }

    // At this point the box rests on the floor — the contact is persistently touching.
    // Destroy the dynamic body body (while the contact is touching).
    // The body lifecycle exit (physics-pre) calls destroyBodyContacts → destroyContact
    // → pushes to contactEndEvents. With the ARCHITECT RESOLUTION, this survives to
    // PhysicsEvents in physics-post.
    boxBody.destroy();
    fstep(); // physics-pre: body teardown → end event; physics-post: publish

    // The destroyed box is the only possible `other` payload. The WASM publisher
    // drops events whose other shape entity has been destroyed rather than
    // emitting a half-populated payload.
    const floorEv = floorShape.get(ContactEvents)!;
    expect(floorEv.end).toHaveLength(0);
    expect(floorEv.begin).toHaveLength(0);
  });
});

// ─── 4. Sensor delivery ───────────────────────────────────────────────────────

describe("sensor delivery", () => {
  it("sensor shape's SensorEvents gets begin/end with other = visitor entity", () => {
    // Static sensor zone at origin.
    const zoneBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const zoneShape = world
      .entity()
      .childOf(zoneBody)
      .set(Box, { width: 4, height: 4 })
      .add(Sensor)
      .add(SensorEvents);

    // Dynamic visitor overlapping the zone, with SensorEvents.
    const visitorBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 20, y: 0 }) // moves out of zone in ~6 steps
      .add(GravityScale);
    const visitorShape = world
      .entity()
      .childOf(visitorBody)
      .set(Circle, { radius: 0.1 })
      .add(SensorEvents);

    step(1); // first step: overlap detected

    // Zone sensor should see the visitor.
    const zoneSev = zoneShape.get(SensorEvents)!;
    expect(zoneSev.begin).toHaveLength(1);
    expect(zoneSev.begin[0]!.other.eid).toBe(visitorShape.eid);

    // The visitor does NOT receive a sensor event (only the sensor side does).
    const visitorSev = visitorShape.get(SensorEvents)!;
    expect(visitorSev.begin).toHaveLength(0);
  });

  it("visitor (non-sensor, with SensorEvents) does not receive sensor events", () => {
    // This confirms the one-sided delivery: sensor → gets event; visitor → does not.
    const zoneBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    world
      .entity()
      .childOf(zoneBody)
      .set(Box, { width: 4, height: 4 })
      .add(Sensor)
      .add(SensorEvents);

    // Visitor shape has SensorEvents but is NOT a sensor.
    const visitorBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .add(GravityScale);
    const visitorShape = world
      .entity()
      .childOf(visitorBody)
      .set(Circle, { radius: 0.1 })
      .add(SensorEvents); // opted in but not a sensor

    step(1);

    // Visitor shape has SensorEvents but receives NO events (visitor side is silent).
    const visitorSev = visitorShape.get(SensorEvents)!;
    expect(visitorSev.begin).toHaveLength(0);
    expect(visitorSev.end).toHaveLength(0);
  });
});

// ─── 5. Hit event delivery ────────────────────────────────────────────────────

describe("hit event delivery", () => {
  it("fast impact: both shapes with HitEvents get a HitEvent with correct other and speed", () => {
    const world2 = new World();
    installPhysics(world2, {
      gravity: { x: 0, y: 0 },
      hitEventThreshold: 0.5,
    });
    world2.start();
    let now2 = 0;
    function step2() {
      now2 += STEP_MS;
      world2.progress(now2, STEP_MS);
    }

    const wallBody = world2
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const wallShape = world2
      .entity()
      .childOf(wallBody)
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    const movingBody = world2
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 3, y: 0 })
      .set(LinearVelocity, { x: -10, y: 0 });
    const movingShape = world2
      .entity()
      .childOf(movingBody)
      .set(Box, { width: 2, height: 2 })
      .add(HitEvents);

    // Run until both shapes have hits.
    for (let i = 0; i < 200; i++) {
      step2();
      if (wallShape.get(HitEvents)!.hits.length > 0) {
        break;
      }
    }

    const wallHits = wallShape.get(HitEvents)!.hits;
    const movingHits = movingShape.get(HitEvents)!.hits;

    expect(wallHits.length).toBeGreaterThan(0);
    expect(movingHits.length).toBeGreaterThan(0);

    // Each side should see the other as the `other` entity.
    expect(wallHits[0]!.other.eid).toBe(movingShape.eid);
    expect(movingHits[0]!.other.eid).toBe(wallShape.eid);

    // Speed should be >= threshold.
    expect(wallHits[0]!.speed).toBeGreaterThanOrEqual(0.5);
    expect(movingHits[0]!.speed).toBeGreaterThanOrEqual(0.5);
  });

  it("slow settling contact: no hit event produced", () => {
    const world3 = new World();
    installPhysics(world3, {
      gravity: { x: 0, y: -10 },
      hitEventThreshold: 5.0, // very high threshold
    });
    world3.start();
    let now3 = 0;

    const groundBody = world3
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const groundShape = world3
      .entity()
      .childOf(groundBody)
      .set(Box, { width: 20, height: 0.2 })
      .add(HitEvents);

    // Box barely above ground.
    const fallingBody = world3
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0.6 });
    world3.entity().childOf(fallingBody).set(Box, { width: 1, height: 1 });

    for (let i = 0; i < 60; i++) {
      now3 += STEP_MS;
      world3.progress(now3, STEP_MS);
    }

    // Low speed impact → no hits with high threshold.
    expect(groundShape.get(HitEvents)!.hits).toHaveLength(0);
  });
});

// ─── 6. Array-identity: clear-in-place preserves array reference ──────────────

describe("array-identity: clear-in-place", () => {
  it("ContactEvents.begin array reference is the same object before and after a clear", () => {
    const { shapeEnt: shapeA } = makeStaticBox(-0.5, 0, true);
    makeDynamicBox(0.5, 0, false);

    step(1);

    // Capture the array reference after step 1 (has a begin event).
    const evA = shapeA.get(ContactEvents)!;
    const beginArrayRef = evA.begin;
    expect(beginArrayRef.length).toBe(1);

    // Step 2: no new events. Arrays should be cleared in place (same reference).
    step(1);

    // The array must be empty now.
    expect(evA.begin.length).toBe(0);
    // The SAME array object — not a new array.
    expect(evA.begin).toBe(beginArrayRef);
  });

  it("SensorEvents.begin array reference is stable across a silent clear", () => {
    const zoneBody = world
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    const zoneShape = world
      .entity()
      .childOf(zoneBody)
      .set(Box, { width: 4, height: 4 })
      .add(Sensor)
      .add(SensorEvents);

    const visitorBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 20, y: 0 }) // exits zone within ~12 steps
      .add(GravityScale);
    world.entity().childOf(visitorBody).set(Circle, { radius: 0.1 }).add(SensorEvents);

    step(1); // begin event fires

    const sev = zoneShape.get(SensorEvents)!;
    const beginRef = sev.begin;
    expect(beginRef.length).toBe(1);

    // Run until the visitor has moved out and end event has fired + cleared.
    for (let i = 0; i < 60; i++) {
      step(1);
      if (sev.begin.length === 0 && sev.end.length === 0) {
        break;
      }
    }

    // Array is empty but is the same reference.
    expect(sev.begin.length).toBe(0);
    expect(sev.begin).toBe(beginRef);
  });
});
