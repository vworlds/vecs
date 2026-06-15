# Changelog

All notable changes to the Vecs suite are documented here. Entries are grouped by
the Git release tags and each bullet is tagged with the owning subproject.

## v1.0.27 (2026-06-14)

- [vecs-physics]: Added `Detectable` so solid shapes can opt into sensor detection, matching Box2D v3's two-sided sensor-event opt-in requirement.
- [vecs-physics]: Added the read-only `physics(world)` query facade with `rayCastClosest`, `rayCastAll`, `overlapAABB`, and `overlapCircle`, returning Vecs entities instead of Box2D handles.
- [vecs-physics]: Documented the install-first requirement for `PhysicsModule` and added examples for ray casts, overlap queries, and sensor-detectable solids.
- [vecs-physics]: Changed `rayCastClosest` to return `undefined` instead of `null` when nothing is hit.
- [vecs-physics]: Replaced per-query Box2D allocations with shared scratch pools and split chain handling from single-shape systems for clearer geometry tiers.
- [vecs]: Added `Entity.parent` getter/setter, renamed relationship target access toward `target(rel)`, and exposed `alive`/`destroyed` entity state helpers.

## v1.0.26 (2026-06-12)

- [vecs-phaser]: Added wire-serializable Phaser render components for transforms, styling, primitive shapes, and text, plus stable protocol arrays for network/renderable component ordering.
- [vecs-phaser-client]: Added `CoordSpace`, `PhaserRenderModule`, local `VGameObject` lifecycle state, per-shape renderers, and rotation-aware interpolation support.
- [vecs-phaser-server]: Added the server-side Phaser module surface, render exclusivity registration, networked render-entity helpers, and physics-pose synchronization.
- [vecs]: Added `Implements` for abstract/interface component aliases and a tag decorator for presence-only wire types.
- [vecs]: Introduced strict update predicates, rejected duplicate `update()` registrations for the same component, and fixed deferred entity creation visibility for numeric lookups.
- [vecs]: Reworked `ArrayMap` into sparse and iterable variants, used them for hot entity/body maps, and documented the utilities.
- [vecs-wire]: Reduced encoder/decoder allocation overhead by reusing codec/DataView state and removed unused nested-type codegen plumbing.
- [vecs-physics]: Introduced the abstract `Shape` component tier, moved Box2D handles onto public body/shape components, and converted lifecycle systems to declarative update predicates.

## v1.0.25 (2026-06-08)

- [repo]: Added a workspace Vitest alias consistency check.
- [repo]: Removed development-only package exports from published manifests.

## v1.0.24 (2026-06-08)

- [vecs-protocol]: Published `@vworlds/vecs-protocol` as a standalone package.

## v1.0.23 (2026-06-08)

- [vecs]: Inlined system installation into module constructors to simplify module setup and reduce installation indirection.

## v1.0.22 (2026-06-08)

- [vecs]: Replaced explicit phase mechanics with pipeline-based system ordering and added `insertPhaseAfter` for direct pipeline spine placement.
- [vecs]: Removed the need for explicit `world.start()`; systems and queries now build on demand, and component registration can happen after startup.
- [vecs]: Added module configuration through `world.module(config)` and tightened module/component metadata registration.
- [vecs-client]: Renamed interpolation internals to `DiffBuffer`, added configurable interpolation, and reduced catch-up allocation overhead.
- [vecs-physics]: Replaced the old physics install path with `PhysicsModule` integration.

## v1.0.21 (2026-06-07)

- [vecs]: Expanded the query DSL with `with`, `without`, variadic requirements, query `changed` tracking, `orderBy`, cascade sorting, and breadth-first relationship traversal.
- [vecs]: Added relationship helpers including `Entity.childOf()`, relationship types, entity lifecycle hooks, `Entity.has`, and the relationships module.
- [vecs]: Improved query and grouped-query correctness around changed flags, ignored sources, mutable sort keys, local component id validation, and module class metadata.
- [vecs]: Improved hot-path performance with numeric `Entity.get` lookup and query/term refactors.
- [vecs-wire]: Fixed empty `Uint8Array` encoding and consolidated world-path protocol ownership.
- [vecs-client]: Rebased clients onto full baselines, rebuilt network entities on reset baselines, and tagged network entities instead of pool scanning.
- [vecs-physics]: Folded post-release fixes into the Box2D-backed adapter, including damping/gravity-scale synchronization, contact-event polling, stale comment cleanup, and chain teardown simplification.

## v1.0.20 (2026-06-03)

- [repo]: Upgraded `dgram-*` dependencies to `1.0.8`.
- [vecs-server]: Removed the old `sendPhase` path after the network timing model moved to interval-driven synchronization.

## v1.0.19 (2026-06-03)

- [vecs-client]: Added interval-driven acknowledgements, reconnect baseline resync, and disconnect grace-period handling.
- [vecs-server]: Aligned server synchronization with the new ack/reconnect flow.

## v1.0.18 (2026-06-02)

- [repo]: Published `@vworlds/vecs-wire` from CI and updated the GitHub Actions runtime.
- [vecs-physics]: Removed physics arena debug output from tests.

## v1.0.17 (2026-06-01)

- [repo]: Added coordinated publishing for the workspace packages.
- [vecs-physics]: Migrated the physics backend from the in-house TypeScript engine to `box2d3-wasm` while preserving the Vecs component API.
- [vecs-physics]: Added WASM-backed body, shape, pose, material/filter, force/impulse, kinematic target, event, sleep, and continuous-collision wiring.
- [vecs-physics]: Added `preloadPhysics()` bootstrap documentation, completed the M7 docs sweep, and removed legacy engine source/tests.
- [vecs-physics]: Improved reverse lookup and debug-warning performance with id-indexed maps and consolidated warning paths.
- [vecs-client]: Fixed idempotent compressed-diff component removal.
- [vecs-wire]: Rejected out-of-range wire integers.
- [vecs]: Added per-pool id reuse waitlists.

## v1.0.16 (2026-05-30)

- [vecs]: Added modules, singleton/world component accessors, constructor-baked network worlds, and built-in module loading.
- [vecs]: Added component/entity identity work, component hooks, entity mixins, and moved component metadata onto entities.
- [vecs]: Added `getMut`, relationship queries, relationship mutation callbacks, downward relationship traversal, identity name lookup, and source-tracking `Iter` cursors.
- [vecs]: Reworked query internals around archetype tables, hierarchical term trees, lowercase DSL operators, compiled predicates, and query-level ignored sources.
- [vecs]: Improved query/entity hot paths with dense table membership, ArrayMap-backed registries, reused injection tuples, delegated unsorted membership, and benchmark coverage.
- [vecs-client]: Added view trackers, view-based server visibility, baseline rebasing, session history storage/diffs, component snapshot caching, and client position interpolation.
- [vecs-server]: Added server view trackers, network entity visibility, history diff pulling, and demo server fixes around frame starts and reconnect behavior.
- [vecs-protocol]: Moved CID/world-path helpers into protocol-oriented code and replaced snapshot `eid + type` encoding with packed component ids.
- [vecs-wire]: Preserved `undefined`/`bigint` values, validated `cid_pack`, and added the first wire README.
- [repo]: Added the ECS benchmark harness and source-loading demo/development package exports.

## v1.0.15 (2026-05-10)

- [repo]: Converted the repository to npm workspaces and moved `@vworlds/vecs` under `lib/vecs`.
- [vecs-wire]: Added the initial wire codec and wire decorators.
- [vecs-client]: Added the first networked Vecs synchronization package surface.
- [vecs-server]: Added the first networked Vecs server package surface and demo integration.
- [repo]: Added networked demo apps and source-level local workspace resolution.

## v1.0.14 (2026-05-08)

- [vecs]: Added entity attachment support and cleaned up related entity API ordering/redundancy.

## v1.0.13 (2026-05-08)

- [vecs]: Optimized `ArrayMap` operations and bitset hot paths after benchmark comparison across sparse, byte-table, number-array, and typed-array variants.
- [vecs]: Removed the component base class and moved entity methods toward component metadata instead of numeric component types.

## v1.0.12 (2026-05-06)

- [vecs]: Added timer tick sources and allowed systems to act as tick sources.
- [vecs]: Added `system.enable()` and `system.disable()`.
- [vecs]: Hardened frame lifecycle behavior with reentrant progress rejection, unnamed timer naming, and timer frame memoization coverage.

## v1.0.11 (2026-05-06)

- [vecs]: Replaced `forEachComponent` with the `components` getter and exported `SystemQuery`.
- [vecs]: Added destroyed-entity mutation guards, destroyed query detachment, query watchlist invariant coverage, and ArrayMap `clear()` size reset fixes.
- [vecs]: Stacked component hook handlers and tightened private/internal naming plus public JSDoc/type output.
- [repo]: Mirrored commit-hook checks in CI with typecheck, format, and lint.

## v1.0.10 (2026-05-05)

- [vecs]: Added scoped `World.defer` and parent-child relationship management with deferred-mode support.
- [vecs]: Improved deferred command handling, enter/exit callback snapshot injection, NOT predicate routing, and read-only entity/query accessors.

## v1.0.9 (2026-05-05)

- [repo]: Added devcontainer Claude configuration.

## v1.0.8 (2026-04-29)

- [repo]: Added Prettier formatting for Markdown files.
- [vecs]: Refactored tests to use the public `entity()` creation method.

## v1.0.7 (2026-04-29)

- [vecs]: Replaced `add` with `set` for component property assignment and made entity mutation helpers chainable.

## v1.0.6 (2026-04-29)

- [vecs]: Marked components modified through `set()` and processed out-of-frame changes before phases/systems run in `progress()`.
- [repo]: Added ESLint and Prettier hooks plus IDE formatting integration.

## v1.0.5 (2026-04-28)

- [vecs]: Added exclusive component support and tests.

## v1.0.4 (2026-04-27)

- [vecs]: Extracted `Query` from `System`, added `Filter` for non-reactive filtering, and improved `Query`/`System` iteration helpers.
- [vecs]: Added `set()` component assignment and `Query.destroy()` / `System.destroy()` guards.
- [vecs]: Renamed `SystemQuery` to `QueryDSL`.

## v1.0.3 (2026-04-27)

- [repo]: Bumped package metadata after the first npm-publish setup; no feature changes were recorded in this release range.

## v1.0.2 (2026-04-27)

- [repo]: Added npm publishing metadata for `@vworlds/vecs`.
- [vecs]: Added `System.onEach`, `System.track()`, public tracked entity access, `world.progress(now, delta)`, `OrderedSet`, and `System.sort()`.
- [vecs]: Added required-component type propagation on systems and documented `sort()`, `track()`, and `System<R>` inference.
- [vecs]: Migrated tests from Jest to Vitest and expanded the core test suite.
- [vecs]: Rewrote README/API docs and added public TSDoc coverage.

## v1.0.0 (2026-05-31)

- [vecs]: Scaffolded the standalone `@vworlds/vecs` package with TypeScript build/test wiring, inline events, entity/component/system foundations, and the first public README/API docs.
- [vecs]: The pre-1.0 package history included the original ECS extraction, phases, system dependency sorting, component hooks, parent/tag handling, network entity tracking, and client/server ECS separation that became the 1.x core line.
- [vecs-client]: The pre-1.0 lineage separated ECS client logic from Phaser, lifted component bitset limits, added system pipelines, and established snapshot/component handling for networked clients.
- [vecs-server]: The pre-1.0 lineage established network module entity tracking, component type ranges, parent/tag handling, and the first server-side ECS synchronization model.
- [vecs-physics]: Released the initial physics package with static, kinematic, and dynamic bodies; pose and velocity components; damping, gravity scale, motion locks, and sleep state.
- [vecs-physics]: Added `Box`, `Circle`, `Capsule`, `Segment`, `Polygon`, and `Chain` shapes with local shape pose, broad phase, narrow phase, mass computation, and one-sided chain collision support.
- [vecs-physics]: Added material, collision filter, sensor, force, torque, impulse, angular impulse, kinematic target, contact event, sensor event, and hit event components.
- [vecs-physics]: Added the TGS soft-step contact solver, contact persistence, island bookkeeping, solver warm starting, CCD support, and optional debug validation.
- [vecs-physics]: Added the benchmark harness, parity tests, fuzz harness, public API snapshot gate, package README, runnable examples, and server-demo integration.
