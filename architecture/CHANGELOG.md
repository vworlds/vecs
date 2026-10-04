# Changelog

All notable changes to the Vecs suite are documented here. Entries are grouped by
the Git release tags and each bullet is tagged with the owning subproject.

## Unreleased

- [vecs-protocol]: Added `RPCError` so a failed call rejects with a typed `code` and `message` instead of an anonymous object, and added the reserved codes `RPC_TIMEOUT_CODE` (`-1`), `RPC_CLOSED_CODE` (`-2`), and `RPC_UNSPECIFIED_ERROR_CODE` (`1`). `RPCHandler` now takes an optional `TContext` type parameter (defaulting to `void`), and `SessionRPC.abortPending(reason)` rejects every in-flight call so a torn-down channel cannot leave a caller hanging. A handler's code crosses the wire in a `u32` field where `0` means success, so only codes in `[1, 4294967295]` are transmitted as thrown; `0`, negatives, non-integers, and out-of-range codes are sent as `RPC_UNSPECIFIED_ERROR_CODE` so the call still fails instead of resolving or wrapping.
- [vecs-server]: `ServerWorld.handleRpc` now passes a `ServerRPCContext` (`world`, `caller`, `connectionId`) to every registered handler, bound per session so concurrent connections and connections that arrive on later ticks each see their own caller. Registration still replaces earlier handlers and applies to already-connected sessions.
- [vecs-server]: Added `ServerWorld.closeSession(connection, reason?)` for ending one connection by connection id or `NetworkClient` entity, and `NetworkClient.closeReason` for recording why the server hung up. The close is graceful: the session immediately stops accepting input and replicating state, then the next `send()` flushes any RPC replies it still owes — so an `auth` handler can reject with an `RPCError` and close in one call — before completing the teardown. Session teardown runs exactly once for every close path — server-driven, application-driven, peer disconnect, or `disconnectGraceMs` expiry — removing the session, destroying the `NetworkClient` entity, and closing the socket. Frames that arrive after teardown or while a session is closing are dropped.
- [vecs-client]: Added `ClientWorld.dispose()` for one-way teardown. It rejects pending `invoke` calls with `RPC_CLOSED_CODE`, clears buffered RPC and frame state, destroys replicated `Networked` entities, resets the diff buffer, and closes the socket. After disposal `invoke` rejects immediately, `attachSocket` throws, `send` is a no-op, and late frames are ignored. `dispose` is idempotent.
- [vecs-protocol] [vecs-server] [vecs-client]: Added prose guides for RPCs, server sessions, and the client world (`lib/vecs-protocol/docs`, `lib/vecs-server/docs`, `lib/vecs-client/docs`) and linked them from the repository README.
- [vecs]: Added cross-world subtree transfer: `World.snapshotSubtree`, `World.restoreSubtree`, and `World.moveSubtree` move an entity forest between two worlds with fresh entity ids and destination-owned component instances. Capture follows a per-type `OnSnapshot` policy set with `Component.snapshotPolicy` — `ClonePublic` (the default deep copy of plain data), `DontSnapshot` for world-bound resources, or `CustomSnapshot` with owner-supplied `capture`/`materialize`. A capture binds the materializer its policy resolved to, so a later policy change cannot alter how an existing snapshot restores, and a nested value the default cannot copy (anything that is not plain data) fails loudly at capture instead of aliasing across worlds. Restore preflights every captured class against the destination, rebuilds traversal edges before other edges, and destroys everything it created on failure; a failed `moveSubtree` throws `MoveSubtreeError` with the original error as its `cause` and a `restored` map from old source ids to the entities that replaced them. See [Subtree snapshots](./lib/vecs/docs/snapshots.md).
- [vecs-physics]: `PhysicsModule` now declares snapshot policies, so a body/shape/joint subtree moves between two physics worlds without caller-side physics code. `PhysicsEngine`, `ContactEvents`, `SensorEvents`, and `HitEvents` are `DontSnapshot`; `Body`, the single-shape geometries, `Chain`, and the joint types capture their declarative fields and drop every `_`-prefixed Box2D handle, so the destination lifecycle systems allocate fresh handles while the source world's registrations are reaped.
- [vecs]: Relationships now support multiple explicit target edges with private target storage and public `Entity.target`, `Entity.targets`, and `Entity.hasTarget` reads. Add edges with `entity.add(Relationship, target)` and remove one edge with `entity.remove(Relationship, target)`; `Relationship.target`, `{ target }` mutation, and `Entity.ensureTarget` are removed.
- [vecs]: Added the `Exclusive` relationship trait for single-target cardinality and replaced `onRetarget` with per-edge `onTargetAdd` / `onTargetRemove` hooks. `Traversable` and `OwnedTarget` now require `Exclusive`; `OwnedTarget` owns only explicitly added targets and no longer creates an implicit target on add.
- [vecs-protocol] [vecs-server] [vecs-client]: Added generic relationship snapshots encoded as a target count, target EIDs, then the relationship's ordinary payload. Servers serialize every edge and validate `Exclusive` cardinality; clients ghost every missing target and reconcile the complete edge set on each snapshot.
- [vecs-phaser] [vecs-phaser-client] [vecs-phaser-server]: Migrated `DrawIn` and `DrawBy` to explicit target-edge mutation. Both endpoint modules configure each as `Exclusive`, only `DrawBy` is `Traversable`, and client display setup separately keeps the `DrawIn` and `DrawBy` component types mutually exclusive.
- [vecs-physics] [repo]: Migrated joint, display-parenting, spatial-interest, pipeline, and demo relationship call sites from `{ target }` payload assignment to explicit edge addition. Physics joint body relationships and other logically single-target downstream relationships now declare `Exclusive`, and downstream hook users use edge hooks where target identity is required.
- [repo]: Added `bench/sector-tick.ts`, a deterministic headless benchmark of a multi-world game server tick (physics-like pose sync, reactive and `.each` systems, exclusive relationship retargeting, entity churn, and `ServerWorld` diff recording with an in-memory client). It runs against the built `dist` packages (`npm run bench:sector`), fingerprints the final state, callback order and network bytes, and `bench/compare.ts` runs interleaved A/B comparisons between two builds. See [Benchmarks](../bench/README.md).

## v1.0.45 (2026-07-14)

- [vecs]: `OwnedTarget` now creates the target entity when the relationship is added (not just on set/ensureTarget), and wraps existing lifecycle hooks instead of replacing them — ownership behavior runs first so owner hooks and query entry observe an initialized target.
- [vecs]: Replaced stacked lifecycle hooks (`onAdd`, `onSet`, `onRemove`, `onRetarget`) with a single-handler model. Each method now supports get/set/remove calling conventions, eliminating array allocation overhead and simplifying the mental model.

## v1.0.44 (2026-07-14)

- [vecs]: Added `Entity.ensure` for get-or-create mutation of missing components, including deferred-mode routing and validation for destroyed entities, relationships, interface aliases, and duplicate pending creation.
- [vecs]: Added `Entity.ensureTarget` for independently creating or reusing relationship targets, including deferred deduplication and safe handling when targets are destroyed.
- [vecs]: Added the `OwnedTarget` relationship trait, which makes relationship targets children of their source and now destroys displaced targets on retarget and the active target on relationship removal.
- [vecs]: Added the relationship `onRetarget` lifecycle hook, fired after an existing relationship changes to a different target and after reverse indexes reflect the new target.
- [vecs]: Added comprehensive documentation for component traits (`Singleton`, `Implements`, `Traversable`, `OwnedTarget`) and the owned target entity pattern across the docs suite. New `lib/vecs/skills/vecs/SKILL.md` agent skill for vecs application development codifying ECS-first design principles.

## v1.0.43 (2026-07-11)

- [vecs-phaser]: Split display parenting into explicit modes: `DrawIn` remains native Phaser `Container` parenting, and new `DrawBy` (wire type 22) represents computed parenting against a renderable parent. `DrawIn` and `DrawBy` are exclusive, both detach children with `CleanupPolicy.Remove`, and `DrawBy` participates in traversal so cascade queries can reach computed display children.
- [vecs-phaser-client]: Added computed `DrawBy` placement. The client auto-adds a local, non-networked `Position` for `DrawBy` children, resolves it each frame from the parent `Position` plus optional `Offset` (defaulting to zero), and places the child on the scene root instead of inside a `Container`, so parent rotation/container effects do not affect the child. Display setup now keeps `DrawIn` children off-display until their parent `Container` exists and `DrawBy` children off-display until their parent has a real `Position`.
- [vecs-phaser-client]: Guarded transform sync by parenting mode: `phaser.sync.offset` now only handles `DrawIn` children, while `phaser.sync.position` ignores `DrawIn` children to prevent native container children from being double-positioned with world coordinates.
- [repo]: Updated demo spatial-interest cascading to include `DrawBy` display children, and added joint-showcase coverage demonstrating native `DrawIn` parenting alongside computed `DrawBy` parenting.

## v1.0.42 (2026-07-10)

- [vecs-phaser]: Added `Container`, `Offset`, and `DrawIn` render components for parent-relative transform hierarchies. `Container` is a `@tag`-decorated presence component that groups children under a shared transform; `Offset` carries local position relative to the parent in the parent's rotated frame. `DrawIn` is a networked `Relationship` subclass (wire type 19) for display hierarchy — distinct from the server-local `ChildOf` (ownership/lifecycle). `DrawIn` uses `CleanupPolicy.Remove` (detaches children on parent destroy, does not destroy them); `ChildOf` uses `CleanupPolicy.Delete` (cascade-destroys). An entity can carry both: `ChildOf` for lifecycle, `DrawIn` for display. The `InCell` spatial-interest system cascades to `DrawIn` children so child entities remain visible when their parent is in-range.
- [vecs-client]: Resolved relationship snapshots on the client via entity wire type, enabling networked parent-child hierarchies. Replaced pending-link bookkeeping with ghost target entities for cleaner relationship deserialization. Removed the network component pool and renamed `type` to `wireType` throughout the client/server networking layer.
- [vecs-server]: Added entity wire spec for serializing relationships. Registered network components now track `eid` alongside `wireType`.
- [vecs-phaser-client]: Made `Position` interpolation opt-in and installed it via vecs-phaser. Keyed ClientWorld interpolators by component class instead of wire type for cleaner dispatch.
- [vecs]: Fixed tuple inference preservation in `inject` callbacks. Removed unnecessary type casts in `offset_resolve` and inject tuple annotations.

## v1.0.40 (2026-07-08)

- [vecs-physics]: Added the remaining Box2D joint types — `PrismaticJoint`, `WheelJoint`, and `MotorJoint` — completing joint coverage alongside the already-shipped `RevoluteJoint`, `DistanceJoint`, `WeldJoint`, and `FilterJoint`. `PrismaticJoint` locks the bodies' relative angle and slides body B along an axis (body A's local x-axis, rotated by `JointFrame.referenceAngle`); `WheelJoint` is the same slider but leaves relative rotation free. Both reuse the existing `JointMotor`/`JointLimit`/`JointLinearSpring` feature components for their axis motor, translation limit, and suspension/slide spring — no new feature components needed. `MotorJoint` drives body B toward a target pose using a velocity-tracking motor and a positional spring that Box2D always keeps active (no enable flags), so it carries its own fields directly instead of composing with the shared feature components, mirroring how `DistanceJoint` carries `length`. See `docs/joints.md`.
- [vecs-physics]: Added shape casts to the `physics(world)` query facade: `shapeCastClosest` and `shapeCastAll` sweep a `CastGeometry` — the same geometry component classes shape entities use (`Box`, `Circle`, `Capsule`, `Segment`, `Polygon`; `Chain` excluded) — from `from` to `to`, with an optional `rotation` (radians) and the same `QueryFilter` as ray casts and overlaps. Results are `ShapeCastHit`s (shape `entity`, world-space contact `point`, unit `normal`, and `fraction` along the sweep; `fraction: 0` with a zero normal means the cast started overlapping). Hits on destroyed shape entities are silently dropped without masking farther hits. Built on `b2World_CastShape` with a pooled scratch `b2ShapeProxy`, so casts allocate nothing on the Box2D side per call. See `docs/queries.md`.

## v1.0.39 (2026-07-01)

- [vecs-phaser]: Simplified the asset catalog DTO so spritesheet descriptors carry only the stable wire `id`, `kind`, relative `image` path, and Phaser load metadata; author keys and server-built URLs are no longer sent to clients.
- [vecs-phaser-server]: Refactored `AssetManager` to eagerly scan and load all supported asset files at construction time, store them under namespaced internal keys such as `spritesheets/<key>`, and delegate catalog descriptor creation to each concrete `Asset` via `descriptor()`. `TilesetAsset` now owns its own static `load(assetsPath, key)` path, including Tiled parsing and image-path resolution.
- [vecs-phaser-client]: Updated `loadAssets` to assemble spritesheet file URLs from the connection origin, world asset route, and each descriptor's relative `image` path instead of consuming a server-provided URL.

## v1.0.38 (2026-06-30)

- [vecs-physics]: Added joints. A joint is its own entity that references two bodies through the `JointBodyA`/`JointBodyB` relationships (`TargetTerm` fan-out makes creation order-independent), carries exactly one exclusive joint-type component (`RevoluteJoint`, `DistanceJoint`, `WeldJoint`, `FilterJoint`), and uses an optional shared `JointFrame` (`localAnchorA`/`localAnchorB`/`referenceAngle`) for attachment. Behaviour is composed from reusable optional feature components whose presence is the enable flag — `JointMotor`, `JointLimit`, `JointLinearSpring`, `JointAngularSpring` — each owned by its own sync system (modelled on `PhysicsMaterialFilterSync`) that applies in-place Box2D setters and wakes the connected bodies. The `PhysicsJointLifecycle` system creates/destroys the joint via the box2d3-wasm local-frame joint API (anchors written through `def.base.localFrameA.p.Set(...)` so creation allocates nothing beyond the def handle), and `PhysicsReaper` drains a new `pendingJointDestroys` queue guarded by `b2Joint_IsValid`. Destroying a connected body detaches the joint (its constraint is torn down) but leaves the joint entity for the user to manage — joint→body relationships keep the default `CleanupPolicy.Remove`, since destroying a body is not meant to destroy the joint entity. Prismatic/wheel/motor joints and breakable-joint events remain deferred. See `docs/joints.md`.
- [vecs-physics]: Reorganized the package internals around feature-owned folders (`body`, `shapes`, `materials`, `events`, `forces`, `kinematic`, `joints`, `debug`, and `core`) instead of centralized `components/` and `systems/` directories, while preserving the public `preloadPhysics()` plus `world.module(PhysicsModule, opts)` setup path and root exports. `PhysicsModule` now composes internal feature modules in physics run order, systems are declared inline in module `init()` methods, and physics system tagging uses chainable system mutation helpers instead of one-off system variables.
- [repo]: Added a joints showcase to the demo server — a motorized revolute joint spinning a box in place and a distance joint with a soft linear spring suspending a bobbing box — exercising `JointMotor` and `JointLinearSpring` end-to-end through the network/render stack.
- [vecs]: Added chainable `add`/`set`/`remove` forwarding methods on `Query`, and hardened entity cascade teardown with a `World._deletionScope` that buffers incoming-relationship cleanup so iterating `_incoming` no longer skips types swapped in by `IterableArrayMap.delete` mid-iteration (regression-covered across Delete/Remove policies and insertion orders).
- [vecs-client]: Load a standalone `vars.js` before the client bundle so deployments can override `vecsConnectionOptions` (host, port, protocol, worldName, apiBasePath) without rebuilding.
- [repo]: Added multi-stage Docker images for the client (nginx-served Vite build with runtime `vars.js` overrides) and server (esbuild-bundled demo server on production `node_modules`), plus a Docker Compose file wiring HTTP/UDP ports and `VECS_WEBRTC_UDP_HOST` so advertised ICE candidates point at a browser-reachable host instead of the Docker bridge.
- [repo]: Updated `dgram-*` to 1.0.9 and passed the server's advertised UDP host/port through to dgram for reachable WebRTC ICE candidates.
- [repo]: Split the monolithic demo server entrypoint into a `DemoModule` umbrella with feature folders (assets, arena, players, balls, showcases) so `main.ts` owns runtime setup only.
- [repo]: Enabled `eslint-plugin-unused-imports` across library and app sources, and added format coverage for Dockerfiles, shell scripts, and nginx config.

## v1.0.37 (2026-06-25)

- [vecs-phaser]: Added the `Tint` style component to `phaserNetworkComponents` as type 18, an append-only protocol bump. It carries four corner colors (`topLeft`, `topRight`, `bottomLeft`, `bottomRight`, default `0xffffff` = no tint) plus a `monochromatic` flag, with a custom two-mode wire codec: mono mode sends one u32 applied to all corners, poly mode sends four independent u32s. A `value` setter writes all four corners and flips the flag for the common uniform-tint case.
- [vecs-phaser-client]: Added a `Tint` interface marker and shared sync system (`phaser.sync.tint`) that applies all four corners via `setTint(tl, tr, bl, br)`; `Implements` declarations on `Text` and `Image` only — Phaser mixes the Tint component into those plus Sprite, TileSprite, Video, Extern, BitmapText, and Stamp, but not into primitive shapes. Adding `Tint` to a shape entity is a silent no-op.
- [repo]: Demo exercises both wire modes: a random uniform tint per dynamic brick (mono on Image) and a polychromatic-tinted Text decoration with four distinct corner colors (poly).

## v1.0.36 (2026-06-19)

- [vecs-phaser]: Added the `Image` renderable component (`texture` u32, `frame` u16) to `phaserNetworkComponents` as type 17, an append-only protocol bump, plus the data-only asset catalog schema (`AssetDescriptor`, `SpritesheetDescriptor`, `AssetCatalog`) shared by the server and client packages.
- [vecs-phaser-server]: Added `AssetManager` to load Tiled tilesets by author key into typed `TilesetAsset`/`Tile` handles using a vendored minimal Tiled schema with no `@kayahr/tiled` runtime dependency, assign stable append-only wire ids, expose `sizeInMeters(ppm)` for matching physics bodies to art, build the wire catalog via `toCatalog`, and serve catalog JSON plus static files over the existing Express app via `mount`; only single-image tilesets are supported, and image-collection tilesets are rejected.
- [vecs-phaser-client]: Added `loadAssets(scene, conn)` to fetch the catalog, load every spritesheet keyed by resource id, resolve a `Catalog` lookup on loader completion, and surface progress, plus an `Image` renderer that uses id-keyed textures and frames, applies `Size` through `setDisplaySize` when present and native size otherwise, and reuses the shared transform/style sync through a new `Texture` interface marker.
- [vecs-phaser-client]: Simplified the `onRemove` callbacks for all nine renderable components (arc, ellipse, image, line, polygon, rectangle, star, text, triangle) by removing the redundant `entity.has(...)` guard — `entity.remove` is already a no-op when the component is absent.
- [repo]: Updated the demo app to load a Tiled `bricks` tileset end-to-end through `BootScene` → `loadAssets` → render, with dynamic brick physics bodies matched to the art via `sizeInMeters`.

## v1.0.35 (2026-06-17)

- [vecs-physics]: Routed all Box2D teardown through a single `PhysicsReaper`. Lifecycle exits now only do vecs-side bookkeeping and enqueue their handle; the reaper performs every `b2DestroyShape`/`b2DestroyChain`/`b2DestroyBody` at one point (children before parents), after every consumer has run on the still-live handle and before mass-recompute and the step. Because nothing is destroyed mid-pass, a freed shape slot is never recycled within a pass, fixing the shape-id slot-recycling race where a split-spawned child shape (created the same frame its parent body was destroyed) lost its `entityByShapeIndex` entry and became invisible to sensor/contact events. This removes the stale-id/cascade guards (`b2Shape_IsValid`/`b2Chain_IsValid`/`allowCascadeSkip`/`parentBodyStillExists`) from the shape, chain, and event-opt-in systems, since the "clear the slot before Box2D reuses index1" invariant now holds structurally.

## v1.0.34 (2026-06-17)

- [vecs]: Made `update` enter dispatch opt-in via the `onEnter` option (renamed from `enter`), reducing unnecessary enter callbacks for systems that only need update-phase iteration.
- [vecs-server]: Fixed `ViewAll` add/remove tracking with enter/exit to keep the view DSL in sync when views are added or removed mid-frame.
- [vecs-server]: Inserted the snapshot/send phase after `ON_STORE` to prevent viewer blink when an entity crosses cell boundaries.
- [vecs-physics]: Prevented double-creation of chains and shapes when an entity spawns with both body and shape components in the same frame.

## v1.0.32 (2026-06-16)

- [vecs]: Replaced cursor-marker overloads with options objects for inject, query, filter, and system APIs.

## v1.0.31 (2026-06-16)

- [vecs]: Replaced ArrayMap snapshot with positional array for direct inject terms, reducing allocation overhead in the injection hot path.

## v1.0.30 (2026-06-15)

- [vecs]: Snapshot enter injection so an inbox-queued enter survives a same-frame exit, preventing stale enter callbacks from firing with destroyed entities.

## v1.0.29 (2026-06-15)

- [vecs]: Skipped stale system inbox update events after same-frame query exits, preventing destroyed entities or removed `.with` components from dispatching update callbacks with missing injected components.
- [repo]: Bumped vulnerable npm dependencies, including Vitest, Vite, Express, and tsx.

## v1.0.28 (2026-06-15)

- [repo]: Centralized package changelogs and physics roadmap notes under `architecture/`, and added repository metadata to published package manifests.
- [vecs-physics]: Fixed stale recycled Box2D shape ids from mutating sensor/contact event opt-in flags on newly-created shapes, with regression coverage for recycled shape id reuse.
- [vecs-physics]: Documented planned ghost-vertex traversal, per-segment chain materials, and in-place chain material update work.

## v1.0.27 (2026-06-14)

- [vecs-physics]: Added `Detectable` so solid shapes can opt into sensor detection, matching Box2D v3's two-sided sensor-event opt-in requirement.
- [vecs-physics]: Added the read-only `physics(world)` query facade with `rayCastClosest`, `rayCastAll`, `overlapAABB`, and `overlapCircle`, returning Vecs entities instead of Box2D handles.
- [vecs-physics]: Documented the install-first requirement for `PhysicsModule` and added examples for ray casts, overlap queries, and sensor-detectable solids.
- [vecs-physics]: Changed `rayCastClosest` to return `undefined` instead of `null` when nothing is hit.
- [vecs-physics]: Replaced per-query Box2D allocations with shared scratch pools and split chain handling from single-shape systems for clearer geometry tiers.
- [vecs]: Added `Entity.parent` getter/setter, renamed relationship target access toward `target(rel)`, and exposed `alive`/`destroyed` entity state helpers.

## v1.0.26 (2026-06-12)

- [vecs-phaser]: Added wire-serializable Phaser render components for transforms, styling, primitive shapes, and text, plus stable protocol arrays for network/renderable component ordering.
- [vecs-phaser-client]: Added `CoordSpace`, `PhaserRenderModule`, GameObject-as-component lifecycle (live Phaser objects attached to entities via `entity.attach`, dispatched through `Implements` interface markers), per-shape renderers, and rotation-aware interpolation support.
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
