// The shared dead-reckoning integrator: Box2D v3's step of a free body, reproduced in plain JS.
//
// It mirrors, operation for operation and in single precision, how one `b2World_Step` advances a
// body that nothing touches, as the box2d3-wasm the repo depends on builds it. box2d3-wasm 5.2.0
// pins Box2D commit 3a4f0da8374af61293a03021c9a0b3ebcfe67948; every `file:line` below refers to that
// commit, which `.agents/rules/box2d-references.md` tells how to clone.
//
// - `b2World_Step` (src/physics_world.c:709): `h = dt / subStepCount` and `inv_dt = 1 / dt`.
// - `b2IntegrateVelocitiesTask` (src/solver.c:65): damping, gravity times the gravity scale
//   (:99-102), the linear speed clamp and the angular one unless `allowFastRotation` (:117).
// - `b2IntegratePositionsTask` (src/solver.c:214): the accumulated `deltaPosition` and
//   `deltaRotation`, with `b2IntegrateRotation` (include/box2d/math_functions.h:346).
// - `b2FinalizeBodiesTask` (src/solver.c:630): the center, the rotation (`b2MulRot` and
//   `b2NormalizeRot`, include/box2d/math_functions.h:455 and :335) and the origin, once per step.
// - `b2Body_SetTransform` (src/body.c:721) with `b2TransformPoint` (include/box2d/math_functions.h:511):
//   the center of mass from the origin.
// - `b2Atan2` (src/math_functions.c:71): the angle of a rotation, as `b2Rot.GetAngle` returns it.
//
// Box2D computes in `float`, so the stepping operations here are rounded to f32 with `Math.fround`.
// `+ - * /` and `sqrt` on f32 values, rounded after each operation, reproduce the IEEE single
// arithmetic used by wasm without fast-math or fused multiply-add. The executed evidence is the
// real-WASM accuracy test on its tested runtime; arbitrary rotation initialization below uses
// `sin` and `cos`, whose final bits may vary across JS engines. Doubles would not do: Box2D adds
// each substep's displacement in f32, and the same integrator in doubles ends millimeters to
// centimeters away after a minute. `stepMotion` and `motionPose` call no `sin`, `cos` or `atan2`.

import type { Motion, MotionClock, MotionParams } from "../components/motion.js";

const f32 = Math.fround;

/**
 * `B2_MAX_ROTATION`, src/constants.h:34: `0.25f * B2_PI`, with `B2_PI` the float `3.14159265359f`
 * (include/box2d/math_functions.h:79).
 */
const B2_MAX_ROTATION = f32(0.25 * f32(3.14159265359));

/**
 * The integrator's state for one body: the center of mass, the rotation as a cosine and a sine,
 * and the velocities, as Box2D's body state holds them. Each value is an f32. Allocate one per body
 * and reuse it: every function here writes into the object it is given.
 */
export class MotionState {
  /** Center of mass, x, in meters. */
  public cx = 0;

  /** Center of mass, y, in meters. */
  public cy = 0;

  /** Cosine of the body angle (`b2Rot.c`). */
  public qc = 1;

  /** Sine of the body angle (`b2Rot.s`). */
  public qs = 0;

  /** Linear velocity of the center of mass, x, in meters per second. */
  public vx = 0;

  /** Linear velocity of the center of mass, y, in meters per second. */
  public vy = 0;

  /** Angular velocity in radians per second. */
  public w = 0;
}

/** The pose of a body as the render components hold it, read from a {@link MotionState}. */
export class MotionPose {
  /** Body origin, x, in meters. */
  public x = 0;

  /** Body origin, y, in meters. */
  public y = 0;

  /** Body angle in radians, in [-π, π], counter-clockwise positive. */
  public angle = 0;
}

/**
 * Build the integrator state of a baseline.
 *
 * The rotation is the cosine and sine of `motion.angle`, and the center of mass is the origin plus
 * the body's local center (from `params`) turned by that rotation, as `b2Body_SetTransform` derives
 * it. The velocities are copied. Call this once per baseline, then advance the state with
 * {@link stepMotion}. Pass the baseline and the constants as decoded from the wire, so every peer
 * starts from the same f32 values.
 *
 * The rotation is only as exact as the angle. A physics `Rotation` holds Box2D's `b2Atan2` of the
 * body's rotation, which is within 2.8e-5 rad of the true angle, so a baseline taken from it
 * restarts the body that far off Box2D's rotation and the prediction keeps that small offset (the
 * accuracy tests measure it). A baseline whose rotation Box2D holds exactly, such as angle 0,
 * follows the same f32 stepping arithmetic as Box2D; accuracy is established by the real-WASM
 * tests on the tested runtime.
 *
 * This is the integrator's only use of `Math.cos` and `Math.sin`. An engine may round them
 * differently from another in the last bit of the double; that survives the rounding to f32 only
 * rarely, then moves the rotation by one f32 step (6e-8 rad), which later steps do not amplify.
 *
 * @param motion The baseline.
 * @param params The body's constants; {@link defaultMotionParams} for an entity without any.
 * @param out The state to overwrite.
 * @returns `out`.
 */
export function motionStateFrom(
  motion: Readonly<Motion>,
  params: Readonly<MotionParams>,
  out: MotionState
): MotionState {
  const angle = f32(motion.angle);
  const qc = f32(Math.cos(angle));
  const qs = f32(Math.sin(angle));
  const lx = f32(params.localCenterX);
  const ly = f32(params.localCenterY);

  // b2TransformPoint( transform, localCenter ): `( q.c * p.x - q.s * p.y ) + t.p.x`.
  out.cx = f32(f32(f32(qc * lx) - f32(qs * ly)) + f32(motion.x));
  out.cy = f32(f32(f32(qs * lx) + f32(qc * ly)) + f32(motion.y));
  out.qc = qc;
  out.qs = qs;
  out.vx = f32(motion.vx);
  out.vy = f32(motion.vy);
  out.w = f32(motion.w);
  return out;
}

/**
 * Advance a body by one physics step, in place and without allocating.
 *
 * Runs `clock.subSteps` substeps of Box2D's free-body integration (damping, gravity, the speed
 * clamps, the position and the rotation) and applies the accumulated displacement once, as
 * `b2World_Step` does, with the body's `gravityScale` and `allowFastRotation`. Forces, contacts,
 * joints, locked axes and sleep are not modeled: a body they affect leaves the predicted path and
 * needs a new baseline.
 *
 * A baseline at rest ({@link Motion.rest}) is not stepped: its sender holds the pose, and the
 * caller skips this function for it.
 *
 * Box2D zeroes the gravity scale of a body without mass (`invMass == 0`, src/solver.c:99). The
 * constants carry no mass, so their sender must set `gravityScale` to 0 for a kinematic body.
 *
 * The clock and the body constants are read as f32 values, as they arrive from the wire, so a
 * caller that holds the doubles it encoded steps to the same state as its peers.
 *
 * @param state The state to advance.
 * @param params The body's constants (damping, gravity scale, fast rotation).
 * @param clock The world constants.
 */
export function stepMotion(
  state: MotionState,
  params: Readonly<MotionParams>,
  clock: Readonly<MotionClock>
): void {
  // b2World_Step: a time step of zero returns before the solver runs. Otherwise
  // `context.h = timeStep / subStepCount` and `context.inv_dt = 1 / timeStep`, with the substep
  // count raised to at least one.
  const dt = f32(clock.stepSeconds);
  if (!(dt > 0)) {
    return;
  }
  const subSteps = clock.subSteps > 1 ? clock.subSteps | 0 : 1;
  const h = f32(dt / subSteps);
  const invDt = f32(1 / dt);

  // b2IntegrateVelocitiesTask computes these once per substep from constants; they do not change
  // between substeps, so they are computed once here, by the same expressions.
  const maxLinearSpeed = f32(clock.maxLinearSpeed);
  const maxLinearSpeedSquared = f32(maxLinearSpeed * maxLinearSpeed);
  // The rotation cap is per step: `B2_MAX_ROTATION * context->inv_dt`, not `inv_h`.
  const maxAngularSpeed = f32(B2_MAX_ROTATION * invDt);
  const maxAngularSpeedSquared = f32(maxAngularSpeed * maxAngularSpeed);
  // Pade approximation of `exp(-c * h)`: `1.0f / ( 1.0f + h * sim->linearDamping )`.
  const linearDamping = f32(1 / f32(1 + f32(h * f32(params.linearDamping))));
  const angularDamping = f32(1 / f32(1 + f32(h * f32(params.angularDamping))));
  // `b2MulSV( h * gravityScale, gravity )`; the force term is zero.
  const hg = f32(h * f32(params.gravityScale));
  const gravityDeltaX = f32(hg * f32(clock.gravityX));
  const gravityDeltaY = f32(hg * f32(clock.gravityY));
  const clampRotation = !params.allowFastRotation;

  let vx = state.vx;
  let vy = state.vy;
  let w = state.w;
  // `state->deltaPosition` and `state->deltaRotation`, reset to zero and identity every step.
  let dx = 0;
  let dy = 0;
  let dqc = 1;
  let dqs = 0;

  for (let i = 0; i < subSteps; i++) {
    // `v = b2MulAdd( linearVelocityDelta, linearDamping, v )` and
    // `w = angularVelocityDelta + angularDamping * w`, the torque term being zero.
    vx = f32(gravityDeltaX + f32(linearDamping * vx));
    vy = f32(gravityDeltaY + f32(linearDamping * vy));
    w = f32(angularDamping * w);

    // `b2Dot( v, v ) > maxLinearSpeedSquared`, then `b2MulSV( maxLinearSpeed / b2Length( v ), v )`.
    const speedSquared = f32(f32(vx * vx) + f32(vy * vy));
    if (speedSquared > maxLinearSpeedSquared) {
      const ratio = f32(maxLinearSpeed / f32(Math.sqrt(speedSquared)));
      vx = f32(ratio * vx);
      vy = f32(ratio * vy);
    }

    // `w * w > maxAngularSpeedSquared && ( sim->flags & b2_allowFastRotation ) == 0`, then
    // `w *= maxAngularSpeed / b2AbsFloat( w )`.
    if (clampRotation && f32(w * w) > maxAngularSpeedSquared) {
      w = f32(w * f32(maxAngularSpeed / Math.abs(w)));
    }

    // b2IntegratePositionsTask: `deltaPosition = b2MulAdd( deltaPosition, h, v )`.
    dx = f32(dx + f32(h * vx));
    dy = f32(dy + f32(h * vy));

    // `deltaRotation = b2IntegrateRotation( deltaRotation, h * w )`: `q + deltaAngle * perp( q )`,
    // normalized, instead of the cosine and sine of the angle.
    const deltaAngle = f32(h * w);
    const nc = f32(dqc - f32(deltaAngle * dqs));
    const ns = f32(dqs + f32(deltaAngle * dqc));
    const mag = f32(Math.sqrt(f32(f32(ns * ns) + f32(nc * nc))));
    const invMag = mag > 0 ? f32(1 / mag) : 0;
    dqc = f32(nc * invMag);
    dqs = f32(ns * invMag);
  }

  // b2FinalizeBodiesTask: `center = b2Add( center, deltaPosition )` and
  // `q = b2NormalizeRot( b2MulRot( deltaRotation, q ) )`.
  const qc = state.qc;
  const qs = state.qs;
  const rs = f32(f32(dqs * qc) + f32(dqc * qs));
  const rc = f32(f32(dqc * qc) - f32(dqs * qs));
  const mag = f32(Math.sqrt(f32(f32(rs * rs) + f32(rc * rc))));
  const invMag = mag > 0 ? f32(1 / mag) : 0;

  state.cx = f32(state.cx + dx);
  state.cy = f32(state.cy + dy);
  state.qc = f32(rc * invMag);
  state.qs = f32(rs * invMag);
  state.vx = vx;
  state.vy = vy;
  state.w = w;
}

/**
 * Read the pose of a state: the origin and the angle the physics pose would hold.
 *
 * The origin is the center of mass minus the local center turned by the rotation, as
 * `b2FinalizeBodiesTask` derives `transform.p`. The angle is Box2D's own `b2Atan2` of the rotation,
 * the polynomial that `b2Rot.GetAngle` and so the physics `Rotation` use, so an undisturbed body's
 * predicted pose equals its physics pose exactly. It calls no transcendental function.
 *
 * @param state The state to read.
 * @param params The body's constants, which supply the local center.
 * @param out The pose to overwrite.
 * @returns `out`.
 */
export function motionPose(
  state: Readonly<MotionState>,
  params: Readonly<MotionParams>,
  out: MotionPose
): MotionPose {
  const qc = state.qc;
  const qs = state.qs;
  const lx = f32(params.localCenterX);
  const ly = f32(params.localCenterY);

  // `b2Sub( center, b2RotateVector( q, localCenter ) )`, with b2RotateVector
  // (include/box2d/math_functions.h:499) `{ q.c * v.x - q.s * v.y, q.s * v.x + q.c * v.y }`.
  out.x = f32(state.cx - f32(f32(qc * lx) - f32(qs * ly)));
  out.y = f32(state.cy - f32(f32(qs * lx) + f32(qc * ly)));
  out.angle = b2Atan2(qs, qc);
  return out;
}

/**
 * Box2D's `b2Atan2( y, x )` (src/math_functions.c:71): a minimax polynomial for `atan` on [0, 1],
 * mapped to the full circle, in f32. Within 2.8e-5 rad of the true angle.
 */
function b2Atan2(y: number, x: number): number {
  if (x === 0 && y === 0) {
    return 0;
  }
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const mx = Math.max(ay, ax);
  const mn = Math.min(ay, ax);
  const a = f32(mn / mx);

  const s = f32(a * a);
  const c = f32(s * a);
  const q = f32(s * s);
  let r = f32(f32(f32(0.024840285) * q) + f32(0.18681418));
  const t = f32(f32(f32(-0.094097948) * q) - f32(0.33213072));
  r = f32(f32(r * s) + t);
  r = f32(f32(r * c) + a);

  if (ay > ax) {
    r = f32(f32(1.57079637) - r);
  }
  if (x < 0) {
    r = f32(f32(3.14159274) - r);
  }
  return y < 0 ? -r : r;
}
