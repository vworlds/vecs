// M4 closeout parity test: chain one-sided collision.
//
// Ports the physical one-sided-collision property validated by
// box2d/test/test_world.c::ChainSegmentShapeTest (lines 474-489):
//   - a dynamic circle dropped onto a Chain ground rests above the chain line
//     (does not tunnel through the front / collision side).
//   - a body starting below the chain (behind the collision normal) is NOT
//     stopped — it passes through the back side (one-sided semantics).
//
// Chain normal convention (engine/manifold/chain_segments.ts):
//   The "front" of each chain segment is the rightPerp(edge) side, where
//   edge = point2 - point1.  rightPerp({x,y}) = {x:y, y:-x}.
//   For a front face pointing UP (+y), we need edge pointing LEFT (-x):
//   rightPerp({-1,0}) = {0,1}.  So chain points ordered right-to-left give an
//   upward-facing surface.
//
// Loop vs open chains (PROGRESS.md VP-13e ghost-vertex caveat):
//   Loop chains use real neighbour ghost vertices and match box2d exactly.
//   Open chains use endpoint reflection — accurate in the interior but potentially
//   divergent at sharp endpoint turns.  This test uses a LOOP chain to avoid
//   the open-chain endpoint-ghost caveat and get a clean result.

import { ChildOf, World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Chain,
  Circle,
  LinearVelocity,
  Position,
  installPhysics,
} from "../../src/index.js";

const STEP_MS = 1000 / 60;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWorld(): World {
  const world = new World();
  installPhysics(world, { gravity: { x: 0, y: -10 } });
  world.start();
  return world;
}

function step(world: World, n: number, now: { value: number }): void {
  for (let i = 0; i < n; i++) {
    now.value += STEP_MS;
    world.progress(now.value, STEP_MS);
  }
}

/**
 * Build a static loop chain forming a horizontal platform at y = 0.
 *
 * Points ordered so the top segments go right-to-left (rightPerp = UP):
 *   {5,0} → {-5,0} → {-5,-2} → {5,-2}  (loop closes back to {5,0})
 *
 * Top edge: {5,0}→{-5,0}, edge=(-10,0), rightPerp=(0,-(-10)/||-1)=(0,1) ✓ faces up.
 */
function makeChainGround(world: World): void {
  const groundBody = world
    .entity()
    .set(Body, { type: BodyType.Static })
    .set(Position, { x: 0, y: 0 });
  world
    .entity()
    .set(ChildOf, { target: groundBody })
    .set(Chain, {
      points: [
        { x: 5, y: 0 },
        { x: -5, y: 0 },
        { x: -5, y: -2 },
        { x: 5, y: -2 },
      ],
      loop: true,
    });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ChainSegmentShapeTest — one-sided collision (port of box2d test_world.c::ChainSegmentShapeTest, M4 closeout parity gate)", () => {
  it("a circle dropped from above the chain rests on the front (top) side", () => {
    // Mirrors box2d ChainSegmentShapeTest lines 474-489:
    //   b2Body_GetPosition(circleBodyId).y > 0
    // The chain top surface is at y=0; a circle of radius 0.5 rests with centre
    // just above y=0 (at approximately y≈0.5 plus a small solver penetration offset).
    const world = makeWorld();
    makeChainGround(world);

    const ballBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 2 });
    world.entity().set(ChildOf, { target: ballBody }).set(Circle, { radius: 0.5 });

    const now = { value: 0 };
    step(world, 120, now);

    const pos = ballBody.get(Position)!;

    // Circle rests ABOVE the chain surface (does not tunnel through).
    // Centre should be just above y=0 (above the chain line), within ~0.6 from the
    // chain top surface.  box2d's own assertion is simply pos.y > 0.
    expect(pos.y).toBeGreaterThan(0);

    // Settle band: resting height ≈ 0.5 (radius) + small solver gap.
    expect(pos.y).toBeGreaterThan(0.3);
    expect(pos.y).toBeLessThan(0.7);
  });

  it("circle resting above the chain is stable over 240 additional steps", () => {
    const world = makeWorld();
    makeChainGround(world);

    const ballBody = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 2 });
    world.entity().set(ChildOf, { target: ballBody }).set(Circle, { radius: 0.5 });

    const now = { value: 0 };
    // Settle.
    step(world, 120, now);

    const settled = ballBody.get(Position)!;
    let minY = settled.y;
    let maxY = settled.y;

    // Run much longer: position must not drift significantly.
    for (let i = 0; i < 240; i++) {
      step(world, 1, now);
      const p = ballBody.get(Position)!;
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }

    expect(maxY - minY).toBeLessThan(0.05);
    // Still above the chain, still not tunneled.
    expect(minY).toBeGreaterThan(0);
  });

  it("one-sidedness: a circle starting below the chain (behind the normal) is not pushed upward", () => {
    // A circle below the chain (at y = -0.5) moves upward toward y = 0.
    // The offset check in collideChainSegmentAndCircle is:
    //   offset = dot(rightPerp(edge), sub(pB, p1))
    // For the top segment (edge pointing left), rightPerp = (0,+1).
    // pB is below the chain (y < 0), so offset < 0 → manifold empty → no collision.
    // The circle should pass through unimpeded, ending up above y = 0.
    // No gravity so we have full control over the trajectory.
    const noGravWorld = new World();
    installPhysics(noGravWorld, { gravity: { x: 0, y: 0 } });
    noGravWorld.start();

    const groundBody = noGravWorld
      .entity()
      .set(Body, { type: BodyType.Static })
      .set(Position, { x: 0, y: 0 });
    noGravWorld
      .entity()
      .set(ChildOf, { target: groundBody })
      .set(Chain, {
        points: [
          { x: 5, y: 0 },
          { x: -5, y: 0 },
          { x: -5, y: -2 },
          { x: 5, y: -2 },
        ],
        loop: true,
      });

    // Start below the chain, moving upward at 5 m/s.
    const ballBody = noGravWorld
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: -0.5 })
      .set(LinearVelocity, { x: 0, y: 5 });
    noGravWorld.entity().set(ChildOf, { target: ballBody }).set(Circle, { radius: 0.25 });

    // Run enough steps for the ball to travel through the chain and above it.
    // At 5 m/s over 0.5 s (30 steps at 1/60), the ball travels ~2.5 m upward,
    // ending well above y = 0 if not stopped.
    const now = { value: 0 };
    for (let i = 0; i < 30; i++) {
      now.value += STEP_MS;
      noGravWorld.progress(now.value, STEP_MS);
    }

    const pos = ballBody.get(Position)!;
    // Ball passed through the back side — it is now ABOVE the chain line.
    expect(pos.y).toBeGreaterThan(0.5);
  });
});
