// VP-26 — fat-AABB hysteresis tests.
//
// Verifies that `refitBodyShapeProxies` (engine/shape.ts) in "enlarge" mode
// holds `shape.fatAabb*` across steps and only resets it when the new tight
// AABB escapes the cached fat AABB. Mirrors box2d b2FinalizeBodiesTask
// (solver.c:712-728):
//
//   if (b2AABB_Contains(shape->fatAABB, aabb) == false) {
//     float margin = shape->aabbMargin;
//     fatAABB = {aabb ± margin};
//     shape->fatAABB = fatAABB;
//     shape->enlargedAABB = true;     // → b2SetBit(enlargedSimBitSet)
//   }
//   // else: fat AABB and proxy are unchanged.

import { ChildOf, World } from "@vworlds/vecs";
import { describe, expect, it, vi } from "vitest";

import { Body, BodyType, Box, installPhysics, LinearVelocity, Position } from "../../src/index.js";
import { getPhysics } from "../../src/engine/state.js";

const DT = 1 / 60;

/** Run `world` for `n` steps of 1/60 s. */
function runSteps(world: World, n: number): void {
  let now = 0;
  for (let i = 0; i < n; i++) {
    now += DT * 1000;
    world.progress(now, DT * 1000);
  }
}

// ─── 1. Proxy not enlarged when tight stays inside fat ────────────────────────
//
// A dynamic body with no gravity and no velocity does not move, so its tight
// AABB is identical every step. After the first finalize (which establishes the
// fat AABB), subsequent steps should NOT call enlargeProxy because the tight
// AABB is contained in the cached fat AABB.

describe("fat-AABB hysteresis — tight stays inside fat", () => {
  it("enlargeProxy is NOT called after the first step when the body does not move", () => {
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: 0 } });
    world.start();

    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().set(ChildOf, { target: body }).set(Box, { hx: 0.5, hy: 0.5 });

    const state = getPhysics(world);

    // Step 1 – the first finalize establishes the fat AABB on the shape, and
    // enlargeProxy is called because the proxy was just created (createProxy
    // also buffers it via _bufferMove). Our "enlarge" path may or may not call
    // enlargeProxy here depending on whether the fat was set at creation —
    // what matters is that after step 1, the fat AABB is correctly set.
    runSteps(world, 1);

    // Spy on enlargeProxy AFTER step 1.
    const enlargeSpy = vi.spyOn(state.broadPhase, "enlargeProxy");

    // Steps 2–10: body is static-pose, velocity 0, gravity 0 → does not move.
    runSteps(world, 10);

    // enlargeProxy must NOT have been called — the tight AABB is contained
    // in the fat AABB from step 1. (solver.c:714: b2AABB_Contains → skip.)
    expect(enlargeSpy).not.toHaveBeenCalled();
  });

  it("fat AABB values remain stable across steps when body is stationary", () => {
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: 0 } });
    world.start();

    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    const shapeEntity = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 0.5, hy: 0.5 });

    // Run 3 steps.
    runSteps(world, 3);

    const state = getPhysics(world);
    const handle = state.shapeByEntity.get(shapeEntity.eid)!;
    const shape = state.shapes.get(handle.index);

    // Record fat AABB after step 3.
    const fatMinX = shape.fatAabbMinX;
    const fatMinY = shape.fatAabbMinY;
    const fatMaxX = shape.fatAabbMaxX;
    const fatMaxY = shape.fatAabbMaxY;

    // Run 5 more steps.
    runSteps(world, 5);

    // Fat AABB must not have changed (no recentre on every step).
    expect(shape.fatAabbMinX).toBe(fatMinX);
    expect(shape.fatAabbMinY).toBe(fatMinY);
    expect(shape.fatAabbMaxX).toBe(fatMaxX);
    expect(shape.fatAabbMaxY).toBe(fatMaxY);
  });
});

// ─── 2. Proxy IS enlarged when tight escapes fat ──────────────────────────────
//
// A body that moves with a velocity large enough to push the tight AABB outside
// the cached fat AABB must trigger `enlargeProxy`. The fat margin for a 1×1 box
// is `computeShapeMargin(geometry)`. Moving the body by more than that in one
// step guarantees the tight AABB escapes.

describe("fat-AABB hysteresis — tight escapes fat triggers re-enlarge", () => {
  it("enlargeProxy is called when the body moves beyond the fat margin (CCD off)", () => {
    // Disable CCD so fast bodies still go through refitBodyShapeProxies ("enlarge"
    // mode) instead of the solveContinuous/enlargeBulletProxies path. This isolates
    // the hysteresis logic in the non-fast-body branch (solver.c:703-728).
    //
    // Note on LinearVelocity delivery: Vecs fires update() callbacks on
    // component MODIFICATION, not on initial add. We seed LinearVelocity at body
    // creation (x=0) so the PoseSyncIn query contains it from the start; then a
    // subsequent set() fires the update callback in physics-pre of the next step.
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: 0 }, enableContinuous: false });
    world.start();

    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(LinearVelocity, { x: 0, y: 0 }); // seed so update() fires on next set
    const shapeEntity = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 0.5, hy: 0.5 });

    // Run step 1 to establish fat AABB.
    runSteps(world, 1);

    const state = getPhysics(world);
    const handle = state.shapeByEntity.get(shapeEntity.eid)!;
    const shape = state.shapes.get(handle.index);

    // Fat margin for a 0.5×0.5 box is small. Use a velocity that displaces the
    // body by > margin in one step. DT = 1/60, so velocity > margin*60 escapes.
    const margin = shape.aabbMargin;
    const escapeVelocity = margin * 60 * 3; // 3× well clear, still below CCD threshold given minExtent

    // Apply velocity and spy on enlargeProxy.
    body.set(LinearVelocity, { x: escapeVelocity, y: 0 });
    // Spy before the next step (the velocity applies in physics-pre of this step).
    const enlargeSpy = vi.spyOn(state.broadPhase, "enlargeProxy");
    runSteps(world, 1);

    // enlargeProxy must have fired because the tight AABB escaped the fat.
    expect(enlargeSpy).toHaveBeenCalled();
  });

  it("fat AABB is updated (recentred on new tight) when escape occurs", () => {
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: 0 }, enableContinuous: false });
    world.start();

    const body = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(LinearVelocity, { x: 0, y: 0 }); // seed so update() fires on next set
    const shapeEntity = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 0.5, hy: 0.5 });

    runSteps(world, 1);

    const state = getPhysics(world);
    const handle = state.shapeByEntity.get(shapeEntity.eid)!;
    const shape = state.shapes.get(handle.index);

    const margin = shape.aabbMargin;
    const escapeVelocity = margin * 60 * 3;
    body.set(LinearVelocity, { x: escapeVelocity, y: 0 });
    runSteps(world, 1);

    // Record fat AABB and tight AABB after the escape step.
    const fatMinX = shape.fatAabbMinX;
    const fatMaxX = shape.fatAabbMaxX;

    // The fat AABB must be centred on the new tight AABB:
    // fat = tight ± margin → fat width = tight width + 2*margin.
    const tightWidth = shape.aabbMaxX - shape.aabbMinX;
    const fatWidth = fatMaxX - fatMinX;
    // fat width = tight width + 2 * margin
    expect(fatWidth).toBeCloseTo(tightWidth + 2 * margin, 5);
    // fat centre must coincide with tight centre.
    const tightCentreX = 0.5 * (shape.aabbMinX + shape.aabbMaxX);
    const fatCentreX = 0.5 * (fatMinX + fatMaxX);
    expect(fatCentreX).toBeCloseTo(tightCentreX, 5);
  });
});

// ─── 3. Teleport ("move") path always resets fat AABB ────────────────────────
//
// The "move" mode (user teleport via PhysicsPoseSyncIn) must always reset the
// fat AABB, regardless of hysteresis. This ensures a teleported body's proxy
// is always re-inserted at the correct location.

describe("fat-AABB hysteresis — move (teleport) resets fat unconditionally", () => {
  it("teleporting a body far away resets the fat AABB to the new position", () => {
    const world = new World();
    installPhysics(world, { gravity: { x: 0, y: 0 } });
    world.start();

    // Seed Position so that a subsequent set() fires the update() callback.
    const body = world.entity().set(Body, { type: BodyType.Dynamic }).set(Position, { x: 0, y: 0 });
    const shapeEntity = world
      .entity()
      .set(ChildOf, { target: body })
      .set(Box, { hx: 0.5, hy: 0.5 });

    runSteps(world, 3); // establish fat AABB at ~(0,0)

    const state = getPhysics(world);
    const handle = state.shapeByEntity.get(shapeEntity.eid)!;
    const shape = state.shapes.get(handle.index);

    const oldFatMinX = shape.fatAabbMinX;

    // Teleport the body far away (user-visible component write → update() fires).
    body.set(Position, { x: 100, y: 0 });
    runSteps(world, 1);

    // The fat AABB must have moved to the new location — not stayed at oldFat.
    expect(shape.fatAabbMinX).not.toBeCloseTo(oldFatMinX, 0);
    // The fat AABB centre should be near x=100.
    const fatCentreX = 0.5 * (shape.fatAabbMinX + shape.fatAabbMaxX);
    expect(fatCentreX).toBeCloseTo(100, 0);
  });
});
