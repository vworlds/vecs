// `engineStep` — the per-step orchestrator (VP-18).
//
// Wires the full collision step loop the engine has been missing: build the
// step context, create contacts from broad-phase pairs, run the narrow phase +
// contact state changes (collide), run the TGS soft-step solver (solve), then
// finalize bodies (fold delta-pose, write transforms, move events, refit shape
// AABBs / broad-phase proxies). Mirrors box2d's `b2World_Step` → `b2Collide` →
// `b2Solve` → `b2FinalizeBodiesTask` (physics_world.c / solver.c), serialised.
//
// The integrate-velocities / integrate-positions stages moved into the solver
// (VP-17, `engine/solver.ts` stages 2 & 5); this file no longer owns them. The
// finalize half of `b2FinalizeBodiesTask` (solver.c:544-736) stays here and now
// includes the shape-AABB refit + proxy enlarge (shared with the teleport refit
// in `pose_sync_in.ts` via `engine/shape.ts`).
//
// Sleep timer (solver.c:638-684) and CCD / isFast (solver.c:688-728) blocks are
// skipped with comments (M5).

import { IS_SPEED_CAPPED } from "./body.js";
import { collide, makePairCreateCallback } from "./collide.js";
import { refitBodyShapeProxies } from "./shape.js";
import { makeStepContext, solve, type StepContext } from "./solver.js";
import { AWAKE_SET, type SolverSet } from "./solver_set.js";
import { type PhysicsState } from "./state.js";
import { mulRot, normalizeRot, rotateVector } from "../math/rot.js";

/** Advance the simulation by one fixed step. Builds the step context, creates
 * contacts from new broad-phase pairs, runs the narrow phase + solver, then
 * finalizes the awake bodies (write-back + AABB refit). */
export function engineStep(state: PhysicsState, dt: number, subSteps: number): void {
  state.stepIndex += 1;
  state.bodyMoveEvents.length = 0;

  if (dt <= 0) {
    return;
  }

  const ctx = makeStepContext(state, dt, subSteps);

  // Create contacts for new broad-phase pairs (filtered in the callback).
  state.broadPhase.updatePairs(makePairCreateCallback(state));

  // Narrow phase + contact state changes (link/unlink + graph moves).
  collide(state, ctx);

  // The eight-stage TGS soft-step solver over the awake set + overflow color.
  // Early-returns on an empty awake set.
  solve(state, ctx);

  // Fold delta-pose, write transforms, push move events, refit proxies.
  finalizeBodies(state, ctx);
}

/** Fold the accumulated delta-pose into each body's centre/rotation, derive the
 * origin transform, reset the per-step deltas and applied force, record a move
 * event, and refit the body's shape AABBs / broad-phase proxies. Mirrors the
 * body-write + shape-AABB half of `b2FinalizeBodiesTask` (solver.c:544-736)
 * minus sleep and CCD (no sleeping sets / fast-body path yet, so every body is
 * "safe to advance" and its sweep baseline tracks the new pose). */
function finalizeBodies(state: PhysicsState, _ctx: StepContext): void {
  const awake: SolverSet = state.solverSets[AWAKE_SET]!;
  const sims = awake.bodySims;
  const states = awake.bodyStates;
  for (let i = 0; i < sims.length; i++) {
    const sim = sims[i]!;
    const st = states[i]!;

    sim.centerX += st.deltaPosX;
    sim.centerY += st.deltaPosY;
    const q = normalizeRot(
      mulRot({ c: st.deltaRotCos, s: st.deltaRotSin }, { c: sim.cos, s: sim.sin })
    );
    sim.cos = q.c;
    sim.sin = q.s;

    // Reset the solver delta-pose for the next step.
    st.deltaPosX = 0;
    st.deltaPosY = 0;
    st.deltaRotCos = 1;
    st.deltaRotSin = 0;

    // Origin transform follows from the centre of mass: p = c - R*localCenter.
    const offset = rotateVector(q, { x: sim.localCenterX, y: sim.localCenterY });
    sim.transformX = sim.centerX - offset.x;
    sim.transformY = sim.centerY - offset.y;

    // Forces are consumed each step; next step re-accumulates them.
    sim.forceX = 0;
    sim.forceY = 0;
    sim.torque = 0;

    // No CCD: the body is safe to advance, so its sweep baseline is the new
    // pose. The sleep timer (solver.c:638-684) is skipped (M5).
    sim.center0X = sim.centerX;
    sim.center0Y = sim.centerY;
    sim.rotation0Cos = q.c;
    sim.rotation0Sin = q.s;

    // Clear the transient speed-cap flag (Box2D clears the transient set here).
    st.flags &= ~IS_SPEED_CAPPED;

    state.bodyMoveEvents.push(sim.bodyId);

    // Refit the shape AABBs and enlarge any broad-phase proxy the body's motion
    // outgrew, so a falling body finds new pairs (b2FinalizeBodiesTask
    // shape-AABB loop, solver.c:686-732). The isFast (CCD) branch is skipped.
    // Finalize ENLARGES the proxy (vs the teleport path which MOVES it).
    const body = state.bodies.get(sim.bodyId);
    refitBodyShapeProxies(state.shapes, state.broadPhase, body, sim, "enlarge");
  }
}
