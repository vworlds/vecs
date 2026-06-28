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
// No imports from systems/ or adapter/ beyond the type-only `b2JointId` handle.

import { Relationship } from "@vworlds/vecs";

import type { Vec2 } from "./geometry.js";
import type { b2JointId } from "../adapter/engine.js";

/**
 * Empty umbrella marker for every concrete joint type. A joint entity carries
 * exactly one of `RevoluteJoint`, `DistanceJoint`, `WeldJoint`, or `FilterJoint`;
 * each implements `Joint` so queries and systems can match any joint without
 * enumerating every concrete type. Holds the single Box2D handle, since every
 * joint type maps to exactly one `b2JointId`.
 */
export abstract class Joint {
  /** @internal Engine-owned Box2D joint handle. Set by the joint lifecycle system. */
  _jointId: b2JointId | undefined = undefined;
}

/**
 * Relationship to the first connected body ("body A"). Set its `target` to the
 * body entity. Destroying body A destroys the joint entity (Box2D destroys a
 * body's joints with it). Anchors/limits/reference angle are expressed relative
 * to A through {@link JointFrame}.
 */
export class JointBodyA extends Relationship {}

/**
 * Relationship to the second connected body ("body B"). Set its `target` to the
 * body entity. Destroying body B destroys the joint entity. The A/B roles are
 * asymmetric: motors drive B relative to A and the reference angle is measured as
 * B's rest angle relative to A.
 */
export class JointBodyB extends Relationship {}

/**
 * Where the joint attaches on each body and the bodies' rest orientation.
 * `localAnchorA`/`localAnchorB` are anchor points in each body's local frame;
 * `referenceAngle` is body B's angle relative to body A at rest (radians).
 *
 * Optional: a missing `JointFrame` anchors both bodies at their origins with a
 * zero reference angle. `DistanceJoint` ignores `referenceAngle`.
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
 */
export class DistanceJoint extends Joint {
  length = 1;
}

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
 * Optional motor feature. Present = motor enabled. Drives the joint toward
 * `targetSpeed` (rad/s for revolute, m/s for distance) bounded by `maxForce`
 * (interpreted as a torque for angular joints). Applies to `RevoluteJoint` and
 * `DistanceJoint`.
 */
export class JointMotor {
  targetSpeed = 0;
  maxForce = 0;
}

/**
 * Optional limit feature. Present = limit enabled. `lower`/`upper` are an angle
 * range (radians) for `RevoluteJoint` and a length range (meters) for
 * `DistanceJoint`.
 */
export class JointLimit {
  lower = 0;
  upper = 0;
}

/**
 * Optional linear spring feature (soft constraint along the joint's linear axis).
 * Present = spring enabled. `hertz` is the stiffness frequency, `dampingRatio`
 * the damping. Applies to `DistanceJoint` and the linear axis of `WeldJoint`.
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
