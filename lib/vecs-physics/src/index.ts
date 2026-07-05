// Public API surface for @vworlds/vecs-physics. Only re-exports — no logic.
// The stable contract is documented in docs/ and architecture/ARCHITECTURE.md →
// Public API Contract.

// Entry point
export { PhysicsModule, type PhysicsOptions } from "./module.js";
export { preloadPhysics } from "./adapter/runtime.js";

// Body
export {
  Body,
  BodyType,
  Position,
  Rotation,
  LinearVelocity,
  AngularVelocity,
} from "./body/components.js";

// Body tunables
export { Damping, GravityScale, MotionLocks, Sleep } from "./body/tuning.js";

// Shape pose
export { ShapePosition, ShapeRotation } from "./shapes/pose_components.js";

// Geometry
export {
  Shape,
  Box,
  Circle,
  Capsule,
  Segment,
  Polygon,
  Chain,
  type Vec2,
} from "./shapes/components.js";

// Material / filter / sensor
export { Material, CollisionFilter, Sensor, Detectable } from "./materials/components.js";

// Forces & impulses
export { Force, Torque, Impulse, AngularImpulse } from "./forces/components.js";

// Kinematic targets
export { KinematicTargetPosition, KinematicTargetRotation } from "./kinematic/components.js";

// Joints
export {
  Joint,
  JointBodyA,
  JointBodyB,
  JointFrame,
  RevoluteJoint,
  DistanceJoint,
  PrismaticJoint,
  WheelJoint,
  WeldJoint,
  FilterJoint,
  MotorJoint,
  JointMotor,
  JointLimit,
  JointLinearSpring,
  JointAngularSpring,
  JointSettings,
} from "./joints/components.js";

// Events
export {
  ContactEvents,
  type ContactEvent,
  SensorEvents,
  type SensorEvent,
  HitEvents,
  type HitEvent,
} from "./events/components.js";

// Queries
export { physics } from "./adapter/queries.js";
export type { PhysicsQueries, QueryFilter, RayHit } from "./adapter/queries.js";
