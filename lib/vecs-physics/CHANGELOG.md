# Changelog

All notable changes to `@vworlds/vecs-physics` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-31

### Added - Bodies

- Static, kinematic, and dynamic bodies with position, rotation, linear velocity, and angular velocity components.
- Body type transitions, enable/disable bookkeeping, and pose sync through Vecs phases.
- `Damping` and `GravityScale` support in velocity integration.
- `MotionLocks` for linear and angular axis locking.
- `Sleep` wiring placeholder support across body lifecycle and solver state.

### Added - Shapes

- `Box`, `Circle`, `Capsule`, `Segment`, `Polygon`, and `Chain` shape components.
- Shape-local `ShapePosition` and `ShapeRotation` for compound bodies.
- Broad phase dynamic tree and proxy management across static, kinematic, and dynamic trees.
- Narrow-phase manifolds for supported shape pairs, including one-sided chain collision.
- Mass computation for supported shapes, including sensor-mass parity and density handling.

### Added - Contacts + solver

- TGS soft-step contact solver using the v1 single-overflow-color execution model.
- Contact begin/end tracking with shape-local opt-in flags.
- Sensor overlap foundation and hit-event plumbing through the engine.
- Contact persistence, island bookkeeping, and solver warm-start impulse storage for stable stacks.
- HelloWorld, stacking, bounce, contact ordering, and friction-ramp parity coverage.

### Added - Forces + events + sensors

- Persistent `Force` and `Torque` plus accumulating `Impulse` and `AngularImpulse` components.
- ECS event components: `ContactEvents`, `SensorEvents`, and `HitEvents`.
- Kinematic target drive via `KinematicTargetPosition` and `KinematicTargetRotation`.
- `Material` support for density, friction, restitution, rolling resistance, and tangent speed.
- `CollisionFilter` support for category bits, mask bits, and group index.
- `Sensor` components with Box2D-compatible filtering and sensor overlap rules.

### Added - Sleep + CCD + debug + perf

- `Sleep` component, sleeping solver sets, island split, and wake paths for force, impulse, kinematic, teleport, and contact disturbance flows.
- Continuous collision support through `Body.bullet` and `enableContinuous` for bullets and fast bodies.
- Optional `installPhysics(world, { debug: true })` validation warnings for invalid ECS structures.
- Fat-AABB hysteresis parity fix and hot-path scratch reuse.
- Benchmark harness under `bench/` for `stacking` and `falling_balls` scenarios.

### Added - Hardening, docs, release

- Documentation audit plus a docs-to-code defaults parser test.
- Box2D test-suite parity sweep covering five missing v1-relevant ports.
- `architecture/SOLVER.md` implementation map for solver, CCD, sleep, broad phase, contacts, and deviations.
- Fuzz harness with fixed seeds and public API export snapshot at `tests/api/exports.approved.json`.
- Package README, four runnable examples, and monorepo server-demo integration using the public API.
- MIT license metadata and package version `1.0.0` release artifacts.
- `bench/BASELINE.md` records the v1 informational performance baseline; release tagging is handled after merge.

### Limitations

- No joints.
- No ray casts or shape casts.
- No AABB overlap queries.
- No public character mover helpers.
- No debug drawing API.
- Single-threaded solver only.
- No contact recycling.
- No public sensor TOI hits queue.
- Dynamic `Sensor` marker toggles require recreating the shape in v1.
- Open-chain ghost vertices at sharp endpoints are deferred to v2 parity work.
