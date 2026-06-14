// Body-level components: the entity-marking `Body` plus the canonical pose and
// velocity data. Defaults match Box2D's `b2DefaultBodyDef()` (see
// `box2d/src/types.c`). Public API — see `docs/components.md`.
//
// These are plain data classes: every field is initialised on the class body so
// `new C()` yields a valid, default-shaped instance (the Vecs zero-arg
// contract). No imports from systems/ or adapter/ beyond type-only `b2*Id`
// handle types — components are pure data.

import type { b2BodyId } from "../adapter/engine.js";

/** Simulation behaviour of a {@link Body}. */
export enum BodyType {
  /** Immovable level geometry. */
  Static = "static",
  /** Moved by user-authored velocity or kinematic targets; infinite mass. */
  Kinematic = "kinematic",
  /** Responds to forces, impulses, gravity, and contacts. */
  Dynamic = "dynamic",
}

/** Marks an entity as a physics body. Missing `Body` means physics ignores it. */
export class Body {
  type = BodyType.Static;
  bullet = false;
  enabled = true;
  allowFastRotation = false;
  /** @internal Engine-owned box2d handle; set by the lifecycle system, undefined until then. */
  _bodyId: b2BodyId | undefined = undefined;
}

/** Canonical world-space body position. Teleports when written by user code. */
export class Position {
  x = 0;
  y = 0;
}

/** World-space body rotation in radians. Missing `Rotation` means angle 0. */
export class Rotation {
  angle = 0;
}

/** Body linear velocity in metres per second. Authoritative both directions. */
export class LinearVelocity {
  x = 0;
  y = 0;
}

/** Body angular velocity in radians per second. */
export class AngularVelocity {
  value = 0;
}
