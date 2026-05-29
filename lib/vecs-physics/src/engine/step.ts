// `engineStep` — the per-step orchestrator. Ports the body-integration core of
// Box2D's TGS soft-step solver (`b2Solve` → the sub-step loop → `b2FinalizeBodiesTask`
// in `solver.c`), scoped to gravity/damping integration: there are no contacts,
// joints, broad/narrow phase, islands, sleep, or CCD yet, so the constraint
// stages (prepare / warm-start / solve / relax / restitution / store-impulses)
// collapse to nothing. They slot into this same loop as their tickets land — see
// PLAN.md → _Solver pipeline — exact stage order to port_.
//
// The integrator works on the awake set only: static and disabled bodies are not
// simulated, and sleeping sets do not exist yet. Each sub-step uses
// `h = dt / subSteps` (Box2D `context.h`; every sub-step is the same size).

import {
  ALLOW_FAST_ROTATION,
  IS_SPEED_CAPPED,
  LOCK_ANGULAR_Z,
  LOCK_LINEAR_X,
  LOCK_LINEAR_Y,
} from "./body.js";
import { AWAKE_SET, type SolverSet } from "./solver_set.js";
import { type PhysicsState } from "./state.js";
import { MAX_ROTATION } from "../math/constants.js";
import { integrateRotation, mulRot, normalizeRot, rotateVector } from "../math/rot.js";

/** Advance the simulation by one fixed step. Integrates the awake bodies under
 * gravity/damping across `subSteps` sub-steps, then finalizes transforms and
 * rebuilds the move-event list. */
export function engineStep(state: PhysicsState, dt: number, subSteps: number): void {
  state.stepIndex += 1;

  const awake = state.solverSets[AWAKE_SET]!;
  state.bodyMoveEvents.length = 0;

  if (dt <= 0 || awake.bodySims.length === 0) {
    return;
  }

  const n = Math.max(1, subSteps);
  const h = dt / n;
  const invDt = 1 / dt;
  const maxLinearSpeed = state.maximumLinearSpeed;
  const maxAngularSpeed = MAX_ROTATION * invDt;

  // Sub-step loop. With no constraints the per-sub-step block is just integrate
  // velocities → integrate positions; warm-start / solve / relax are no-ops.
  for (let s = 0; s < n; s++) {
    integrateVelocities(awake, h, state.gravityX, state.gravityY);
    integratePositions(awake, h, maxLinearSpeed, maxAngularSpeed);
  }

  // Restitution and impulse storage are no-ops without contacts.
  finalizeBodies(state, awake);
}

/** Apply gravity, force/torque, and damping to every awake body's velocity.
 * Mirrors `b2IntegrateVelocitiesTask`. Gravity is gated on `invMass > 0`, so it
 * never acts on kinematic bodies (invMass 0). */
function integrateVelocities(
  awake: SolverSet,
  h: number,
  gravityX: number,
  gravityY: number
): void {
  const sims = awake.bodySims;
  const states = awake.bodyStates;
  for (let i = 0; i < sims.length; i++) {
    const sim = sims[i]!;
    const st = states[i]!;

    // Pade-approximated exponential damping (Box2D): v *= 1 / (1 + h*c).
    const linearDamping = 1 / (1 + h * sim.linearDamping);
    const angularDamping = 1 / (1 + h * sim.angularDamping);
    const gravityScale = sim.invMass > 0 ? sim.gravityScale : 0;

    const lvdx = h * sim.invMass * sim.forceX + h * gravityScale * gravityX;
    const lvdy = h * sim.invMass * sim.forceY + h * gravityScale * gravityY;
    const avd = h * sim.invInertia * sim.torque;

    st.vx = lvdx + linearDamping * st.vx;
    st.vy = lvdy + linearDamping * st.vy;
    st.omega = avd + angularDamping * st.omega;
  }
}

/** Apply motion locks and speed caps, then advance the solver delta-pose.
 * Mirrors `b2IntegratePositionsTask`. */
function integratePositions(
  awake: SolverSet,
  h: number,
  maxLinearSpeed: number,
  maxAngularSpeed: number
): void {
  const states = awake.bodyStates;
  const maxLinearSpeedSq = maxLinearSpeed * maxLinearSpeed;
  const maxAngularSpeedSq = maxAngularSpeed * maxAngularSpeed;
  for (let i = 0; i < states.length; i++) {
    const st = states[i]!;

    let vx = st.flags & LOCK_LINEAR_X ? 0 : st.vx;
    let vy = st.flags & LOCK_LINEAR_Y ? 0 : st.vy;
    let w = st.flags & LOCK_ANGULAR_Z ? 0 : st.omega;

    const v2 = vx * vx + vy * vy;
    if (v2 > maxLinearSpeedSq) {
      const ratio = maxLinearSpeed / Math.sqrt(v2);
      vx *= ratio;
      vy *= ratio;
      st.flags |= IS_SPEED_CAPPED;
    }
    if (w * w > maxAngularSpeedSq && (st.flags & ALLOW_FAST_ROTATION) === 0) {
      w *= maxAngularSpeed / Math.abs(w);
      st.flags |= IS_SPEED_CAPPED;
    }

    st.vx = vx;
    st.vy = vy;
    st.omega = w;
    st.deltaPosX += h * vx;
    st.deltaPosY += h * vy;
    const dr = integrateRotation({ c: st.deltaRotCos, s: st.deltaRotSin }, h * w);
    st.deltaRotCos = dr.c;
    st.deltaRotSin = dr.s;
  }
}

/** Fold the accumulated delta-pose into each body's centre/rotation, derive the
 * origin transform, reset the per-step deltas and applied force, and record a
 * move event. Mirrors the body-write half of `b2FinalizeBodiesTask` minus sleep
 * and CCD (no sleeping sets / fast-body path yet, so every body is "safe to
 * advance" and its sweep baseline tracks the new pose). */
function finalizeBodies(state: PhysicsState, awake: SolverSet): void {
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

    // No CCD: the body is safe to advance, so its sweep baseline is the new pose.
    sim.center0X = sim.centerX;
    sim.center0Y = sim.centerY;
    sim.rotation0Cos = q.c;
    sim.rotation0Sin = q.s;

    // Clear the transient speed-cap flag (Box2D clears the transient set here).
    st.flags &= ~IS_SPEED_CAPPED;

    state.bodyMoveEvents.push(sim.bodyId);
  }
}
