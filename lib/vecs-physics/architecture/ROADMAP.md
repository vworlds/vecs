# vecs-physics Roadmap

Engineering-facing roadmap. The user-facing deferred-features page is `docs/roadmap.md`; this document is the planning view: where the package stands, what v2 is, and what is deliberately out of scope.

- Current architecture: [`ARCHITECTURE.md`](./ARCHITECTURE.md).
- v2 execution detail: [`PLAN-v2.md`](./PLAN-v2.md).

---

## Where we are (v1, shipped)

v1 is published as `@vworlds/vecs-physics@1.0.x` and is in production use (the spacerocks game migrated onto it). Everything in the original v1 scope shipped, **and** the engine was migrated off the in-house TypeScript Box2D port onto **box2d3-wasm** (the former Milestone 7). The package is now a thin Vecs↔Box2D adapter.

Delivered and stable:

| Area              | State                                                            |
| ----------------- | ---------------------------------------------------------------- |
| Bodies            | static / kinematic / dynamic, pose + velocity, tunables          |
| Shapes            | `Box` `Circle` `Capsule` `Segment` `Polygon` `Chain`, local pose |
| Materials         | density / friction / restitution / rolling resistance / tangent  |
| Collision filters | category / mask / group                                          |
| Sensors           | `Sensor` marker + `SensorEvents` (see UP-1 caveat below)         |
| Forces / impulses | persistent `Force`/`Torque`, one-shot `Impulse`/`AngularImpulse` |
| Kinematic targets | `KinematicTargetPosition` / `KinematicTargetRotation`            |
| Events            | `ContactEvents` / `SensorEvents` / `HitEvents`                   |
| Sleep             | `Sleep` + `enableSleep`                                          |
| Continuous (CCD)  | `Body.bullet` + `enableContinuous`                               |
| Debug validation  | opt-in deduplicated structural warnings                          |
| Backend           | box2d3-wasm@5.2.0; ~3.6× faster than the old TS engine           |

The public surface is pure-component plus `preloadPhysics()` and `PhysicsModule`. There is no imperative API.

## What v2 is

v2 is **adopter-driven**. The first production integration (spacerocks → vecs-physics, see `~/src/spacerocks/MIGRATION-REPORT.md`) surfaced four gaps that forced architecture-level workarounds. v2 closes exactly those four. They are the required scope; nothing else is committed.

| ID   | Gap                                                                           | Severity | Kind               |
| ---- | ----------------------------------------------------------------------------- | -------- | ------------------ |
| UP-1 | Sensors don't detect solid shapes; sensor-detection semantics undocumented    | 🔴       | Correctness + docs |
| UP-2 | Install ordering: physics components require the module to be installed first | 🔴       | Docs (by design)   |
| UP-3 | No ray casts                                                                  | 🟠       | New query API      |
| UP-4 | No spatial / overlap / nearest queries                                        | 🟠       | New query API      |

These split into two workstreams.

### Workstream A — correctness fixes (UP-1, UP-2)

Both are bugs/semantic gaps in the existing model, not new surface. They are additive and independently shippable.

- **UP-1 — sensor detectability.** Box2D v3 only reports a sensor overlap when **both** shapes have `enableSensorEvents == true` (confirmed in `box2d/src/sensor.c`: line 67 gates on the visited shape, line 172 on the sensor shape). vecs-physics sets that flag only from the presence of a `SensorEvents` component, so a plain solid shape is invisible to every sensor — the documented "sensor zone detects a solid player" example cannot work. Spacerocks worked around this by making _every_ gameplay entity a sensor (sensor↔sensor works). v2 adds a first-class way to make a solid shape detectable, fixes the docs, and adds parity tests covering sensor↔solid, sensor↔sensor, and filter gating.
- **UP-2 — install ordering.** Investigation (test-first) traced the reported symptom to a hard prerequisite, not a backfill bug: `PhysicsModule` is what _registers_ the physics component classes, so adding `Body`/`Shape` before install throws, and the only way to "pre-create" them is to register the classes yourself first — at which point `Box implements Shape` is declared after the geometry was set, so vecs core never aliases those shapes onto the `Shape` interface and the shape lifecycle system cannot see them. **Resolution (owner decision): documentation, not reconciliation.** Using physics components before installing the module is unsupported by design — like running a program before installing its OS. v2 documents the install-first requirement in `docs/installation.md`, `docs/getting-started.md`, and `docs/systems-and-phases.md`, and corrects the prior "can be installed after a world already exists" wording that implied pre-existing physics entities are wired.

### Workstream B — query API (UP-3, UP-4)

This introduces the **first imperative surface** in vecs-physics: synchronous read-only queries against the live world. Both primitives already exist in box2d3-wasm (`b2World_CastRayClosest`, `b2World_CastRay`, `b2World_OverlapAABB`, `b2World_OverlapShape`, `b2World_CastShape`), so the work is adapter design, not physics.

The hard part is the surface, not the wiring: v1 has been deliberately handle-free and pure-component. Queries must return **Vecs entities**, never `b2ShapeId`s, and must respect `CollisionFilter`, destroyed-entity safety, and Emscripten cleanup discipline.

- **UP-3 — ray casts.** `rayCastClosest` and `rayCastAll`, returning `{ entity, point, normal, fraction }`. Use cases: line-of-sight, bullet traces, mouse picking, ground checks.
- **UP-4 — spatial queries.** `overlapAABB` and a shape-overlap helper (`queryCircle`/`overlapShape`), returning shape entities. Use cases: area triggers, proximity/nearest selection, spawn validation.

A single `physics(world)` accessor returns the query facade for both. See `PLAN-v2.md` for the exact API and the entity-resolution / disposal mechanics.

## Out of scope for v2

Held deliberately so v2 stays a tight, adopter-driven release:

- **Joints, shape casts as public API, character movers, debug drawing, multithreading.** Still deferred (see `docs/roadmap.md`). Shape casting (`b2World_CastShape`) may ship as an internal primitive behind `overlapShape` but is not a committed public surface in v2.
- **The other MIGRATION-REPORT gaps belong to other packages, not vecs-physics:**
  - UP-5 (parent-relative render transforms), UP-6 (particle/effect primitive), UP-8 (anchored UI / Text origin), UP-9 (sprites) → **vecs-phaser / vecs-phaser-client**.
  - UP-7 (`.each`/`.update`-injected components don't auto-flag `modified`) → **vecs core**.
- **UP-10 — fixed-step accumulator helper (🟡).** A genuine ergonomic gap (every adopter hand-rolls the real-time→fixed-step loop) but not part of the required four. Candidate for a v2.x follow-up or a vecs-core driver; tracked, not committed.
- **v1 closeout carries** (open-chain ghost-vertex fidelity at sharp endpoints; runtime solid↔sensor toggle without recreate; sensor TOI hits; CoM-shift velocity adjustment). The runtime sensor toggle overlaps UP-1 work and may be revisited there; the rest stay deferred unless a use case appears.

## Milestone plan — M8 (v2)

One milestone, `M8`. Ticket detail and dependency graph are in `PLAN-v2.md`; the shape:

```
        M8-1 (UP-1 sensor detectability)   ── independent
        M8-2 (UP-2 late-install backfill)  ── independent
        M8-3 (query foundation)            ── independent
              │
        ┌─────┴─────┐
      M8-4 (UP-3   M8-5 (UP-4
      ray casts)   overlap queries)
        └─────┬─────┘
        M8-6 (docs / examples / CHANGELOG / version)  ── last
```

- **M8-1, M8-2, M8-3** are independent leaves; any order, parallelizable.
- **M8-4, M8-5** both depend on the M8-3 query foundation (the `physics(world)` accessor, entity resolution, filter mapping, disposal helpers); parallel to each other.
- **M8-6** is the closeout: docs sweep, new runnable examples (raycast, overlap, sensor-detectable), README, `docs/roadmap.md` update, CHANGELOG, version bump.

**Versioning.** Every change is additive and backward-compatible (a new `Detectable` component, a new `physics(world)` accessor, a corrected install path). Under strict semver this is a minor bump, but the work is the "v2" feature milestone; recommendation is to release it as **`2.0.0`** to mark the milestone while keeping the v1 component contract intact. Final call is recorded in `PLAN-v2.md`.

## Beyond v2

Order is indicative, demand-driven:

1. **Fixed-step driver** (UP-10) — small, high-leverage; likely v2.x.
2. **Joints** — the next big surface; needs a second cross-entity relationship model (`JointBodies` + per-type joint components). Largest design effort.
3. **Shape casts** (public) and **character movers** — build on the v2 query foundation.
4. **Debug draw bridge** — geometry callbacks to a caller-owned renderer.
5. **World teardown / serialization** — explicit `b2DestroyWorld` + pool free; rebuild-from-components load path.
