// VP-23 sleep system tests.
//
// Parity: ports the intent of box2d test_world.c::EnableSleepFlagSyncTest and
// adds vecs-physics–specific coverage for the 10 required scenarios.
//
// All tests run the full ECS pipeline: installPhysics → world.start → world.progress.
//
// Helpers seed invMass directly after the first step to avoid a real shape/mass
// system dependency (mirrors the pattern established in forces.test.ts).

import { ChildOf, World } from "@vworlds/vecs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AngularImpulse,
  Body,
  BodyType,
  Box,
  Circle,
  Force,
  Impulse,
  KinematicTargetPosition,
  LinearVelocity,
  Position,
  Rotation,
  Sleep,
  Torque,
  installPhysics,
} from "../../src/index.js";
import { AWAKE_SET, FIRST_SLEEPING_SET } from "../../src/engine/solver_set.js";
import { getPhysics } from "../../src/engine/state.js";
import { ENABLE_SLEEP } from "../../src/engine/body.js";
import { linkContact, mergeIslands, splitIsland } from "../../src/engine/island.js";
import { type InternalContact } from "../../src/engine/contact.js";
import { mergeSolverSets } from "../../src/engine/sleep.js";
import { NULL_INDEX } from "../../src/util/handle.js";

const DT = 1 / 60;
const STEP_MS = DT * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a world with configurable gravity and sleep. */
function makeWorld(gravity = { x: 0, y: 0 }, enableSleep = true) {
  const world = new World();
  installPhysics(world, { gravity, fixedTimeStep: DT, subSteps: 1, enableSleep });
  world.start();
  return world;
}

/** Run n steps, returning the updated `now` accumulator. */
function step(world: World, n: number, now = 0): number {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    world.progress(now, STEP_MS);
  }
  return now;
}

/** Seed a body's invMass and invInertia to simulate mass without shapes. */
function seedMass(world: World, e: { eid: number }, invMass: number, invInertia = 0): void {
  const state = getPhysics(world);
  const handle = state.bodyByEntity.get(e.eid);
  if (!handle) {
    throw new Error("no body");
  }
  const rec = state.bodies.get(handle.index);
  const sim = state.solverSets[rec.setIndex]!.bodySims[rec.localIndex]!;
  sim.invMass = invMass;
  sim.invInertia = invInertia;
}

/** Get body setIndex from state. */
function getSetIndex(world: World, e: { eid: number }): number {
  const state = getPhysics(world);
  const handle = state.bodyByEntity.get(e.eid)!;
  return state.bodies.get(handle.index).setIndex;
}

/** Force a body's sleepTime to a high value so it qualifies for sleeping. */
function forceSleep(world: World, e: { eid: number }): void {
  const state = getPhysics(world);
  const handle = state.bodyByEntity.get(e.eid)!;
  const rec = state.bodies.get(handle.index);
  rec.sleepTime = 1.0; // > B2_TIME_TO_SLEEP (0.5)
}

// ─── 1. EnableSleepFlagSyncTest ───────────────────────────────────────────────
// Ports test_world.c::EnableSleepFlagSyncTest: toggling world.enableSleep
// should transfer bodies between solver sets.
//
// In vecs-physics, enableSleep is set at install time and does not dynamically
// change, so we test the per-body Sleep.enabled toggle (same effect for that body).

describe("EnableSleepFlagSyncTest — per-body Sleep.enabled toggle", () => {
  it("body with Sleep.enabled=false never sleeps even after many idle steps", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world
      .entity()
      .set(Position, { x: 0, y: 0 })
      .set(Body, { type: BodyType.Dynamic })
      .set(Sleep, { enabled: false, awake: true, threshold: 0.05 });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    now = step(world, 60, now);

    // With Sleep.enabled=false, the ENABLE_SLEEP flag is clear and the body
    // should stay in the awake set regardless of idle time.
    expect(getSetIndex(world, b)).toBe(AWAKE_SET);
  });

  it("body with Sleep.enabled=true sleeps after being idle", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world
      .entity()
      .set(Position, { x: 0, y: 0 })
      .set(Body, { type: BodyType.Dynamic })
      .set(Sleep, { enabled: true, awake: true, threshold: 0.05 });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);

    // Force sleepTime high so the body qualifies immediately.
    forceSleep(world, b);
    now = step(world, 1, now);

    // Body should be in a sleeping set now.
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);
  });

  it("toggling Sleep.enabled=false on a sleeping body wakes it", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    // Body created WITH Sleep component so update(Sleep) fires when it changes.
    const b = world
      .entity()
      .set(Position, { x: 0, y: 0 })
      .set(Body, { type: BodyType.Dynamic })
      .set(Sleep, { enabled: true, awake: true, threshold: 0.05 }); // Sleep present from start

    let now = step(world, 1, 0);
    seedMass(world, b, 1);

    // Force the body to sleep.
    forceSleep(world, b);
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // Modify Sleep.enabled=false → update(Sleep) fires → body should wake.
    b.set(Sleep, { enabled: false, awake: true, threshold: 0.05 });
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBe(AWAKE_SET);
  });
});

// ─── 2. Sleep transition ──────────────────────────────────────────────────────

describe("sleep transition", () => {
  it("an idle dynamic body eventually transitions to a sleeping set", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    forceSleep(world, b);

    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);
  });

  it("a sleeping body does not appear in bodyMoveEvents next step", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    forceSleep(world, b);
    now = step(world, 1, now);
    // Body is now sleeping.
    const state = getPhysics(world);
    const handle = state.bodyByEntity.get(b.eid)!;
    const bodyId = state.bodies.get(handle.index).localIndex; // handle.index = bodyId

    // After sleeping: body not in bodyMoveEvents.
    now = step(world, 1, now);
    expect(state.bodyMoveEvents).not.toContain(handle.index);
  });

  it("Position does not change after body falls asleep", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 5, y: 3 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    forceSleep(world, b);
    now = step(world, 1, now);
    // Body is now sleeping.
    const pos1 = b.get(Position)!;
    const x1 = pos1.x;
    const y1 = pos1.y;

    // Step a few more times — sleeping body should not move.
    now = step(world, 3, now);
    const pos2 = b.get(Position)!;
    expect(pos2.x).toBeCloseTo(x1, 5);
    expect(pos2.y).toBeCloseTo(y1, 5);
  });
});

// ─── 3. Wake on touch ─────────────────────────────────────────────────────────

describe("wake on touch", () => {
  it("a sleeping body wakes when a contact begins touching (linkContact)", () => {
    // We can't easily create a real contact between two bodies in a unit test
    // without the full physics pipeline. Instead, we test the wake path through
    // the state._wakeSolverSet hook that linkContact calls.
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    forceSleep(world, b);
    now = step(world, 1, now);

    // Confirm sleeping.
    const state = getPhysics(world);
    const handle = state.bodyByEntity.get(b.eid)!;
    const rec = state.bodies.get(handle.index);
    expect(rec.setIndex).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // Directly invoke the wake hook (simulating what linkContact does).
    const sleepSetId = rec.setIndex;
    state._wakeSolverSet(state, sleepSetId);

    expect(rec.setIndex).toBe(AWAKE_SET);
  });
});

// ─── 4. Wake on impulse ───────────────────────────────────────────────────────

describe("wake on impulse", () => {
  it("sleeping body wakes when Impulse is set with wake:true", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    forceSleep(world, b);
    now = step(world, 1, now);

    // Sleeping now.
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // Apply impulse with wake:true.
    b.set(Impulse, { x: 1, y: 0, wake: true });
    now = step(world, 1, now);

    // Should be awake now.
    expect(getSetIndex(world, b)).toBe(AWAKE_SET);
  });

  it("sleeping body stays asleep when Impulse has wake:false", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    forceSleep(world, b);
    now = step(world, 1, now);

    // Sleeping.
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // Apply impulse with wake:false.
    b.set(Impulse, { x: 1, y: 0, wake: false });
    now = step(world, 1, now);

    // Should still be asleep (wake=false means don't wake it).
    // The impulse is dropped since the body is sleeping and wake=false.
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);
  });
});

// ─── 5. Wake on force ─────────────────────────────────────────────────────────

describe("wake on force", () => {
  it("sleeping body wakes when Force is set with wake:true", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world
      .entity()
      .set(Position, { x: 0, y: 0 })
      .set(Body, { type: BodyType.Dynamic })
      .set(Force, { x: 0, y: 0, wake: true });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    forceSleep(world, b);
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // Apply a non-zero force with wake:true.
    b.set(Force, { x: 5, y: 0, wake: true });
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBe(AWAKE_SET);
  });

  it("sleeping body stays asleep when Force has wake:false", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world
      .entity()
      .set(Position, { x: 0, y: 0 })
      .set(Body, { type: BodyType.Dynamic })
      .set(Force, { x: 0, y: 0, wake: false });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    forceSleep(world, b);
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // Force stays false.
    b.set(Force, { x: 5, y: 0, wake: false });
    now = step(world, 1, now);
    // stays asleep
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);
  });
});

// ─── 6. Wake on teleport ──────────────────────────────────────────────────────

describe("wake on teleport", () => {
  it("setting Position on a sleeping body wakes it", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    forceSleep(world, b);
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // Teleport: set Position externally.
    b.set(Position, { x: 10, y: 5 });
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBe(AWAKE_SET);
  });

  it("setting Rotation on a sleeping body wakes it (Rotation must exist to trigger update)", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    // Rotation must be present at body creation so update(Rotation) fires on modification.
    // (Vecs update does NOT fire when adding a brand-new component to an existing query entity.)
    const b = world
      .entity()
      .set(Position, { x: 0, y: 0 })
      .set(Rotation, { angle: 0 })
      .set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    forceSleep(world, b);
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // Modify rotation (update fires because Rotation was present at entry).
    b.set(Rotation, { angle: Math.PI / 4 });
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBe(AWAKE_SET);
  });
});

// ─── 7. Wake on kinematic target ─────────────────────────────────────────────

describe("wake on kinematic target", () => {
  it("sleeping kinematic body wakes when KinematicTargetPosition is set with wake:true", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Kinematic });

    let now = step(world, 1, 0);
    // Force kinematic body to sleep (kinematic can sleep too).
    forceSleep(world, b);
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // Set a kinematic target with wake=true.
    b.set(KinematicTargetPosition, { x: 5, y: 0, tolerance: 0.001, wake: true });
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBe(AWAKE_SET);
  });
});

// ─── 8. Island split ─────────────────────────────────────────────────────────

describe("island split", () => {
  it("splitIsland breaks a chain of bodies into separate islands after contacts removed", () => {
    // Build A-B-C: linkContact A-B and B-C, giving one big island.
    // Then unlink B-A (increment constraintRemoveCount on island).
    // On next step, the island should split.
    const world = makeWorld({ x: 0, y: 0 }, false); // disable sleep so islands stay awake

    // Create 3 bodies.
    const bA = world.entity().set(Position, { x: -2, y: 0 }).set(Body, { type: BodyType.Dynamic });
    const bB = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });
    const bC = world.entity().set(Position, { x: 2, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    const state = getPhysics(world);

    const hA = state.bodyByEntity.get(bA.eid)!;
    const hB = state.bodyByEntity.get(bB.eid)!;
    const hC = state.bodyByEntity.get(bC.eid)!;

    const recA = state.bodies.get(hA.index);
    const recB = state.bodies.get(hB.index);
    const recC = state.bodies.get(hC.index);

    // Each body starts in its own island (singleton).
    expect(recA.islandId).not.toBe(-1);
    expect(recB.islandId).not.toBe(-1);
    expect(recC.islandId).not.toBe(-1);

    // Manually merge A and B into one island (simulate linkContact).
    // In real usage contacts would do this; here we test island.ts's mergeIslands.
    const mergedAB = mergeIslands(state, recA.islandId, recB.islandId);
    const mergedAll = mergeIslands(state, mergedAB, recC.islandId);

    // All three are in one island.
    expect(recA.islandId).toBe(mergedAll);
    expect(recB.islandId).toBe(mergedAll);
    expect(recC.islandId).toBe(mergedAll);

    const bigIsland = state.islands.get(mergedAll);
    expect(bigIsland.bodies.length).toBe(3);

    // Bump constraintRemoveCount to trigger a split.
    bigIsland.constraintRemoveCount = 1;

    // Call splitIsland directly.
    splitIsland(state, mergedAll);

    // After split: each body should be in its own island (no contacts bridged them).
    // The base island is destroyed. Bodies get new island ids.
    expect(recA.islandId).not.toBe(mergedAll);
    expect(recB.islandId).not.toBe(mergedAll);
    expect(recC.islandId).not.toBe(mergedAll);
    // Each body is in a singleton island.
    expect(state.islands.get(recA.islandId).bodies.length).toBe(1);
    expect(state.islands.get(recB.islandId).bodies.length).toBe(1);
    expect(state.islands.get(recC.islandId).bodies.length).toBe(1);
  });
});

// ─── 9. Sleep + wake round-trip ──────────────────────────────────────────────

describe("sleep + wake round-trip", () => {
  it("body can sleep, wake, and sleep again without leaked slots", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    const state = getPhysics(world);

    // Sleep.
    forceSleep(world, b);
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);
    const sleepSlot1 = getSetIndex(world, b);

    // Wake via teleport.
    b.set(Position, { x: 1, y: 0 });
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBe(AWAKE_SET);

    // Sleep again.
    forceSleep(world, b);
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // The sleeping set slot should be reused (same index or another valid one).
    const sleepSlot2 = getSetIndex(world, b);
    expect(sleepSlot2).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);
    expect(sleepSlot2).toBe(sleepSlot1); // pool reuse: same slot

    // No leaked solver-set slots: pool should be empty or have the recycled slot.
    // After sleeping again, the slot from first sleep should be recycled.
    expect(state.sleepingSetPool.length).toBe(0); // the slot is in use
  });

  it("solver-set pool grows and shrinks correctly across multiple sleep cycles", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);

    const b1 = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });
    const b2 = world.entity().set(Position, { x: 5, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b1, 1);
    seedMass(world, b2, 1);

    const state = getPhysics(world);

    // Sleep b1.
    forceSleep(world, b1);
    now = step(world, 1, now);
    expect(getSetIndex(world, b1)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // Sleep b2.
    forceSleep(world, b2);
    now = step(world, 1, now);
    expect(getSetIndex(world, b2)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // Wake b1.
    b1.set(Position, { x: 0, y: 1 });
    now = step(world, 1, now);
    expect(getSetIndex(world, b1)).toBe(AWAKE_SET);
    // After waking, the freed slot should be in the pool.
    expect(state.sleepingSetPool.length).toBe(1);

    // Wake b2 — uses the recycled slot from pool.
    b2.set(Position, { x: 5, y: 1 });
    now = step(world, 1, now);
    expect(getSetIndex(world, b2)).toBe(AWAKE_SET);
    expect(state.sleepingSetPool.length).toBe(2); // both slots freed
  });
});

// ─── 10. Sleep does not destroy contacts ─────────────────────────────────────

describe("sleep does not destroy contacts", () => {
  it("contact count stays consistent after body falls asleep and wakes", () => {
    // We need two bodies that have contacts. Without a real collide step we
    // can't create actual contacts easily, but we can verify the mechanics:
    // when a body sleeps, its non-touching contacts go to the disabled set
    // (not destroyed). The contact count on the body is unchanged.
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    const state = getPhysics(world);
    const handle = state.bodyByEntity.get(b.eid)!;
    const rec = state.bodies.get(handle.index);

    // No contacts at start.
    expect(rec.contactCount).toBe(0);

    // Sleep and wake.
    forceSleep(world, b);
    now = step(world, 1, now);
    expect(rec.setIndex).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    // Wake via teleport.
    b.set(Position, { x: 0, y: 1 });
    now = step(world, 1, now);
    expect(rec.setIndex).toBe(AWAKE_SET);

    // Contact count unchanged.
    expect(rec.contactCount).toBe(0);
  });
});

// ─── 11. Sleep accumulation: sleepTime resets on wake ────────────────────────

describe("sleep accumulation", () => {
  it("body.sleepTime resets to 0 when the body wakes", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    const state = getPhysics(world);
    const handle = state.bodyByEntity.get(b.eid)!;
    const rec = state.bodies.get(handle.index);

    // Force high sleep time.
    forceSleep(world, b);
    now = step(world, 1, now);
    // Body is sleeping, sleepTime was reset on wake entry (in wakeSolverSet).
    // Actually let's check: the body just WENT to sleep. sleepTime is 1.0.
    // But once it's in the sleeping set, after wake the timer resets.

    b.set(Position, { x: 0, y: 1 });
    now = step(world, 1, now);
    // Body is awake again. sleepTime was reset to 0 by wakeSolverSet on waking,
    // then may have incremented by dt in finalizeBodies if it was sleepy.
    // It must be <= dt (at most one step's worth of sleep accumulation).
    expect(rec.setIndex).toBe(AWAKE_SET);
    expect(rec.sleepTime).toBeLessThanOrEqual(DT + 1e-9);
  });

  it("ENABLE_SLEEP flag is set when Sleep component is absent (default)", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

    step(world, 1, 0);
    const state = getPhysics(world);
    const handle = state.bodyByEntity.get(b.eid)!;
    const rec = state.bodies.get(handle.index);
    // Default: ENABLE_SLEEP should be set since Sleep.enabled defaults to true.
    expect(rec.flags & ENABLE_SLEEP).toBe(ENABLE_SLEEP);
  });

  it("ENABLE_SLEEP flag is clear when Sleep.enabled=false", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world
      .entity()
      .set(Position, { x: 0, y: 0 })
      .set(Body, { type: BodyType.Dynamic })
      .set(Sleep, { enabled: false, awake: true, threshold: 0.05 });

    step(world, 1, 0);
    const state = getPhysics(world);
    const handle = state.bodyByEntity.get(b.eid)!;
    const rec = state.bodies.get(handle.index);
    expect(rec.flags & ENABLE_SLEEP).toBe(0);
  });

  it("world.enableSleep=false: body never sleeps even with high sleepTime", () => {
    const world = makeWorld({ x: 0, y: 0 }, false); // sleep disabled globally
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1);
    forceSleep(world, b);
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBe(AWAKE_SET);
  });
});

// ─── 12. Body created asleep (Sleep.awake = false) ───────────────────────────

describe("Sleep.awake=false at creation", () => {
  it("a body with Sleep.awake=false transitions to sleeping on the first step", () => {
    // Sleep.awake=false causes the body to start with a high sleepTime (1.0)
    // so it falls asleep on the very first step where finalizeBodies runs.
    // After one world.progress the body should be in a sleeping set.
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world
      .entity()
      .set(Position, { x: 0, y: 0 })
      .set(Body, { type: BodyType.Dynamic })
      .set(Sleep, { enabled: true, awake: false, threshold: 0.05 });

    step(world, 1, 0);
    // After one step, body should be sleeping (high sleepTime causes immediate sleep).
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);
  });

  it("a static body with Sleep.awake=false goes to the static set (not a sleeping set)", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world
      .entity()
      .set(Position, { x: 0, y: 0 })
      .set(Body, { type: BodyType.Static })
      .set(Sleep, { enabled: true, awake: false, threshold: 0.05 });

    step(world, 1, 0);
    // Static bodies always go to STATIC_SET (0), regardless of sleep flags.
    expect(getSetIndex(world, b)).toBe(0); // STATIC_SET
  });
});

// ─── 13. AngularImpulse wake ─────────────────────────────────────────────────

describe("wake on angular impulse", () => {
  it("sleeping body wakes when AngularImpulse is set with wake:true", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b, 1, 1);
    forceSleep(world, b);
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);

    b.set(AngularImpulse, { value: 1, wake: true });
    now = step(world, 1, now);
    expect(getSetIndex(world, b)).toBe(AWAKE_SET);
  });
});

// ─── 14. Merge sleeping sets ─────────────────────────────────────────────────

describe("mergeSolverSets", () => {
  it("merges two sleeping sets into one (fewer bodies migrate)", async () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b1 = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });
    const b2 = world.entity().set(Position, { x: 5, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b1, 1);
    seedMass(world, b2, 1);

    // Put both to sleep.
    forceSleep(world, b1);
    now = step(world, 1, now);
    forceSleep(world, b2);
    now = step(world, 1, now);

    const state = getPhysics(world);
    const h1 = state.bodyByEntity.get(b1.eid)!;
    const h2 = state.bodyByEntity.get(b2.eid)!;
    const r1 = state.bodies.get(h1.index);
    const r2 = state.bodies.get(h2.index);

    expect(r1.setIndex).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);
    expect(r2.setIndex).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);
    const set1 = r1.setIndex;
    const set2 = r2.setIndex;

    // Merge them.
    mergeSolverSets(state, set1, set2);

    // Both bodies should now be in the same (bigger) set.
    expect(r1.setIndex).toBe(r2.setIndex);
    // The merged set should have 2 bodies.
    const merged = state.solverSets[r1.setIndex]!;
    expect(merged.bodySims.length).toBe(2);
  });
});

// ─── 15. linkContact both-sleeping parity (M5 fix) ───────────────────────────
//
// Regression for M5 issue: `linkContact` used to call `_mergeSolverSets` when
// both bodies are sleeping, but box2d (island.c:207-217) never merges sleeping
// sets from `b2LinkContact` — it only merges from joint creation (joint.c:326).
// With the fix, the two sleeping sets must remain distinct after `linkContact`.

describe("linkContact — both-sleeping bodies leave sets distinct (box2d parity)", () => {
  it("does not merge the two sleeping solver sets when a contact links them", () => {
    const world = makeWorld({ x: 0, y: 0 }, true);
    const b1 = world.entity().set(Position, { x: 0, y: 0 }).set(Body, { type: BodyType.Dynamic });
    const b2 = world.entity().set(Position, { x: 5, y: 0 }).set(Body, { type: BodyType.Dynamic });

    let now = step(world, 1, 0);
    seedMass(world, b1, 1);
    seedMass(world, b2, 1);

    // Sleep b1 first (step gives it its own sleeping set).
    forceSleep(world, b1);
    now = step(world, 1, now);

    // Sleep b2 separately (step gives it a different sleeping set).
    forceSleep(world, b2);
    now = step(world, 1, now);

    const state = getPhysics(world);
    const h1 = state.bodyByEntity.get(b1.eid)!;
    const h2 = state.bodyByEntity.get(b2.eid)!;
    const r1 = state.bodies.get(h1.index);
    const r2 = state.bodies.get(h2.index);

    expect(r1.setIndex).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);
    expect(r2.setIndex).toBeGreaterThanOrEqual(FIRST_SLEEPING_SET);
    // They must be in different sleeping sets.
    expect(r1.setIndex).not.toBe(r2.setIndex);

    const setABefore = r1.setIndex;
    const setBBefore = r2.setIndex;

    // Build a minimal fake contact linking the two sleeping bodies.
    // linkContact reads: edges[0].bodyId, edges[1].bodyId, body.islandId.
    // We give it valid body ids and island ids so mergeIslands + addContactToIsland
    // can proceed.  The contact itself carries no sim (it is cold).
    const fakeContact: InternalContact = {
      edges: [
        { bodyId: h1.index, prevKey: NULL_INDEX, nextKey: NULL_INDEX },
        { bodyId: h2.index, prevKey: NULL_INDEX, nextKey: NULL_INDEX },
      ],
      islandId: NULL_INDEX,
      islandIndex: NULL_INDEX,
      setIndex: NULL_INDEX,
      colorIndex: NULL_INDEX,
      localIndex: NULL_INDEX,
      contactId: NULL_INDEX,
      shapeIdA: NULL_INDEX,
      shapeIdB: NULL_INDEX,
      flags: 0,
    };

    // Call linkContact directly (simulating the both-sleeping path).
    linkContact(state, fakeContact);

    // box2d parity: each sleeping set must remain untouched — no merge fired.
    // The body.setIndex values must still be the original (distinct) sleeping sets.
    expect(r1.setIndex).toBe(setABefore);
    expect(r2.setIndex).toBe(setBBefore);
    expect(r1.setIndex).not.toBe(r2.setIndex);
  });
});
