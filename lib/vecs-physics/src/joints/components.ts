// Joint components. A joint is its own entity that connects two bodies with a
// constraint. The connection is modelled with two relationships (`JointBodyA`,
// `JointBodyB`) so destroying a connected body cascade-destroys the joint and so
// joint creation is order-independent, mirroring shape↔body wiring via `ChildOf`.
//
// Each joint entity carries exactly one concrete joint-type component (every type
// implements the `Joint` umbrella, so `PhysicsModule` enforces mutual
// exclusivity). Optional, reusable feature components (`JointMotor`, `JointLimit`,
// `JointLinearSpring`, `JointAngularSpring`) layer behaviour on top: a feature is
// enabled exactly when its component is present, so features are set, tuned, and
// removed independently. Public API — see `docs/joints.md`.
//
// These are plain data classes: every field is initialised on the class body so
// `new C()` yields a valid, default-shaped instance (the Vecs zero-arg contract).
// No imports from behavior modules or adapter/ beyond the type-only `b2JointId` handle.

import { Relationship } from "@vworlds/vecs";

import type { Vec2 } from "@vworlds/vecs";
import type { b2JointId } from "../adapter/engine.js";

/**
 * Empty umbrella marker for every concrete joint type. A joint entity carries
 * exactly one of `RevoluteJoint`, `DistanceJoint`, `PrismaticJoint`,
 * `WheelJoint`, `WeldJoint`, `FilterJoint`, or `MotorJoint`; each implements
 * `Joint` so queries and systems can match any joint without enumerating every
 * concrete type. Holds the single Box2D handle, since every joint type maps to
 * exactly one `b2JointId`.
 * Base constraint softness is 60 Hz / damping ratio 2 in both the 6.0.1 and
 * 7.0.0 WASM backends, capped to `0.25 / h` Hz for substep duration `h`.
 * This is independent of explicit spring features and is not a public tunable.
 * Create at the assembly rest pose; move/reset every body's pose and velocity
 * consistently when teleporting. See `docs/joints.md` for the 3.2 speed-clamp caveat.
 */
export abstract class Joint {
  /** @internal Engine-owned Box2D joint handle. Set by the joint lifecycle system. */
  _jointId: b2JointId | undefined = undefined;
}

/**
 * Relationship to the first connected body ("body A"). Set its `target` to the
 * body entity. Destroying body A destroys the joint entity, with every component
 * on it, as Box2D destroys a body's joints with it (`(OnDeleteTarget, Delete)`); body
 * B is left alone. Removing `Body` from A only tears the constraint down.
 * Anchors/limits/reference angle are expressed relative to A through
 * {@link JointFrame}.
 */
export class JointBodyA extends Relationship {}

/**
 * Relationship to the second connected body ("body B"). Set its `target` to the
 * body entity. Destroying body B destroys the joint entity, with every component
 * on it (`(OnDeleteTarget, Delete)`); body A is left alone. Removing `Body` from B
 * only tears the constraint down. The A/B roles are asymmetric: motors drive B
 * relative to A and the reference angle is measured as B's rest angle relative
 * to A.
 */
export class JointBodyB extends Relationship {}

/**
 * Where the joint attaches on each body and the bodies' rest orientation.
 * `localAnchorA`/`localAnchorB` are anchor points in each body's local frame;
 * `referenceAngle` is body B's angle relative to body A at rest (radians).
 *
 * Optional: a missing `JointFrame` anchors both bodies at their origins with a
 * zero reference angle. `DistanceJoint` and `FilterJoint` ignore
 * `referenceAngle`. `PrismaticJoint` and `WheelJoint` read it instead as their
 * sliding axis's angle in body A's local frame (0 = body A's local x-axis);
 * `PrismaticJoint` additionally locks the bodies' relative angle at that value
 * (like `WeldJoint`), while `WheelJoint` leaves rotation free.
 */
export class JointFrame {
  localAnchorA: Vec2 = { x: 0, y: 0 };
  localAnchorB: Vec2 = { x: 0, y: 0 };
  referenceAngle = 0;
}

/**
 * Revolute (hinge) joint: pins the two bodies at a shared anchor and lets them
 * rotate relative to each other. Add {@link JointMotor} to drive the rotation,
 * {@link JointLimit} to clamp the angle (radians, relative to the reference
 * angle), or {@link JointAngularSpring} for a soft rest angle.
 */
export class RevoluteJoint extends Joint {}

/**
 * Distance joint: keeps the two anchor points a fixed `length` apart (a rigid
 * rod by default). Add {@link JointLinearSpring} to make it springy,
 * {@link JointLimit} to bound the separation (`lower`/`upper` become min/max
 * length), or {@link JointMotor} to drive the length.
 * `length` measures anchor distance, not its x- or y-projection while swinging.
 */
export class DistanceJoint extends Joint {
  length = 1;
}

/**
 * Prismatic joint: locks the two bodies' relative angle (like {@link WeldJoint})
 * but lets body B slide along one axis relative to body A. The axis is body A's
 * local x-axis, rotated by {@link JointFrame.referenceAngle}. Add
 * {@link JointMotor} to drive the slide (m/s, force), {@link JointLimit} to
 * bound the translation (meters), or {@link JointLinearSpring} for a soft rest
 * position along the axis.
 */
export class PrismaticJoint extends Joint {}

/**
 * Wheel joint: like {@link PrismaticJoint} — body B slides along an axis fixed
 * by {@link JointFrame.referenceAngle} — but leaves the bodies' relative
 * rotation completely free (a wheel spinning on its axle) instead of locking
 * it. Add {@link JointMotor} to drive that rotation (rad/s, torque, like
 * {@link RevoluteJoint}), {@link JointLimit} to bound the suspension travel
 * (meters), or {@link JointLinearSpring} for the suspension spring.
 */
export class WheelJoint extends Joint {}

/**
 * Weld joint: rigidly fixes the two bodies' relative position and orientation
 * (at the reference angle). Add {@link JointLinearSpring} and/or
 * {@link JointAngularSpring} to make the weld soft along each axis.
 */
export class WeldJoint extends Joint {}

/**
 * Filter joint: disables collision between the two connected bodies without
 * otherwise constraining them. Carries no tunables; motor/limit/spring features
 * do not apply.
 */
export class FilterJoint extends Joint {}

/**
 * Motor joint: drives body B toward a target pose relative to body A —
 * {@link JointFrame}'s anchors and `referenceAngle` set that target — using a
 * velocity-tracking motor and a positional spring that are both always active.
 * Unlike every other joint type, Box2D has no enable flags for this behaviour,
 * so it does not compose with {@link JointMotor}, {@link JointLimit},
 * {@link JointLinearSpring}, or {@link JointAngularSpring}: it carries its own
 * fields directly, mirroring `DistanceJoint.length`. Common use: kinematic-feel
 * player or platform control that still collides normally.
 */
export class MotorJoint extends Joint {
  /** Target linear velocity of body B relative to body A (m/s), tracked by the velocity motor. */
  linearVelocity: Vec2 = { x: 0, y: 0 };
  /** Maximum force (N) the velocity motor may use to track `linearVelocity`. */
  maxVelocityForce = 0;
  /** Target angular velocity of body B relative to body A (rad/s), tracked by the velocity motor. */
  angularVelocity = 0;
  /** Maximum torque (N·m) the velocity motor may use to track `angularVelocity`. */
  maxVelocityTorque = 0;
  /** Linear spring stiffness (Hz) pulling body B toward the frame's target position. Zero disables the spring's pull, leaving only the velocity motor. */
  linearHertz = 0;
  /** Linear spring damping ratio. */
  linearDampingRatio = 0;
  /** Maximum force (N) the linear spring may use. */
  maxSpringForce = 0;
  /** Angular spring stiffness (Hz) pulling body B toward the frame's reference angle. Zero disables the spring's pull, leaving only the velocity motor. */
  angularHertz = 0;
  /** Angular spring damping ratio. */
  angularDampingRatio = 0;
  /** Maximum torque (N·m) the angular spring may use. */
  maxSpringTorque = 0;
}

/**
 * Optional motor feature. Present = motor enabled. Drives the joint toward
 * `targetSpeed` bounded by `maxForce`. Angular joints (`RevoluteJoint`,
 * `WheelJoint`) interpret this as rad/s and a torque; linear joints
 * (`DistanceJoint`, `PrismaticJoint`) interpret it as m/s and a force. Does not
 * apply to `WeldJoint`, `FilterJoint`, or `MotorJoint`.
 */
export class JointMotor {
  targetSpeed = 0;
  maxForce = 0;
}

/**
 * Optional limit feature. Present = limit enabled. `lower`/`upper` are an angle
 * range (radians) for `RevoluteJoint` and a length/translation range (meters)
 * for `DistanceJoint`, `PrismaticJoint`, and `WheelJoint`. Does not apply to
 * `WeldJoint`, `FilterJoint`, or `MotorJoint`.
 */
export class JointLimit {
  lower = 0;
  upper = 0;
}

/**
 * Optional linear spring feature (soft constraint along the joint's linear axis).
 * Present = spring enabled. `hertz` is the stiffness frequency, `dampingRatio`
 * the damping. Applies to `DistanceJoint`, `PrismaticJoint`, `WheelJoint`, and
 * the linear axis of `WeldJoint`.
 * Uses its own softness, not base constraint tuning. For a distance joint this
 * replaces the rigid rod's response along the axis; the spring settings did not
 * change with the 7.0.0 backend migration.
 */
export class JointLinearSpring {
  hertz = 0;
  dampingRatio = 0;
}

/**
 * Optional angular spring feature (soft constraint on the relative angle).
 * Present = spring enabled. Applies to `RevoluteJoint` and the angular axis of
 * `WeldJoint`. Split from {@link JointLinearSpring} so a weld can carry both at
 * once.
 */
export class JointAngularSpring {
  hertz = 0;
  dampingRatio = 0;
}

/**
 * Optional base-joint settings. `collideConnected` lets the two connected bodies
 * still collide with each other (off by default). Missing = Box2D defaults.
 */
export class JointSettings {
  collideConnected = false;
}
