// Public API surface for @vworlds/vecs-physics. Only re-exports — no logic.
// The stable contract is documented in docs/ and architecture/PLAN.md →
// Public API Contract. `installPhysics` lands in VP-4.

// Body
export {
  Body,
  BodyType,
  Position,
  Rotation,
  LinearVelocity,
  AngularVelocity,
} from "./components/body.js";

// Body tunables
export { Damping, GravityScale, MotionLocks, Sleep } from "./components/body_tuning.js";

// Shape pose
export { ShapePosition, ShapeRotation } from "./components/shape_pose.js";

// Geometry
export { Box, Circle, Capsule, Segment, Polygon, Chain, type Vec2 } from "./components/geometry.js";

// Material / filter / sensor
export { Material, CollisionFilter, Sensor } from "./components/material.js";

// Forces & impulses
export { Force, Torque, Impulse, AngularImpulse } from "./components/force.js";

// Kinematic targets
export { KinematicTargetPosition, KinematicTargetRotation } from "./components/target.js";

// Events
export {
  ContactEvents,
  type ContactEvent,
  SensorEvents,
  type SensorEvent,
  HitEvents,
  type HitEvent,
} from "./components/events.js";
