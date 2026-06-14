# vecs-physics v2 — Execution Plan (Milestone M8)

This is the detailed build plan for v2. It assumes [`ARCHITECTURE.md`](./ARCHITECTURE.md) (current contract) and [`ROADMAP.md`](./ROADMAP.md) (scope rationale). Execution is test-first, one ticket per commit, gated from `lib/vecs-physics/` (`npm run typecheck && npm run test && npm run lint && npx prettier --check`), landing on the `physics` branch — same cadence as v1 / M7.

box2d reference sources live (git-ignored) under `lib/vecs-physics/box2d/` (C, pinned to `3a4f0da8…`) and `lib/vecs-physics/box2d3-wasm/` (WASM build). See `.agent/rules/box2d-references.md` to clone them in a fresh worktree.

---

## 1. Scope

v2 closes the four gaps the first production adopter (spacerocks) hit. Nothing else.

| Ticket | Gap  | What it delivers                                                                 |
| ------ | ---- | -------------------------------------------------------------------------------- |
| M8-1   | UP-1 | `Detectable` component so solid shapes are visible to sensors; sensor-model docs |
| M8-2   | UP-2 | `PhysicsModule` install backfills pre-existing `Body`/`Shape` entities           |
| M8-3   | —    | Query foundation: `physics(world)` accessor, entity resolution, filter, disposal |
| M8-4   | UP-3 | Ray casts: `rayCastClosest`, `rayCastAll`                                        |
| M8-5   | UP-4 | Spatial queries: `overlapAABB`, `overlapCircle`                                  |
| M8-6   | —    | Docs, examples, CHANGELOG, version bump                                          |

Dependency graph:

```
M8-1   M8-2   M8-3          (independent leaves)
               │
        ┌──────┴──────┐
      M8-4           M8-5    (both need M8-3; parallel)
        └──────┬──────┘
             M8-6            (strictly last)
```

Explicitly **not** in v2: joints, public shape casts, character movers, debug draw, multithreading, the vecs-phaser/vecs-core gaps (UP-5..UP-9), and the fixed-step helper (UP-10). See `ROADMAP.md` § _Out of scope_.

---

## 2. Settled design decisions

### 2.1 The imperative query surface

v1 is pure-component by design. v2 needs synchronous, read-only queries against the live world (ray casts, overlaps), which do not fit ECS state. We add **one** narrow imperative entry point, world-scoped, returning Vecs entities and never Box2D handles.

**Accessor.** A free function, symmetric with the internal `getPhysics`:

```ts
export function physics(world: World): PhysicsQueries;
```

- Throws if `PhysicsModule` is not installed on `world` (wraps `getPhysics`, which already throws).
- Returns a stable facade object (constructed once per world, cached on `PhysicsState`) so repeated calls don't re-allocate.
- This is the **only** new non-component export besides the `Detectable` component.

Rejected alternatives: methods on the `PhysicsModule` instance (module instances aren't the natural handle for per-frame queries); methods on `world` (would require Vecs core changes / pollute the core surface); request components (the roadmap already rules these out — queries are reads, not state).

**Facade.**

```ts
export interface QueryFilter {
  categoryBits?: number; // default 0xffffffff — query "sees" every category
  maskBits?: number; // default 0xffffffff
}

export interface RayHit {
  entity: Entity; // the shape entity that was hit
  point: Vec2; // world-space hit point
  normal: Vec2; // world-space surface normal (unit)
  fraction: number; // 0..1 along from→to
}

export interface PhysicsQueries {
  rayCastClosest(query: { from: Vec2; to: Vec2; filter?: QueryFilter }): RayHit | undefined;
  rayCastAll(query: { from: Vec2; to: Vec2; filter?: QueryFilter }): RayHit[];
  overlapAABB(query: { min: Vec2; max: Vec2; filter?: QueryFilter }): Entity[];
  overlapCircle(query: { center: Vec2; radius: number; filter?: QueryFilter }): Entity[];
}
```

- Object-argument form matches the direction already published in `docs/roadmap.md`.
- Overlaps return `Entity[]` (the matched shape entities). Ray casts return `RayHit` records.
- All results are **shape** entities. Callers get the body via `entity.parent` (the shape's `ChildOf` parent).
- `from`/`to` are world points; the Box2D call takes `origin = from`, `translation = to − from`.

### 2.2 Shared mechanics (built in M8-3, used by M8-4/M8-5)

**Entity resolution.** Reuse the existing reverse map: `state.entityByShapeIndex.get(shapeId.index1)` → `EID` → `world.entity(eid)`. If the slot is empty or the entity is destroyed, the hit is dropped silently (same rule as `PhysicsEvents`). Chains have no per-shape entity in this map; v2 queries over chain segments resolve to the chain entity only if its `index1` is registered — document that ray/overlap hits against chain shapes are out of scope for v2 (chains are static-collision geometry, not gameplay query targets) unless trivially supported.

**Filter mapping.** `QueryFilter { categoryBits, maskBits }` → `b2QueryFilter`. Defaults are `0xffffffff`/`0xffffffff` (a query with no filter matches everything). Note the inversion vs a shape's own filter: a shape's default `maskBits` is `0xffffffff` and `categoryBits` is `1`; a _query's_ default `categoryBits` should be `0xffffffff` so it is not itself filtered out. Box2D collision rule between query filter Q and shape filter S: `(Q.category & S.mask) != 0 && (S.category & Q.mask) != 0`.

**box2d3-wasm calls.**

| API              | Binding                                                        | Shape                                                           |
| ---------------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| `rayCastClosest` | `b2World_CastRayClosest(worldId, origin, translation, filter)` | returns `b2RayResult { shapeId, point, normal, fraction, hit }` |
| `rayCastAll`     | `b2World_CastRay(worldId, origin, translation, filter, cb)`    | `cb(result) -> float`; return `1` to keep going, `0` to stop    |
| `overlapAABB`    | `b2World_OverlapAABB(worldId, aabb, filter, cb)`               | `cb({ shapeId }) -> bool`; return `true` to keep going          |
| `overlapCircle`  | `b2World_OverlapShape(worldId, proxy, filter, cb)`             | proxy built from a circle (`b2MakeProxy` of the center, radius) |

The callback variants take an `emscripten::val` JS callback. The collector pattern:

```ts
const hits: RayHit[] = [];
state.box2d.b2World_CastRay(state.worldId, origin, translation, filter, (result) => {
  const entity = resolveShapeEntity(state, world, result.shapeId);
  if (entity) hits.push({ entity, point: { x: result.point.x, y: result.point.y } /* … */ });
  return 1; // continue collecting all hits
});
```

Read scalar fields off the callback `result` **inside** the callback — do not retain `result.point`/`result.normal` (they are transient Emscripten refs). For `rayCastClosest`, the `b2RayResult` is returned directly; copy its fields into a plain `RayHit` and stop.

**Memory discipline.** `origin`, `translation`, `aabb` (`b2AABB`), and the circle `proxy` are Emscripten allocations and must be `.delete()`'d. Wrap every query body in `withAllocated` (or nested `withAllocated`) so the scratch objects free in `finally`, even if the user callback throws. Do not leak per-call `b2Vec2`s — reuse the module-global scratch pool (`scr_b2Vec2`/`scr_b2QueryFilter`/`scr_b2AABB` in `src/adapter/runtime.ts`). Queries allocate inside `src/adapter/` (a new `src/adapter/queries.ts`) so the "only `adapter/` touches box2d3-wasm" boundary holds.

**Wake / sleep.** Queries are read-only and must not wake bodies or mutate the world. `b2World_OverlapAABB` / `CastRay` are pure broad/mid-phase reads; confirm no body is woken (parity test asserts a sleeping body stays asleep after a query).

### 2.3 UP-1 — sensor detectability (`Detectable`)

**Root cause (confirmed in `box2d/src/sensor.c`).** A sensor overlap is reported only when both shapes have `enableSensorEvents == true`: line 172 gates on the sensor shape, line 67 on the visited (other) shape. vecs-physics sets `def.enableSensorEvents` from the presence of a `SensorEvents` component (`shape_lifecycle.ts:336`), so a solid shape with no `SensorEvents` is invisible to every sensor.

**Fix — a new marker component `Detectable`.** Presence on a shape entity forces `enableSensorEvents = true` for that shape without making it a sensor and without implying it receives sensor events itself (sensor events are delivered to the _sensor_ shape, per Box2D).

```ts
/** Marks a (typically solid) shape as detectable by sensor overlaps.
 * Without it, Box2D v3 will not report this shape to overlapping sensors. */
export class Detectable {}
```

Wiring:

- `readShapeOptions`: `enableSensorEvents: entity.get(SensorEvents) !== undefined || entity.get(Detectable) !== undefined`.
- `PhysicsEventOptInSync`: add `Detectable` `onAdd`/`onRemove` hooks calling `b2Shape_EnableSensorEvents(shapeId, …)`, OR-combined with the `SensorEvents` flag so removing one while the other is present does not disable detection. (Track effective state in `PhysicsState`, or recompute from both components on each toggle.)
- Registration: add `Detectable` to the public component list next to `Sensor` (group 5). Regenerate `tests/api/exports.approved.json`. Component-type-id order changing affects only internal archetype ids, not Box2D output, so parity goldens are unaffected.

Rejected alternatives: (a) auto-enable `enableSensorEvents` on every shape — changes Box2D-aligned defaults, adds sensor bookkeeping cost to shapes that never participate; (b) document "add `SensorEvents` to the solid" — works mechanically (it sets the flag) but is unintuitive and implies the solid receives events it never gets.

**Docs/tests.** Fix the `docs/events.md` checkpoint example (sensor zone + `Detectable` solid). Add parity tests (see § 4 M8-1) for sensor↔solid (no `Detectable` → no event; with `Detectable` → event on the sensor), sensor↔sensor, and filter gating.

> This also partially addresses the v1 "runtime solid↔sensor toggle" carry: `Detectable` does not need shape recreation (it's an event-flag toggle), unlike the `Sensor` marker. Full runtime `Sensor` toggling without recreate stays deferred.

### 2.4 UP-2 — late-install backfill

**Symptom (from MIGRATION-REPORT).** Entities with `Body` + child shape created **before** `world.module(PhysicsModule)`: the body integrates (moves) but the child shape never attaches — `SensorEvents`/`ContactEvents` never fire. Entities created after install work.

**Step 1 — investigate (test-first).** Write the failing regression first (mirror spacerocks `startupCollision.test.ts`): create `Body` + child `Box`/`Circle` (+ `SensorEvents`/`Detectable`), then `preloadPhysics` + `world.module(PhysicsModule)`, step, assert the shape collides / fires events. Confirm the exact failure: body created but `Shape._shapeId` undefined. Determine whether Vecs replays pre-existing matches into a newly-registered system's `.enter` inbox, and whether the `{ parent: Body }` `TargetTerm` re-evaluates for shapes whose parent `Body` predates the system.

**Step 2 — fix: explicit install-time reconciliation.** In `registerPhysics`, after systems are registered and `PhysicsState` is attached, run a deterministic backfill pass **in dependency order**:

1. Bodies first: for every entity with `Body` and no `_bodyId`, run the same body-creation path `PhysicsBodyLifecycle.enter` uses.
2. Shapes next: for every entity with `Shape` whose immediate `ChildOf` parent has a `Body`, run the same shape-creation path `PhysicsShapeLifecycle.enter` uses (this also applies event opt-in flags, including `Detectable`).

Route backfill through the **same** creation functions the systems call (extract them if needed) so there is one code path and no behavioural drift. Ensure idempotency: an entity wired by reconciliation must not be double-created when the reactive `.enter` next fires — either consume/clear the pending `.enter` for these entities, or guard creation on "`_bodyId`/`_shapeId` already set → skip." The guard is the simplest and also protects against any future double-trigger.

**Step 3 — debug safety net.** In `debug: true`, after reconciliation, warn (new code `physics-installed-after-entity`, deduped) for any physics-relevant entity that could not be fully wired (e.g. a `Shape` whose parent is not a `Body`). This is a net, not the mechanism — the happy path needs no warning.

**Contract after M8-2.** Pre-install and post-install entities are indistinguishable. Documented in `docs/systems-and-phases.md`. The spacerocks SR-FU-2 follow-up (relax install-before-spawn ordering) becomes valid.

### 2.5 Versioning

All v2 changes are additive and backward-compatible: a new `Detectable` component, a new `physics(world)` accessor + types, and a corrected (strictly more-capable) install path. No existing component, default, or behaviour changes for code that doesn't use the new surface. Strict semver would make this a **minor** bump, but it is the "v2" feature milestone.

**Decision:** release as **`2.0.0`** to mark the milestone, keeping the v1 component contract intact. The `api-snapshot` and `exports.approved.json` regenerate to include `Detectable`, `physics`, and the query types. (If the project prefers strict semver, ship as `1.x` — nothing in the diff forces a major; this is a labelling choice, recorded here so the executor doesn't have to decide.)

---

## 3. New public API surface (added exports)

```ts
// components
export { Detectable } from "./components/material.js";

// queries
export { physics } from "./adapter/queries.js";
export type { PhysicsQueries, QueryFilter, RayHit } from "./adapter/queries.js";
```

Everything in `ARCHITECTURE.md` § _Top-level exports_ stays; this is purely additive. `tests/api/exports.approved.json` gains these entries.

---

## 4. Ticket breakdown

Each ticket: goal, design pointer, files, box2d calls, tests (write first), gate. Independent leaves (M8-1/2/3) can be done in any order or in parallel by different people.

### M8-1 — Sensor detectability (UP-1)

- **Goal.** Solid shapes can be detected by sensors via a `Detectable` marker; sensor model documented and parity-tested.
- **Design.** § 2.3.
- **Files.** `src/components/material.ts` (+`Detectable`), `src/index.ts` (export), `src/module.ts` (register + nothing else), `src/systems/shape_lifecycle.ts` (`readShapeOptions`), `src/systems/event_opt_in_sync.ts` (Detectable hooks), `docs/events.md` + `docs/materials-and-filters.md` (sensor rule + example), `tests/api/exports.approved.json` (regenerate).
- **box2d.** `b2Shape_EnableSensorEvents`; `def.enableSensorEvents` at create.
- **Tests (first).** `tests/events/sensor_detectable.test.ts`: (a) sensor + solid-without-`Detectable` → no `SensorEvents`; (b) sensor + solid-with-`Detectable` → `SensorEvents.begin` on the sensor; (c) `Detectable` added/removed at runtime toggles detection without recreating the shape; (d) `CollisionFilter` still gates a `Detectable` solid. Port box2d sensor-funnel expectations where useful from `box2d3-wasm/demo/samples/categories/events/sensorFunnel.mjs` and `box2d/test`.
- **Gate.** Full suite green; exports snapshot updated.

### M8-2 — Late-install backfill (UP-2)

- **Goal.** `world.module(PhysicsModule)` fully wires entities that already have `Body`/`Shape`.
- **Design.** § 2.4.
- **Files.** `src/module.ts` (reconciliation pass), `src/systems/lifecycle.ts` + `src/systems/shape_lifecycle.ts` (extract reusable create-body / create-shape functions; add `_bodyId`/`_shapeId`-set guards), `src/systems/debug.ts` (+`physics-installed-after-entity` net), `docs/systems-and-phases.md`.
- **Tests (first).** `tests/lifecycle/late_install_backfill.test.ts` mirroring spacerocks `startupCollision`: body+shape (+`SensorEvents`/`Detectable`) created before install → after install + step, shape collides / fires events; identical to an after-install entity. Cover body-first and shape-first creation order; cover a shape whose parent is not a Body (debug warns, no crash). Assert no double-creation (one `b2BodyId`, one `b2ShapeId`).
- **Gate.** Full suite green.

### M8-3 — Query foundation

- **Goal.** `physics(world)` accessor + `PhysicsQueries` facade skeleton + shared resolution/filter/disposal helpers. No query methods implemented yet beyond the plumbing (or implement `rayCastClosest` here as the smoke path — optional).
- **Design.** § 2.1, § 2.2.
- **Files.** new `src/adapter/queries.ts` (`physics`, facade class, `resolveShapeEntity`, `toQueryFilter`, scratch handling), `src/index.ts` (exports), `src/adapter/state.ts` (cache the facade + any query scratch on `PhysicsState`).
- **box2d.** `b2QueryFilter`, `b2AABB`, `b2Vec2`, `b2MakeProxy` available via `state.box2d`.
- **Tests (first).** `tests/api/queries_install.test.ts`: `physics(world)` throws before install; returns a stable object after; filter defaults map correctly; no allocation leak across N calls (sanity via repeated calls + a step).
- **Gate.** Full suite green; exports snapshot updated with `physics`/`PhysicsQueries`/`QueryFilter`/`RayHit`.

### M8-4 — Ray casts (UP-3) — needs M8-3

- **Goal.** `rayCastClosest`, `rayCastAll`.
- **Design.** § 2.1, § 2.2.
- **Files.** `src/adapter/queries.ts`.
- **box2d.** `b2World_CastRayClosest`; `b2World_CastRay` with a JS collector callback returning `1`.
- **Tests (first).** `tests/queries/raycast.test.ts`: closest hit returns nearest shape entity with correct `point`/`normal`/`fraction`; `rayCastAll` returns all crossed shapes; filter excludes non-matching categories; a ray missing everything → `undefined` / `[]`; destroyed-entity hit dropped; sleeping body is not woken by a cast. Cross-check numbers against a `box2d/test` raycast port where one exists.
- **Gate.** Full suite green.

### M8-5 — Spatial queries (UP-4) — needs M8-3

- **Goal.** `overlapAABB`, `overlapCircle`.
- **Design.** § 2.1, § 2.2.
- **Files.** `src/adapter/queries.ts`.
- **box2d.** `b2World_OverlapAABB`; `b2World_OverlapShape` with a circle proxy (`b2MakeProxy`).
- **Tests (first).** `tests/queries/overlap.test.ts`: AABB returns all shape entities whose fat-AABB intersects; circle overlap returns shapes within radius (mid-phase, not just AABB); filter gating; empty region → `[]`; duplicate-free results; destroyed-entity dropped; no body woken. Note Box2D `OverlapAABB` is broad-phase (fat-AABB) — document that it can over-report vs exact shape overlap, and that `overlapCircle` is the precise variant.
- **Gate.** Full suite green.

### M8-6 — Docs, examples, release (strictly last)

- **Goal.** Documentation + examples reflect v2; version bumped.
- **Files.** `docs/roadmap.md` (move ray casts + overlap queries out of "deferred" into "included"; update the `physics.*` examples to the shipped `physics(world)` shape and `Entity[]` overlap returns), `docs/index.md` (deferred list, sensor-detection rule), new `docs/queries.md` (ray casts + overlaps), `docs/events.md` (sensor model + `Detectable`), `README.md`, `CHANGELOG.md` (v2 entry: `Detectable`, queries, backfill fix; note box2d3-wasm pin), `package.json` (version), `examples/raycast.ts`, `examples/overlap_query.ts`, `examples/sensor_detectable.ts` (+ wire into the `examples` npm script), regenerate `scripts/api-snapshot` output.
- **Tests.** `npm run examples` runs all examples to completion; `tests/api/exports.test.ts` green against the regenerated snapshot.
- **Gate.** Full suite + `npm run examples` + `npm run bench` (sanity, no regression expectation) green.

---

## 5. Tests & parity

- **Test-first per ticket** (above). Watch each new test fail, implement, go green.
- **Regression anchors from the adopter.** The spacerocks probes encode the exact behaviour that bit production; mirror them here so vecs-physics owns the guarantee: `startupCollision` → M8-2; the sensor/contact `probe.test.ts` matrix (sensor↔solid, sensor↔sensor, filter gating) → M8-1.
- **box2d golden ports.** Where box2d's own test suite (`box2d/test/`) or the wasm demo samples cover a query/sensor case, port the expected numbers and pin them to `box2d3-wasm@5.2.0` with a comment, same convention as v1 parity goldens.
- **Determinism.** Queries are read-only; add an assertion that a query between steps does not perturb `tests/parity/cross_platform.test.ts` (run a query mid-sequence, expect identical hash). No re-baseline needed unless the box2d3-wasm pin changes.
- **Fuzz.** Optionally extend `tests/fuzz/` to fire random ray/overlap queries each step and assert no throw / no NaN / no entity-resolution crash.

## 6. Docs & examples

Covered by M8-1 (sensor docs) and M8-6 (queries doc, roadmap shuffle, examples). New examples are first-class adoption surface — keep them minimal and runnable under `tsx`, each calling `await preloadPhysics()` first, mirroring the existing four.

## 7. Risks

1. **Emscripten leaks in the hot query path.** Every `b2Vec2`/`b2AABB`/proxy per call must free. Mitigation: all query allocation funnels through `withAllocated` (or a pooled scratch set on `PhysicsState`) in `src/adapter/queries.ts`; a repeated-call leak sanity test in M8-3.
2. **Callback re-entrancy / safety.** The box2d3-wasm collector callback runs synchronously inside the C call. Keep callbacks pure (collect only); never mutate the world, create/destroy entities, or call back into physics from inside a query callback. Document it.
3. **Backfill double-creation (UP-2).** If Vecs _does_ replay pre-existing entities into the new system's `.enter` after an explicit reconciliation pass, naïve code creates two bodies/shapes. Mitigation: idempotent guards on `_bodyId`/`_shapeId`; the M8-2 test asserts exactly one of each. Resolve the "does Vecs replay?" question in M8-2 step 1 before writing the fix.
4. **Component-id order churn from `Detectable`.** Adding a component shifts internal type ids. Parity goldens are WASM-output-determined (unaffected); only `exports.approved.json` regenerates. Confirm no test hashes component type ids.
5. **Chain query targets.** Chains lack a per-segment entity in `entityByShapeIndex`. v2 documents ray/overlap against chain shapes as unsupported (resolves to nothing) rather than shipping a half-feature; revisit if a use case appears.
6. **`overlapAABB` over-reporting.** It is broad-phase (fat AABB) and will report shapes whose fat-AABB but not actual shape intersects. Document clearly; offer `overlapCircle` as the precise mid-phase variant.

## 8. Verification checklist (M8 done)

- `cd lib/vecs-physics && npm run typecheck && npm run lint && npm run test` all green.
- New tests present and green: `sensor_detectable`, `late_install_backfill`, `queries_install`, `queries/raycast`, `queries/overlap`.
- `tests/api/exports.test.ts` green with `Detectable`, `physics`, `PhysicsQueries`, `QueryFilter`, `RayHit` in the snapshot.
- `npm run examples` runs `raycast`, `overlap_query`, `sensor_detectable` (plus the original four) to completion under `tsx`.
- `grep -rn "import .*box2d3-wasm" src/` shows imports only under `src/adapter/` (queries included).
- A solid shape with `Detectable` is detected by a sensor (UP-1); a Body+shape created before install collides after install (UP-2); ray/overlap queries return shape entities honoring `CollisionFilter` (UP-3/UP-4).
- `CHANGELOG.md` and `package.json` version updated; `docs/roadmap.md` no longer lists ray casts / overlap queries as deferred.
- Spacerocks can drop its uniform-sensor workaround (SR-FU-1), its install-before-spawn constraint (SR-FU-2), and its hand-rolled `resolveLaserHits`/`findNearest` scans (SR-FU-3/4) against this build.
