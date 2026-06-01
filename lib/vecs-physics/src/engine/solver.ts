// Transitional stub kept alive for surviving engine code; full deletion happens in M7-10.
// The TGS soft-step constraint solver (VP-17).
//
// Ports Box2D v3.2.0's eight-stage TGS soft-step solver, restricted to the
// single overflow constraint-graph color (v1 has no graph coloring, exactly
// box2d's `B2_FORCE_OVERFLOW` path). The stages run over the touching contacts
// in `state.graphContactSims` directly — islands are not consumed (see
// PROGRESS.md → MILESTONE 3 decision).
//
// Sources (box2d/src):
//   - solver.h:239              b2MakeSoft (ported verbatim, incl. hertz==0)
//   - solver.h:127              b2Softness
//   - physics_world.c:876-904   step-context / softness setup
//   - contact_solver.c:24       b2PrepareContacts_Overflow
//   - solver.c:65               b2IntegrateVelocitiesTask  (stage 2)
//   - contact_solver.c:162      b2WarmStartContacts_Overflow
//   - contact_solver.c:239      b2SolveContacts_Overflow
//   - solver.c:113              b2IntegratePositionsTask   (stage 5)
//   - contact_solver.c:410      b2ApplyRestitution_Overflow
//   - contact_solver.c:516      b2StoreImpulses_Overflow
//   - solver.c:1038-1045/1521   the eight-stage order
//
// box2d's eight stages are PrepareContacts, IntegrateVelocities, WarmStart,
// Solve, IntegratePositions, Relax (Solve with useBias=false), Restitution,
// StoreImpulses. The integrate-velocities / integrate-positions stages are the
// same math as the existing gravity-only integrator in `step.ts` (VP-7); they
// live here too as solver stages 2 & 5. Finalize (fold delta-pose, write
// transforms, move events, AABB refit) stays in the orchestrator (step.ts /
// VP-18) — this file does NOT finalize bodies.
//
// Static / null bodies use a module-level identity body state (zero velocity,
// identity delta, no DYNAMIC_FLAG). Write-back to a state only happens when the
// state carries DYNAMIC_FLAG (box2d's `b2_dynamicFlag` gate).
//
// Engine module boundary: imports only from math/, util/, and sibling engine/.

import { MAX_ROTATION, PI } from "../math/constants.js";
import { integrateRotation, type Rot } from "../math/rot.js";
import { NULL_INDEX } from "../util/handle.js";

import {
  ALLOW_FAST_ROTATION,
  DYNAMIC_FLAG,
  IS_SPEED_CAPPED,
  LOCK_ANGULAR_Z,
  LOCK_LINEAR_X,
  LOCK_LINEAR_Y,
  makeIdentityBodyState,
  type BodyState,
} from "./body.js";
import { SIM_ENABLE_HIT_EVENT, type ContactSim } from "./contact.js";
import { AWAKE_SET, type SolverSet } from "./solver_set.js";
import { type ContactHitEvent, type PhysicsState } from "./state.js";

// ─── Softness ─────────────────────────────────────────────────────────────────

/** Soft-constraint coefficients. Mirrors `b2Softness` (solver.h:127). */
export interface Softness {
  biasRate: number;
  massScale: number;
  impulseScale: number;
}

/**
 * Soft-constraint coefficients for a target `hertz` / damping `zeta` and
 * sub-step length `h`. Ports `b2MakeSoft` (solver.h:239) VERBATIM, including the
 * `hertz === 0` early return. For non-zero hertz, `massScale + impulseScale == 1`.
 */
export function makeSoft(hertz: number, zeta: number, h: number): Softness {
  if (hertz === 0.0) {
    return { biasRate: 0.0, massScale: 0.0, impulseScale: 0.0 };
  }

  const omega = 2.0 * PI * hertz;
  const a1 = 2.0 * zeta + h * omega;
  const a2 = h * omega * a1;
  const a3 = 1.0 / (1.0 + a2);

  return { biasRate: omega / a1, massScale: a2 * a3, impulseScale: a3 };
}

// ─── StepContext ──────────────────────────────────────────────────────────────

/** Per-step solver context. Mirrors the subset of `b2StepContext`
 * (solver.h:155) the overflow solver and its integrate stages read. Rebuilt
 * each step by {@link makeStepContext}. */
export interface StepContext {
  /** Sub-step length `dt / subSteps`. */
  h: number;
  /** Inverse sub-step length (`subSteps * invDt`, or 0 when dt <= 0). */
  invH: number;
  /** Soft coefficients for dynamic-dynamic contacts. */
  contactSoftness: Softness;
  /** Stiffer coefficients for contacts touching a static/kinematic body. */
  staticSoftness: Softness;
  restitutionThreshold: number;
  /** Max soft-bias push-out speed (`world.contactSpeed`). */
  contactSpeed: number;
  maxLinearVelocity: number;
  enableWarmStarting: boolean;
  gravityX: number;
  gravityY: number;
  dt: number;
  invDt: number;
  /** Number of solver sub-steps. */
  subStepCount: number;
}

/**
 * Build the per-step solver context. Ports the setup at
 * physics_world.c:876-904: `h = dt/subSteps`, `invH = subSteps*invDt`
 * (or 0 when `dt <= 0`), the contact-hertz clamp (`min(contactHertz,
 * 0.125*invH)`), and the contact/static softness via {@link makeSoft}.
 */
export function makeStepContext(state: PhysicsState, dt: number, subSteps: number): StepContext {
  const subStepCount = Math.max(1, subSteps);

  let invDt: number;
  let h: number;
  let invH: number;
  if (dt > 0.0) {
    invDt = 1.0 / dt;
    h = dt / subStepCount;
    invH = subStepCount * invDt;
  } else {
    invDt = 0.0;
    h = 0.0;
    invH = 0.0;
  }

  // Hertz values get reduced for large time steps.
  const contactHertz = Math.min(state.contactHertz, 0.125 * invH);
  const contactSoftness = makeSoft(contactHertz, state.contactDampingRatio, h);
  const staticSoftness = makeSoft(2.0 * contactHertz, state.contactDampingRatio, h);

  return {
    h,
    invH,
    contactSoftness,
    staticSoftness,
    restitutionThreshold: state.restitutionThreshold,
    contactSpeed: state.contactSpeed,
    maxLinearVelocity: state.maximumLinearSpeed,
    enableWarmStarting: true,
    gravityX: state.gravityX,
    gravityY: state.gravityY,
    dt,
    invDt,
    subStepCount,
  };
}

// ─── Constraint scratch ───────────────────────────────────────────────────────

/** Per-point constraint scratch. Mirrors `b2ContactConstraintPoint`
 * (contact_solver.h:10). */
export interface ContactConstraintPoint {
  anchorAx: number;
  anchorAy: number;
  anchorBx: number;
  anchorBy: number;
  baseSeparation: number;
  normalImpulse: number;
  tangentImpulse: number;
  totalNormalImpulse: number;
  normalMass: number;
  tangentMass: number;
  relativeVelocity: number;
}

/** Per-contact constraint scratch. Mirrors `b2ContactConstraint`
 * (contact_solver.h:22). `indexA`/`indexB` are base-1 (0 = static/null). */
export interface ContactConstraint {
  indexA: number;
  indexB: number;
  normalX: number;
  normalY: number;
  friction: number;
  restitution: number;
  rollingResistance: number;
  rollingImpulse: number;
  tangentSpeed: number;
  pointCount: number;
  softness: Softness;
  invMassA: number;
  invIA: number;
  invMassB: number;
  invIB: number;
  rollingMass: number;
  points: [ContactConstraintPoint, ContactConstraintPoint];
}

function makeConstraintPoint(): ContactConstraintPoint {
  return {
    anchorAx: 0,
    anchorAy: 0,
    anchorBx: 0,
    anchorBy: 0,
    baseSeparation: 0,
    normalImpulse: 0,
    tangentImpulse: 0,
    totalNormalImpulse: 0,
    normalMass: 0,
    tangentMass: 0,
    relativeVelocity: 0,
  };
}

function makeConstraint(): ContactConstraint {
  return {
    indexA: 0,
    indexB: 0,
    normalX: 0,
    normalY: 0,
    friction: 0,
    restitution: 0,
    rollingResistance: 0,
    rollingImpulse: 0,
    tangentSpeed: 0,
    pointCount: 0,
    softness: { biasRate: 0, massScale: 0, impulseScale: 0 },
    invMassA: 0,
    invIA: 0,
    invMassB: 0,
    invIB: 0,
    rollingMass: 0,
    points: [makeConstraintPoint(), makeConstraintPoint()],
  };
}

// ─── Identity static body state ───────────────────────────────────────────────
//
// The single dummy state every stage uses to stand in for a static/null body.
// Mirrors `b2_identityBodyState` (body.h:171): zero velocity, identity delta,
// no DYNAMIC_FLAG (so write-back is gated off). Module-level: the stages never
// mutate it (its writes are always gated behind DYNAMIC_FLAG), so the single
// shared instance is safe across calls.
const IDENTITY_STATE: BodyState = makeIdentityBodyState(0);

/** Resolve a base-0 awake-set index to its body state, falling back to the
 * shared identity state for the static/null body (index {@link NULL_INDEX}). */
function stateAt(states: BodyState[], index: number): BodyState {
  return index === NULL_INDEX ? IDENTITY_STATE : states[index]!;
}

// ─── prepareContacts (b2PrepareContacts_Overflow) ─────────────────────────────

/**
 * Build one {@link ContactConstraint} per touching contact in
 * `state.graphContactSims`. Ports `b2PrepareContacts_Overflow`
 * (contact_solver.c:24): indices base-1 from `bodySimIndexA/B`, normal,
 * friction / restitution / rolling / tangent-speed, the static-vs-dynamic
 * softness pick, masses + rolling mass, and per point the warm-started impulses
 * (× warmStartScale), anchors, base separation, normal / tangent mass, and
 * stored relative velocity.
 */
export function prepareContacts(
  state: PhysicsState,
  ctx: StepContext,
  constraints: ContactConstraint[]
): void {
  const contacts = state.graphContactSims;
  const states = state.solverSets[AWAKE_SET]!.bodyStates;

  const contactSoftness = ctx.contactSoftness;
  const staticSoftness = ctx.staticSoftness;
  const warmStartScale = ctx.enableWarmStarting ? 1.0 : 0.0;

  for (let i = 0; i < contacts.length; i++) {
    const contactSim = contacts[i]!;
    const manifold = contactSim.manifold;
    const pointCount = manifold.pointCount;

    const constraint = constraints[i]!;

    const indexA = contactSim.bodySimIndexA;
    const indexB = contactSim.bodySimIndexB;

    // 0 is null.
    constraint.indexA = indexA + 1;
    constraint.indexB = indexB + 1;
    constraint.normalX = manifold.normal.x;
    constraint.normalY = manifold.normal.y;
    constraint.friction = contactSim.friction;
    constraint.restitution = contactSim.restitution;
    constraint.rollingResistance = contactSim.rollingResistance;
    constraint.rollingImpulse = warmStartScale * manifold.rollingImpulse;
    constraint.tangentSpeed = contactSim.tangentSpeed;
    constraint.pointCount = pointCount;

    let vAx = 0.0;
    let vAy = 0.0;
    let wA = 0.0;
    const mA = contactSim.invMassA;
    const iA = contactSim.invIA;
    if (indexA !== NULL_INDEX) {
      const stateA = states[indexA]!;
      vAx = stateA.vx;
      vAy = stateA.vy;
      wA = stateA.omega;
    }

    let vBx = 0.0;
    let vBy = 0.0;
    let wB = 0.0;
    const mB = contactSim.invMassB;
    const iB = contactSim.invIB;
    if (indexB !== NULL_INDEX) {
      const stateB = states[indexB]!;
      vBx = stateB.vx;
      vBy = stateB.vy;
      wB = stateB.omega;
    }

    if (indexA === NULL_INDEX || indexB === NULL_INDEX) {
      constraint.softness = staticSoftness;
    } else {
      constraint.softness = contactSoftness;
    }

    // Copy mass into the constraint to avoid cache misses during sub-stepping.
    constraint.invMassA = mA;
    constraint.invIA = iA;
    constraint.invMassB = mB;
    constraint.invIB = iB;

    {
      const k = iA + iB;
      constraint.rollingMass = k > 0.0 ? 1.0 / k : 0.0;
    }

    const normalX = constraint.normalX;
    const normalY = constraint.normalY;
    // tangent = rightPerp(normal) = { normal.y, -normal.x }
    const tangentX = normalY;
    const tangentY = -normalX;

    for (let j = 0; j < pointCount; j++) {
      const mp = manifold.points[j]!;
      const cp = constraint.points[j]!;

      cp.normalImpulse = warmStartScale * mp.normalImpulse;
      cp.tangentImpulse = warmStartScale * mp.tangentImpulse;
      cp.totalNormalImpulse = 0.0;

      const rAx = mp.anchorA.x;
      const rAy = mp.anchorA.y;
      const rBx = mp.anchorB.x;
      const rBy = mp.anchorB.y;

      cp.anchorAx = rAx;
      cp.anchorAy = rAy;
      cp.anchorBx = rBx;
      cp.anchorBy = rBy;
      // baseSeparation = mp.separation - dot(rB - rA, normal)
      cp.baseSeparation = mp.separation - ((rBx - rAx) * normalX + (rBy - rAy) * normalY);

      // rnA = cross(rA, normal); rnB = cross(rB, normal)
      const rnA = rAx * normalY - rAy * normalX;
      const rnB = rBx * normalY - rBy * normalX;
      const kNormal = mA + mB + iA * rnA * rnA + iB * rnB * rnB;
      cp.normalMass = kNormal > 0.0 ? 1.0 / kNormal : 0.0;

      const rtA = rAx * tangentY - rAy * tangentX;
      const rtB = rBx * tangentY - rBy * tangentX;
      const kTangent = mA + mB + iA * rtA * rtA + iB * rtB * rtB;
      cp.tangentMass = kTangent > 0.0 ? 1.0 / kTangent : 0.0;

      // Save relative velocity for restitution.
      // vrA = vA + crossSV(wA, rA); vrB = vB + crossSV(wB, rB)
      const vrAx = vAx - wA * rAy;
      const vrAy = vAy + wA * rAx;
      const vrBx = vBx - wB * rBy;
      const vrBy = vBy + wB * rBx;
      cp.relativeVelocity = normalX * (vrBx - vrAx) + normalY * (vrBy - vrAy);
    }
  }
}

// ─── integrateVelocities (b2IntegrateVelocitiesTask, stage 2) ─────────────────

/**
 * Apply gravity, force/torque, and Pade damping to every awake body's velocity.
 * Ports `b2IntegrateVelocitiesTask` (solver.c:65). Gravity is gated on
 * `invMass > 0` via `gravityScale`, so it never acts on kinematic bodies. This
 * is the same math as the existing gravity-only integrator in `step.ts`,
 * reproduced here as solver stage 2 reading `ctx.gravityX/Y`.
 */
export function integrateVelocities(state: PhysicsState, ctx: StepContext, h: number): void {
  const awake = state.solverSets[AWAKE_SET]!;
  const sims = awake.bodySims;
  const states = awake.bodyStates;
  const gravityX = ctx.gravityX;
  const gravityY = ctx.gravityY;

  for (let i = 0; i < sims.length; i++) {
    const sim = sims[i]!;
    const st = states[i]!;

    // Pade-approximated exponential damping: v *= 1 / (1 + h*c).
    const linearDamping = 1.0 / (1.0 + h * sim.linearDamping);
    const angularDamping = 1.0 / (1.0 + h * sim.angularDamping);
    const gravityScale = sim.invMass > 0.0 ? sim.gravityScale : 0.0;

    const lvdx = h * sim.invMass * sim.forceX + h * gravityScale * gravityX;
    const lvdy = h * sim.invMass * sim.forceY + h * gravityScale * gravityY;
    const avd = h * sim.invInertia * sim.torque;

    st.vx = lvdx + linearDamping * st.vx;
    st.vy = lvdy + linearDamping * st.vy;
    st.omega = avd + angularDamping * st.omega;
  }
}

// ─── warmStartContacts (b2WarmStartContacts_Overflow) ─────────────────────────

/** Re-apply the cached impulses from the previous step. Ports
 * `b2WarmStartContacts_Overflow` (contact_solver.c:162). */
export function warmStartContacts(
  state: PhysicsState,
  _ctx: StepContext,
  constraints: ContactConstraint[]
): void {
  const states = state.solverSets[AWAKE_SET]!.bodyStates;
  const contactCount = state.graphContactSims.length;

  for (let i = 0; i < contactCount; i++) {
    const constraint = constraints[i]!;

    const indexA = constraint.indexA - 1;
    const indexB = constraint.indexB - 1;

    const stateA = stateAt(states, indexA);
    const stateB = stateAt(states, indexB);

    let vAx = stateA.vx;
    let vAy = stateA.vy;
    let wA = stateA.omega;
    let vBx = stateB.vx;
    let vBy = stateB.vy;
    let wB = stateB.omega;

    const mA = constraint.invMassA;
    const iA = constraint.invIA;
    const mB = constraint.invMassB;
    const iB = constraint.invIB;

    const normalX = constraint.normalX;
    const normalY = constraint.normalY;
    // tangent = rightPerp(normal)
    const tangentX = normalY;
    const tangentY = -normalX;
    const pointCount = constraint.pointCount;

    for (let j = 0; j < pointCount; j++) {
      const cp = constraint.points[j]!;

      const rAx = cp.anchorAx;
      const rAy = cp.anchorAy;
      const rBx = cp.anchorBx;
      const rBy = cp.anchorBy;

      // P = normalImpulse * normal + tangentImpulse * tangent
      const Px = cp.normalImpulse * normalX + cp.tangentImpulse * tangentX;
      const Py = cp.normalImpulse * normalY + cp.tangentImpulse * tangentY;

      cp.totalNormalImpulse += cp.normalImpulse;

      // wA -= iA * cross(rA, P); vA += -mA * P
      wA -= iA * (rAx * Py - rAy * Px);
      vAx -= mA * Px;
      vAy -= mA * Py;
      // wB += iB * cross(rB, P); vB += mB * P
      wB += iB * (rBx * Py - rBy * Px);
      vBx += mB * Px;
      vBy += mB * Py;
    }

    wA -= iA * constraint.rollingImpulse;
    wB += iB * constraint.rollingImpulse;

    if (stateA.flags & DYNAMIC_FLAG) {
      stateA.vx = vAx;
      stateA.vy = vAy;
      stateA.omega = wA;
    }
    if (stateB.flags & DYNAMIC_FLAG) {
      stateB.vx = vBx;
      stateB.vy = vBy;
      stateB.omega = wB;
    }
  }
}

// ─── solveContacts (b2SolveContacts_Overflow) ─────────────────────────────────

/**
 * The non-penetration + friction + rolling-resistance solve. Ports
 * `b2SolveContacts_Overflow` (contact_solver.c:239). `useBias = true` (the Solve
 * stage) applies the speculative / soft bias and the `-ctx.contactSpeed` push
 * clamp; `useBias = false` (the Relax stage) additionally runs friction and
 * rolling resistance.
 */
export function solveContacts(
  state: PhysicsState,
  ctx: StepContext,
  constraints: ContactConstraint[],
  useBias: boolean
): void {
  const states = state.solverSets[AWAKE_SET]!.bodyStates;
  const contactCount = state.graphContactSims.length;

  const invH = ctx.invH;
  const contactSpeed = ctx.contactSpeed;

  for (let i = 0; i < contactCount; i++) {
    const constraint = constraints[i]!;
    const mA = constraint.invMassA;
    const iA = constraint.invIA;
    const mB = constraint.invMassB;
    const iB = constraint.invIB;

    const indexA = constraint.indexA - 1;
    const indexB = constraint.indexB - 1;

    const stateA = stateAt(states, indexA);
    let vAx = stateA.vx;
    let vAy = stateA.vy;
    let wA = stateA.omega;
    const dqAc = stateA.deltaRotCos;
    const dqAs = stateA.deltaRotSin;

    const stateB = stateAt(states, indexB);
    let vBx = stateB.vx;
    let vBy = stateB.vy;
    let wB = stateB.omega;
    const dqBc = stateB.deltaRotCos;
    const dqBs = stateB.deltaRotSin;

    // dp = deltaPositionB - deltaPositionA
    const dpx = stateB.deltaPosX - stateA.deltaPosX;
    const dpy = stateB.deltaPosY - stateA.deltaPosY;

    const normalX = constraint.normalX;
    const normalY = constraint.normalY;
    // tangent = rightPerp(normal)
    const tangentX = normalY;
    const tangentY = -normalX;
    const friction = constraint.friction;
    const softness = constraint.softness;

    const pointCount = constraint.pointCount;
    let totalNormalImpulse = 0.0;

    // Non-penetration.
    for (let j = 0; j < pointCount; j++) {
      const cp = constraint.points[j]!;

      const rAx = cp.anchorAx;
      const rAy = cp.anchorAy;
      const rBx = cp.anchorBx;
      const rBy = cp.anchorBy;

      // ds = dp + (rotate(dqB, rB) - rotate(dqA, rA))
      const rotBx = dqBc * rBx - dqBs * rBy;
      const rotBy = dqBs * rBx + dqBc * rBy;
      const rotAx = dqAc * rAx - dqAs * rAy;
      const rotAy = dqAs * rAx + dqAc * rAy;
      const dsx = dpx + (rotBx - rotAx);
      const dsy = dpy + (rotBy - rotAy);
      // s = baseSeparation + dot(ds, normal)
      const s = cp.baseSeparation + (dsx * normalX + dsy * normalY);

      let velocityBias = 0.0;
      let massScale = 1.0;
      let impulseScale = 0.0;
      if (s > 0.0) {
        // Speculative bias.
        velocityBias = s * invH;
      } else if (useBias) {
        velocityBias = Math.max(softness.massScale * softness.biasRate * s, -contactSpeed);
        massScale = softness.massScale;
        impulseScale = softness.impulseScale;
      }

      // Relative normal velocity at contact.
      const vrAx = vAx - wA * rAy;
      const vrAy = vAy + wA * rAx;
      const vrBx = vBx - wB * rBy;
      const vrBy = vBy + wB * rBx;
      const vn = (vrBx - vrAx) * normalX + (vrBy - vrAy) * normalY;

      // Incremental normal impulse.
      let impulse =
        -cp.normalMass * (massScale * vn + velocityBias) - impulseScale * cp.normalImpulse;

      // Clamp the accumulated impulse.
      const newImpulse = Math.max(cp.normalImpulse + impulse, 0.0);
      impulse = newImpulse - cp.normalImpulse;
      cp.normalImpulse = newImpulse;
      cp.totalNormalImpulse += impulse;

      totalNormalImpulse += newImpulse;

      // Apply normal impulse.
      const Px = impulse * normalX;
      const Py = impulse * normalY;
      vAx -= mA * Px;
      vAy -= mA * Py;
      wA -= iA * (rAx * Py - rAy * Px);
      vBx += mB * Px;
      vBy += mB * Py;
      wB += iB * (rBx * Py - rBy * Px);
    }

    if (useBias === false) {
      // Friction.
      for (let j = 0; j < pointCount; j++) {
        const cp = constraint.points[j]!;

        const rAx = cp.anchorAx;
        const rAy = cp.anchorAy;
        const rBx = cp.anchorBx;
        const rBy = cp.anchorBy;

        const vrBx = vBx - wB * rBy;
        const vrBy = vBy + wB * rBx;
        const vrAx = vAx - wA * rAy;
        const vrAy = vAy + wA * rAx;

        // vt = dot(vrB - vrA, tangent) - tangentSpeed
        const vt = (vrBx - vrAx) * tangentX + (vrBy - vrAy) * tangentY - constraint.tangentSpeed;

        // Incremental tangent impulse.
        let impulse = cp.tangentMass * -vt;

        // Clamp the accumulated force.
        const maxFriction = friction * cp.normalImpulse;
        const newImpulse = Math.min(
          Math.max(cp.tangentImpulse + impulse, -maxFriction),
          maxFriction
        );
        impulse = newImpulse - cp.tangentImpulse;
        cp.tangentImpulse = newImpulse;

        // Apply tangent impulse.
        const Px = impulse * tangentX;
        const Py = impulse * tangentY;
        vAx -= mA * Px;
        vAy -= mA * Py;
        wA -= iA * (rAx * Py - rAy * Px);
        vBx += mB * Px;
        vBy += mB * Py;
        wB += iB * (rBx * Py - rBy * Px);
      }

      // Rolling resistance.
      {
        let deltaLambda = -constraint.rollingMass * (wB - wA);
        const lambda = constraint.rollingImpulse;
        const maxLambda = constraint.rollingResistance * totalNormalImpulse;
        constraint.rollingImpulse = Math.min(Math.max(lambda + deltaLambda, -maxLambda), maxLambda);
        deltaLambda = constraint.rollingImpulse - lambda;

        wA -= iA * deltaLambda;
        wB += iB * deltaLambda;
      }
    }

    if (stateA.flags & DYNAMIC_FLAG) {
      stateA.vx = vAx;
      stateA.vy = vAy;
      stateA.omega = wA;
    }
    if (stateB.flags & DYNAMIC_FLAG) {
      stateB.vx = vBx;
      stateB.vy = vBy;
      stateB.omega = wB;
    }
  }
}

// ─── integratePositions (b2IntegratePositionsTask, stage 5) ───────────────────

/**
 * Apply motion locks and speed caps, then advance the solver delta-pose. Ports
 * `b2IntegratePositionsTask` (solver.c:113). Linear cap uses
 * `ctx.maxLinearVelocity`; angular cap uses `MAX_ROTATION * ctx.invDt`. Same
 * math as the existing `step.ts` `integratePositions`, here as solver stage 5.
 */
export function integratePositions(state: PhysicsState, ctx: StepContext, h: number): void {
  const states = state.solverSets[AWAKE_SET]!.bodyStates;
  const maxLinearSpeed = ctx.maxLinearVelocity;
  const maxAngularSpeed = MAX_ROTATION * ctx.invDt;
  const maxLinearSpeedSquared = maxLinearSpeed * maxLinearSpeed;
  const maxAngularSpeedSquared = maxAngularSpeed * maxAngularSpeed;

  for (let i = 0; i < states.length; i++) {
    const st = states[i]!;

    let vx = st.flags & LOCK_LINEAR_X ? 0.0 : st.vx;
    let vy = st.flags & LOCK_LINEAR_Y ? 0.0 : st.vy;
    let w = st.flags & LOCK_ANGULAR_Z ? 0.0 : st.omega;

    // Clamp to max linear speed.
    const v2 = vx * vx + vy * vy;
    if (v2 > maxLinearSpeedSquared) {
      const ratio = maxLinearSpeed / Math.sqrt(v2);
      vx *= ratio;
      vy *= ratio;
      st.flags |= IS_SPEED_CAPPED;
    }

    // Clamp to max angular speed.
    if (w * w > maxAngularSpeedSquared && (st.flags & ALLOW_FAST_ROTATION) === 0) {
      const ratio = maxAngularSpeed / Math.abs(w);
      w *= ratio;
      st.flags |= IS_SPEED_CAPPED;
    }

    st.vx = vx;
    st.vy = vy;
    st.omega = w;
    st.deltaPosX += h * vx;
    st.deltaPosY += h * vy;
    const dr: Rot = integrateRotation({ c: st.deltaRotCos, s: st.deltaRotSin }, h * w);
    st.deltaRotCos = dr.c;
    st.deltaRotSin = dr.s;
  }
}

// ─── applyRestitution (b2ApplyRestitution_Overflow) ───────────────────────────

/** Apply restitution at the end of the sub-step loop. Ports
 * `b2ApplyRestitution_Overflow` (contact_solver.c:410): skips
 * `restitution == 0` and points that did not collide
 * (`relativeVelocity > -threshold || totalNormalImpulse == 0`). */
export function applyRestitution(
  state: PhysicsState,
  ctx: StepContext,
  constraints: ContactConstraint[]
): void {
  const states = state.solverSets[AWAKE_SET]!.bodyStates;
  const contactCount = state.graphContactSims.length;
  const threshold = ctx.restitutionThreshold;

  for (let i = 0; i < contactCount; i++) {
    const constraint = constraints[i]!;

    const restitution = constraint.restitution;
    if (restitution === 0.0) {
      continue;
    }

    const mA = constraint.invMassA;
    const iA = constraint.invIA;
    const mB = constraint.invMassB;
    const iB = constraint.invIB;

    const indexA = constraint.indexA - 1;
    const indexB = constraint.indexB - 1;

    const stateA = stateAt(states, indexA);
    let vAx = stateA.vx;
    let vAy = stateA.vy;
    let wA = stateA.omega;

    const stateB = stateAt(states, indexB);
    let vBx = stateB.vx;
    let vBy = stateB.vy;
    let wB = stateB.omega;

    const normalX = constraint.normalX;
    const normalY = constraint.normalY;
    const pointCount = constraint.pointCount;

    for (let j = 0; j < pointCount; j++) {
      const cp = constraint.points[j]!;

      // Skip speculative points that did not generate an impulse.
      if (cp.relativeVelocity > -threshold || cp.totalNormalImpulse === 0.0) {
        continue;
      }

      const rAx = cp.anchorAx;
      const rAy = cp.anchorAy;
      const rBx = cp.anchorBx;
      const rBy = cp.anchorBy;

      // Relative normal velocity at contact.
      const vrBx = vBx - wB * rBy;
      const vrBy = vBy + wB * rBx;
      const vrAx = vAx - wA * rAy;
      const vrAy = vAy + wA * rAx;
      const vn = (vrBx - vrAx) * normalX + (vrBy - vrAy) * normalY;

      // Compute normal impulse.
      let impulse = -cp.normalMass * (vn + restitution * cp.relativeVelocity);

      // Clamp the accumulated impulse.
      const newImpulse = Math.max(cp.normalImpulse + impulse, 0.0);
      impulse = newImpulse - cp.normalImpulse;
      cp.normalImpulse = newImpulse;
      cp.totalNormalImpulse += impulse;

      // Apply contact impulse.
      const Px = impulse * normalX;
      const Py = impulse * normalY;
      vAx -= mA * Px;
      vAy -= mA * Py;
      wA -= iA * (rAx * Py - rAy * Px);
      vBx += mB * Px;
      vBy += mB * Py;
      wB += iB * (rBx * Py - rBy * Px);
    }

    if (stateA.flags & DYNAMIC_FLAG) {
      stateA.vx = vAx;
      stateA.vy = vAy;
      stateA.omega = wA;
    }
    if (stateB.flags & DYNAMIC_FLAG) {
      stateB.vx = vBx;
      stateB.vy = vBy;
      stateB.omega = wB;
    }
  }
}

// ─── storeImpulses (b2StoreImpulses_Overflow) ─────────────────────────────────

/** Copy the solved impulses back onto each touching contact's manifold. Ports
 * `b2StoreImpulses_Overflow` (contact_solver.c:516). Carries the impulses (and
 * the per-point normal velocity) forward for next-step warm starting and hit
 * events. */
export function storeImpulses(state: PhysicsState, constraints: ContactConstraint[]): void {
  const contacts = state.graphContactSims;

  for (let i = 0; i < contacts.length; i++) {
    const constraint = constraints[i]!;
    const manifold = contacts[i]!.manifold;
    const pointCount = manifold.pointCount;

    for (let j = 0; j < pointCount; j++) {
      const mp = manifold.points[j]!;
      const cp = constraint.points[j]!;
      mp.normalImpulse = cp.normalImpulse;
      mp.tangentImpulse = cp.tangentImpulse;
      mp.totalNormalImpulse = cp.totalNormalImpulse;
      mp.normalVelocity = cp.relativeVelocity;
    }

    manifold.rollingImpulse = constraint.rollingImpulse;
  }
}

// ─── solve (top-level pipeline) ───────────────────────────────────────────────

/**
 * Run the eight-stage TGS soft-step solver over the awake set's bodies and the
 * single overflow color (`state.graphContactSims`). Stage order (b2Solve loop,
 * solver.c:1038-1045 / physics_world.c):
 *
 *   prepareContacts (once)
 *   for s in 0..subSteps:
 *     integrateVelocities (h)
 *     warmStartContacts
 *     solveContacts(useBias = true)
 *     integratePositions (h)
 *     solveContacts(useBias = false)   // relax
 *   applyRestitution (once)
 *   storeImpulses (once)
 *
 * Operates on the awake set only. Does NOT finalize bodies (fold delta-pose,
 * write transforms, move events, AABB refit) — that stays in the orchestrator
 * (step.ts / VP-18). After this returns, the awake `bodyStates` carry the
 * resolved velocities and accumulated delta-pose. Early-returns if the awake
 * set is empty.
 */
export function solve(state: PhysicsState, ctx: StepContext): void {
  const awake: SolverSet = state.solverSets[AWAKE_SET]!;
  if (awake.bodySims.length === 0) {
    return;
  }

  const subStepCount = ctx.subStepCount;
  const h = ctx.h;
  const contactCount = state.graphContactSims.length;

  // Allocate one constraint per touching contact; reused across all sub-steps.
  const constraints: ContactConstraint[] = new Array(contactCount);
  for (let i = 0; i < contactCount; i++) {
    constraints[i] = makeConstraint();
  }

  prepareContacts(state, ctx, constraints);

  for (let s = 0; s < subStepCount; s++) {
    integrateVelocities(state, ctx, h);
    warmStartContacts(state, ctx, constraints);
    solveContacts(state, ctx, constraints, true);
    integratePositions(state, ctx, h);
    solveContacts(state, ctx, constraints, false);
  }

  applyRestitution(state, ctx, constraints);
  storeImpulses(state, constraints);
}

// ─── gatherHitEvents (VP-22) ─────────────────────────────────────────────────

/**
 * Scan the touching contacts for high-speed impacts and push raw
 * {@link ContactHitEvent} entries into `state.contactHitEvents`.
 *
 * Must be called AFTER `solve()` so that `storeImpulses` has written
 * `mp.normalVelocity = cp.relativeVelocity` and `mp.totalNormalImpulse` back
 * onto each manifold point (contact_solver.c:537-538 / solver.ts `storeImpulses`).
 *
 * Ports box2d solver.c:1725-1794 (the hit-event bitset scan), adapted for our
 * flat `state.graphContactSims` array instead of a per-color bitset walk.
 *
 * Algorithm (mirrors solver.c:1749-1789):
 *   for each touching contact with SIM_ENABLE_HIT_EVENT:
 *     approachSpeed = threshold   // (box2d: event.approachSpeed = threshold)
 *     found = false
 *     for each manifold point p:
 *       speed = -p.normalVelocity // (box2d: approachSpeed = -mp->normalVelocity)
 *       if speed > approachSpeed && p.totalNormalImpulse > 0:  // skip speculative
 *         approachSpeed = speed
 *         pointX = p.clipPoint.x, pointY = p.clipPoint.y
 *         found = true
 *     if found:
 *       push ContactHitEvent with normal = manifold.normal, the two shape handles
 *
 * box2d note on clipPoint (solver.c:1763):
 *   "Using the clip point here is somewhat questionable"
 *   We mirror this faithfully; VP-21b consumers should be aware that clipPoint
 *   accuracy degrades on recycled contacts (recycling is disabled in v1, so the
 *   point is fresh every step and reliable for now).
 */
export function gatherHitEvents(state: PhysicsState): void {
  const contacts = state.graphContactSims;
  const contactCount = contacts.length;
  if (contactCount === 0) {
    return;
  }

  const pool = state.shapes.idPool;
  const threshold = state.hitEventThreshold;

  for (let i = 0; i < contactCount; i++) {
    const contactSim: ContactSim = contacts[i]!;

    // Only contacts where at least one shape opted in (SIM_ENABLE_HIT_EVENT).
    // Mirrors box2d: the bitset scan iterates only contacts flagged by the
    // hit-event bit set in updateContact (contact.c:609-616 / contact.ts:630).
    if ((contactSim.simFlags & SIM_ENABLE_HIT_EVENT) === 0) {
      continue;
    }

    const manifold = contactSim.manifold;
    const pointCount = manifold.pointCount;

    // Mirrors solver.c:1749-1751: init event.approachSpeed = threshold.
    let approachSpeed = threshold;
    let pointX = 0;
    let pointY = 0;
    let found = false;

    for (let p = 0; p < pointCount; p++) {
      const mp = manifold.points[p]!;

      // solver.c:1757: approachSpeed = -mp->normalVelocity
      const speed = -mp.normalVelocity;

      // solver.c:1760: "Need to check total impulse because the point may be
      // speculative and not colliding"
      // if ( approachSpeed > event.approachSpeed && mp->totalNormalImpulse > 0.0f )
      if (speed > approachSpeed && mp.totalNormalImpulse > 0) {
        approachSpeed = speed;
        // solver.c:1764: "Using the clip point here is somewhat questionable"
        // event.point = mp->clipPoint;
        pointX = mp.clipPoint.x;
        pointY = mp.clipPoint.y;
        found = true;
      }
    }

    if (found) {
      // solver.c:1773: event.normal = contactSim->manifold.normal;
      // Build shape handles from the id pool, matching VP-21a's _makeContactTouchEvent.
      // Capture entity eids now (shapes are alive during the solve; VP-21b uses them
      // via state.shapeEntityByEid to resolve entities even after teardown).
      const eA = state.shapes.records[contactSim.shapeIdA]?.entity ?? -1;
      const eB = state.shapes.records[contactSim.shapeIdB]?.entity ?? -1;
      const event: ContactHitEvent = {
        shapeA: { index: contactSim.shapeIdA, generation: pool.generationOf(contactSim.shapeIdA) },
        shapeB: { index: contactSim.shapeIdB, generation: pool.generationOf(contactSim.shapeIdB) },
        entityEidA: eA,
        entityEidB: eB,
        pointX,
        pointY,
        normalX: manifold.normal.x,
        normalY: manifold.normal.y,
        approachSpeed,
      };
      // solver.c:1788: b2Array_Push( world->contactHitEvents, event );
      state.contactHitEvents.push(event);
    }
  }
}
