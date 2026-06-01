# vecs-physics — Milestone 6 (Closing) Plan → v1.0.0

Closing milestone. Anchored on `PLAN.md` → _Milestone 6 — Hardening and docs_,
which names three deliverables (VP-27 doc audit + the two _granularity-gaps_
items: `SOLVER.md` and a fuzz pass), and extended with the release-engineering
items v1.0.0 actually needs (README, CHANGELOG, version, examples, API freeze).

**Decisions baked in** (from the iteration round; previously §5): MIT license;
ship v1 to start finding bugs, no new v2 carries beyond the four already
recorded; `tests/fuzz/` (in the vitest gate, not a separate run); SOLVER.md as
a lightweight map (not a deep dive); perf baseline as informational, not a
regression gate; README at package root only. Two additional asks folded in
(see §3): a Box2D test-suite parity sweep (the gap surfaced after the first
draft) and a vecs-physics integration into the monorepo server demo.

**Iron rule for M6: no new engine behaviour.** Every ticket is hardening, docs,
surface freeze, or release mechanics. A change that moves simulation output is a
parity bug — file it as a `fix:` commit against the milestone that introduced
the divergence, not M6 scope. The one principled exception: behaviour changes
unmasked by VP-28's missing box2d-test ports get fixed under the affected
milestone, not M6.

---

## 1. Status verification (what I checked, not just what PROGRESS.md claims)

The handoff asked to verify forward of M5. Done:

**Confirmed:**

- **Gate green.** `npm run test` from `lib/vecs-physics/` → **668 tests across
  55 files**, clean. (`PROGRESS.md` reports 652 at M5 close; the delta is the
  post-M5 review fixes — see below.)
- **M5 landed.** `git log` shows VP-23 (sleep + island split), VP-24 (CCD), VP-25
  (debug validation, 45 tests), VP-26 (fat-AABB hysteresis fix, scratch hoisting,
  `shapeIndex` cache, bench harness). All ticketed and committed.
- **Post-M5 review pass landed** (7 commits since `da5a24f` _docs: VP-26_):
  `09f3e11` CCD no-tunnel bounds, `bce96dc` sensor-mass parity + debug re-arm,
  `d3ef33a` finalize CCD-flag propagation, `7b3c8cb` `linkContact` parity (drop
  spurious merge), `4c4af8d` wake-trigger coverage, `4f929c2` `transferBody`
  CCD-flag clear, `4e8b19b` collide import cleanup, `6e857a9` + `1038598` review
  reports + their fixes. `architecture/issues/` is empty.
- **`PROGRESS.md` M5 section is at the M1–M4 standard** — VP-23/24/25/26 each
  carry per-file box2d line maps, decisions/deviations, and deferrals. No
  condensed placeholders.

**Public-surface state today (verified by reading the file):**

- `src/index.ts` is **clean** — only re-exports of public components +
  `installPhysics`. No engine internals leak; no stale cruft. (The earlier
  closeout draft claimed a `PhysicsRoot` export and a cruft comment; both are
  absent in the file today.)

**Gaps the verification surfaced (these drive the M6 ticket list):**

1. **Box2D test-suite parity has real holes.** Surveyed `box2d/test/test_*.c`
   against our `tests/`:
   - ✅ Ported (or N/A-by-design): `MathTest`, `AABBTest`, all of
     `SegmentDistanceTest`/`ShapeDistanceTest`/`TimeOfImpactTest`, all 9
     `test_dynamic_tree.c` cases, `ShapeMassTest`/`ShapeAABBTest`/
     `PointInShapeTest`, `HelloWorld`, `TestSensor`, `DeferredMassFlagSyncTest`,
     `EnableSleepFlagSyncTest`, `SetBulletDriftTest`. `RayCastShapeTest`/
     `ShapeCastTest`/threading/container/hash-set tests are intentionally
     out-of-scope per PLAN _Non-Goals_.
   - ⚠️ Partial: `ChainSegmentShapeTest` (physical one-sided property ✅;
     C-API shape-type mutation ❌ — recorded at M4 closeout).
   - 🔴 Missing and worth porting: **`CrossPlatformTest`** (PLAN-named
     determinism oracle; v1-equivalent = same scene snapshotted twice,
     byte-equal); **`EmptyWorld`**; **`DestroyAllBodiesWorld`**;
     **`EnableContactRecyclingTest`**; **`AABBRayCastTest`** (primitive used
     by CCD). → _(Drives VP-28.)_
2. **No `README.md`, no `CHANGELOG.md`, no `examples/`** at the package root.
   `docs/index.md` exists and is the de-facto landing page, but the canonical
   GitHub/npm entry point doesn't exist.
3. **`package.json`:** `version: "0.0.0"`, `private: true`, `license:
"UNLICENSED"`. **Settled:** v1.0.0 with `license: "MIT"`; `private` flag
   decision lives with VP-34's publish call.
4. **Docs partially cover M5 features but unevenly.** Spot check:
   - `docs/bodies.md` documents `Sleep` and `bullet`.
   - `docs/components.md` documents `Sleep`, `bullet`, `allowFastRotation`.
   - `docs/getting-started.md` mentions `debug: false`.
   - But: `docs/events.md`, `docs/systems-and-phases.md`, `docs/internals.md`,
     `docs/kinematic-motion.md`, `docs/shapes.md` make zero mention of any of
     sleep / bullet / continuous / debug. Coverage is inconsistent, and no
     mechanical check pins doc defaults to code defaults — so M5 features could
     have landed with stale prose anywhere outside the three spot-checked pages.
5. **`architecture/SOLVER.md` does not exist.** PLAN.md → _granularity gaps_
   explicitly lists it as an M6 deliverable.
6. **No fuzz harness.** PLAN.md → _Milestone 6_ promises "one round of fuzz
   testing: random scene generation, no NaN, no infinite loops." Not present.
7. **`bench/` has only 2 scenarios** (`stacking`, `falling_balls`) and no
   committed baseline artefact (numbers live only in `PROGRESS.md`).
   `bench/BASELINE.md` does not exist.
8. **No public-export snapshot test.** Today the surface can drift between
   minor versions without a test catching it.
9. **Carried-forward items at M5 close — already decided, but worth re-stating
   in v1 docs:** the `roadmap.md` page predates the M5 closeout and does not
   list the four v2 carries: open-chain ghost-vertex fidelity at sharp
   endpoints, dynamic `Sensor` marker toggle, CoM-shift velocity adjustment,
   sensor TOI hits queue.
10. **No real-app dogfood.** The monorepo's server demo does not exercise
    vecs-physics. A plug-and-play integration (bouncing/colliding balls) is
    the cheapest first integration test against the public API. → _(Drives
    VP-33.)_

The previous CLOSING_PLAN draft also flagged a `Carried-deferral A/B` resolution
ticket (open-chain ghosts, CoM-shift). **Re-reading the source: both have
already been decided** at M5 close — open-chain ghosts is explicitly deferred
to v2 (in-code comment at `makeChainSegments` is the tracker), and CoM-shift
was assessed in VP-23 and recorded as not needed for v1 (the `v = ω = 0` sleep
state makes the shift identically zero). So no new behavioural decision is
required — only that the v2-carry list lands in `roadmap.md` (M6 docs work),
which is what gap #8 captures.

---

## 2. Definition of "v1.0.0 done" (the M6 exit gate)

M6 is complete when **all** of the following hold:

- [ ] **PLAN.md's anticipated M6 deliverables are done.** Doc audit, mechanical
      docs↔code defaults check, `architecture/SOLVER.md`, fuzz pass.
- [ ] **Box2D test-suite parity sweep done** — the five identified missing
      ports (CrossPlatformTest equivalent, EmptyWorld, DestroyAllBodiesWorld,
      EnableContactRecyclingTest, AABBRayCastTest) all green; intentionally
      out-of-scope cases are recorded in PROGRESS.md.
- [ ] **A user can find their way in.** `README.md` at the package root with
      install, quickstart, links into `docs/`, and a clear v1 limitations list.
- [ ] **Public API is frozen** by an export-snapshot test. `src/index.ts` is
      intentional and matches the docs.
- [ ] **Examples run** against the published public API (a small set,
      copy-pasteable).
- [ ] **Monorepo server demo uses vecs-physics** — bouncing/colliding balls
      via the public API; plug-and-play smoke test of v1.
- [ ] **Perf baseline is a committed artefact** (`bench/BASELINE.md`),
      informational only (no v1 regression gate).
- [ ] **Fuzz pass executed** — `tests/fuzz/` runs in the vitest gate, exercises
      a seeded random-scene harness for N steps with no NaN/Infinity/throw/hang.
- [ ] **Release mechanics done:** `CHANGELOG.md` exists; `package.json` bumped
      to `1.0.0`; `license: "MIT"`; full gate green; `v1.0.0` tagged.
- [ ] **`PROGRESS.md` M6 section** at the M1–M5 standard; milestone signed off.

---

## 3. Ticket breakdown (8 tickets, VP-27 … VP-34)

Same discipline as M1–M5. Each ticket lists **scope**, **files**, and **DoD**.

### VP-27 — Doc audit + docs↔code defaults pin + roadmap refresh

The PLAN's anticipated VP-27 ("every doc page links to a passing test"),
sharpened.

- **Sweep all 13 `docs/*.md`** for post-M5 freshness: every public
  component/option referenced in docs uses the **same defaults the code emits**.
  Pages with known M5-feature gaps (events, systems-and-phases, internals,
  kinematic-motion, shapes) get a targeted pass.
- **Add a mechanical docs↔code defaults check.** Either extend
  `tests/components/defaults.test.ts`, or add a small doc-parser test, that
  reads `docs/components.md`'s defaults table and asserts each row equals the
  value `new C()` actually produces. This is the only durable defence against
  the drift §1 found.
- **Refresh `docs/roadmap.md`** to list the four v2 carries from the M5
  closeout: open-chain ghost-vertex fidelity at sharp endpoints, dynamic
  `Sensor` marker toggle, CoM-shift velocity adjustment (with reasoning),
  sensor TOI hits queue.
- **Respect the prettier rule:** `docs/*.md` is **not** prettier-clean at HEAD;
  do minimal literal edits and keep the hand-aligned tables, per
  `PROGRESS.md` → _Environment_.
- **DoD:** docs↔code defaults test green; every public option referenced in
  prose has the right default; `roadmap.md` v2-carries listed; gate green.

### VP-28 — Box2D test-suite parity sweep

Close the box2d-test debt §1 surfaced. **No new engine behaviour expected** —
if a port reveals a real divergence, that's a `fix:` against the affected
milestone (M1–M5), not new scope here.

- **CrossPlatformTest equivalent** (`tests/parity/cross_platform.test.ts`).
  Run-to-run determinism gate on x64 Linux. We **cannot** literally port box2d's
  Falling Hinges scene (it relies on revolute joints, which v1 excludes), and
  PLAN.md is explicit we don't try to match box2d's C hash; the v1-equivalent
  is: build a representative joint-free complex scene (e.g. the existing
  `bench/scenarios/stacking.bench.ts` 20×10 layout, or similar), step until
  every body sleeps, snapshot every body's `(x, y, rotation, linear/angular
velocity, sleeping)`, run the same setup twice in one process, assert
  byte-equal snapshots. Broader than `tests/engine/collide_order.test.ts`
  (which only pins 3-contact ID order).
- **`EmptyWorld`** (`tests/lifecycle/empty_world.test.ts`). Install + start +
  step + stop with no entities; no allocations or errors.
- **`DestroyAllBodiesWorld`** (`tests/lifecycle/destroy_all_bodies.test.ts`).
  Build N bodies + shapes + contacts, destroy them all in one frame, step,
  assert no dangling proxies / contacts / island remnants.
- **`EnableContactRecyclingTest`** (`tests/lifecycle/enable_contact_recycling.test.ts`).
  Toggle `Body.enabled` across steps and assert no contact leaks. v1 disables
  contact recycling (recycleDistance = 0) but the enable/disable invariant
  still applies.
- **`AABBRayCastTest`** (`tests/math/aabb_raycast.test.ts`). Segment-vs-AABB
  primitive — needed indirectly by CCD; cheap to port from `test_collision.c`.
- **Record N/A cases** in a `tests/parity/README.md` (or PROGRESS.md note):
  `RayCastShapeTest`/`ShapeCastTest`/threading/container/hash-set/`TestIsValid`/
  `TestWorldRecycle`/`TestWorldCoverage`/`TestSetWorkerCount` are intentionally
  not ported, with the PLAN _Non-Goals_ reason for each.
- **DoD:** five new tests green; intentionally-skipped cases catalogued; gate
  green; no engine behaviour changed unless a real bug was unmasked (file
  separately).

### VP-29 — `architecture/SOLVER.md`

The PLAN's anticipated M6 write-up (called out in _granularity gaps_).
Maintainer-facing, not user-facing.

- A single file in `architecture/` describing the solver port end-to-end:
  the eight TGS stages in `engine/solver.ts` and where each came from
  (`contact_solver.c` `_Overflow` variants, `b2MakeSoft` from `core.c`); the
  collide → solve → finalize orchestration in `engine/step.ts`; CCD path
  (`engine/ccd.ts`, `b2TimeOfImpact`); sleep + island split
  (`engine/sleep.ts`, `engine/island.ts`); single-overflow-color collapse vs
  box2d's coloring; the `ContactConstraint` shape; what was intentionally
  deviated and why (link to PLAN _Settled Decisions_).
- **Not a duplicate of PLAN.md.** PLAN is the design; SOLVER.md is the
  implementation map — file-by-file, function-by-function, with box2d source
  references — so a future maintainer can reorient quickly.
- **DoD:** file exists; every solver/CCD/sleep file in `engine/` is covered;
  cross-links to PLAN _Settled Decisions_ and PROGRESS tickets where relevant.

### VP-30 — Fuzz harness

PLAN.md M6 deliverable: "random scene generation, no NaN, no infinite loops."
Minimal but real.

- **`tests/fuzz/`** (in the vitest gate, not a separate `npm run` target) with
  a seeded RNG, a scene generator that constructs N bodies with a mix of
  geometries / materials / filters / sensors / kinematic targets / forces /
  impulses, then runs M steps.
- Per step, assert: no body has non-finite `position` / `rotation` /
  `velocity` / `angularVelocity`; no debug validator throws; gate stays
  green; step time stays within a generous bound (catches infinite loops).
- **Reproducibility:** commit a fixed set of seeds in the test; one CI run
  exercises them all.
- **Scope contract:** the test enforces robustness, **not** correctness — no
  parity-against-box2d assertions, no scene-specific behaviour assertions.
  Bugs found get filed and fixed as `fix:` commits against the affected
  milestone, not as M6 scope.
- **DoD:** harness committed; runs in CI / `npm run test`; seeds exercised;
  no failures.

### VP-31 — Public API freeze (`src/index.ts` snapshot)

- **Audit `src/index.ts`** (already clean per §1; this is the formal pass).
  Confirm every export is intentional and documented.
- **Add an export-snapshot test:** assert the exact set of named exports from
  `@vworlds/vecs-physics`. Surfaces any accidental future addition/removal as a
  test failure.
- **Cross-check against `docs/components.md`:** every documented component
  appears in the snapshot; no exported component is undocumented.
- **DoD:** snapshot test added and green; exports ↔ docs cross-check passes;
  PLAN.md → _Public API Contract_ matches.

### VP-32 — `README.md` + `examples/`

Repo entry point and copy-pasteable demos.

- **`README.md`** (package root): one-paragraph what-it-is; install; a
  HelloWorld quickstart; the v1 known-limitations list (mirrors the v1 scope
  table in `docs/roadmap.md` after VP-27's refresh); links into `docs/`; a
  link to `architecture/PLAN.md` for design.
- **`examples/`** — a minimal set using **only the public API**:
  - `examples/hello_world.ts` — the M3 parity scene as a runnable demo.
  - `examples/sensor_trigger.ts` — a sensor-event opt-in flow (`SensorEvents`).
  - `examples/kinematic_platform.ts` — `KinematicTargetPosition`-driven motion.
  - Optional 4th: `examples/contact_events.ts` (begin/end on a box stack).
- Each example is small (< 80 lines), commented, and runnable via `tsx
examples/<name>.ts` from `lib/vecs-physics/`.
- **DoD:** README in place; examples run from a clean checkout; READ links
  resolve.

### VP-33 — Monorepo server-demo: vecs-physics integration

A real-app smoke test of v1 against the public API. **Goal: plug-and-play
dogfood.** If this is awkward, that's the bug we want to find before tagging.

- Identify the monorepo's server demo (likely `apps/` or `examples/` at repo
  root — locate during the ticket; defer here).
- Wire in vecs-physics via the public API only: `installPhysics(world, ...)`,
  the public component classes. No engine internals.
- Scenario: **bouncing/colliding balls.** N dynamic `Circle` bodies dropped
  into a static-walled box (4 segments), gravity on, restitution tuned to
  visibly bounce. Server-side sim; client renders from `Position`/`Rotation`
  components. Keep it small (< ~200 lines of demo-side code).
- Optional: a sensor zone (`Sensor` + `SensorEvents`) that recolours balls on
  entry, to demonstrate the event surface.
- **DoD:** demo runs locally; balls bounce visibly; no crashes or NaN over a
  long-running session; the integration uses zero engine-internal imports.
- **What this is not:** a perf showcase, a game, or a public marketing demo.
  It's a v1 integration smoke test that doubles as the smallest realistic
  example.

### VP-34 — Release mechanics: baseline, CHANGELOG, version, tag

The "everything else and then ship it" ticket. Last.

- **`bench/BASELINE.md`** — commit current `npm run bench` numbers (the two
  scenarios already exist); add a one-line "machine + node version" header;
  state the v1 perf posture (see §4 open decision).
- **`CHANGELOG.md`** — Keep-a-Changelog style; the `0.0.0 → 1.0.0` entry
  summarises M0–M5 by feature area (bodies / shapes / contacts+solver /
  forces+events+sensors / sleep+CCD+debug+perf) and lists v1 limitations
  mirrored from the README.
- **`package.json`** — bump `0.0.0 → 1.0.0`; set `license: "MIT"`; decide the
  `private` flag (npm-publish call); confirm `main`/`types` paths.
- **Add `LICENSE`** at the package root (standard MIT text, current year,
  copyright holder = repo owner / you).
- **Final gate:** `typecheck` + `test` (incl. fuzz from VP-30 and parity
  sweep from VP-28) + `lint` + `prettier --check` from `lib/vecs-physics/`.
- **Tag `v1.0.0`** (push deferred to your call).
- **`PROGRESS.md` M6 section** at the M1–M5 standard; flip "MILESTONE 6
  COMPLETE ✅". Append a brief v1.0.0 closeout block.
- **DoD:** every bullet above checked; tag created locally.

---

## 4. Dependency graph & execution order

```
VP-27 doc audit ──────┐
VP-28 box2d parity ───┤
VP-29 SOLVER.md ──────┤── (independent leaves; can land in any order)
VP-30 fuzz ───────────┤
VP-31 API freeze ─────┘
                            │
                            ▼
                   VP-32 README + examples       (uses frozen surface from
                            │                     VP-31 + refreshed docs from
                            │                     VP-27)
                            ▼
                   VP-33 server-demo integration (uses public API frozen
                            │                     by VP-31; surfaces real-app
                            │                     friction before tag)
                            ▼
                   VP-34 baseline + CHANGELOG + version + tag (STRICTLY LAST)
```

- VP-27 / VP-28 / VP-29 / VP-30 / VP-31 are independent leaves — disjoint
  files; can land in any order.
- VP-31 (API freeze) **before** VP-32 (README+examples) and VP-33 (demo):
  both consume the frozen surface; the snapshot test is the source of truth.
- VP-27 (doc refresh) **before** VP-32 (README): README links into the
  refreshed docs and copies the limitations list from the refreshed
  `roadmap.md`.
- VP-33 (demo) **before** VP-34 (release): a failed dogfood is the cheapest
  thing to learn from before tagging.
- VP-34 strictly last — it tags.

**Suggested sequence:** VP-27 → VP-31 → VP-28 → VP-29 → VP-30 → VP-32 →
VP-33 → VP-34. (Order between VP-28/29/30 is purely convenience — they
genuinely don't interact.)

---

## 5. Decisions (settled this round)

Recorded for the execution phase. Earlier draft's §5 listed these as open
questions; they are now answered.

1. **Ticket granularity:** keep crisp tickets. 8 in total after the two adds
   (VP-28 box2d parity, VP-33 server demo).
2. **Fuzz harness location:** **`tests/fuzz/`**, runs as part of the vitest
   gate every time. No separate `npm run` target.
3. **`SOLVER.md` depth:** lightweight map ("where the code lives" + box2d
   source pointers). Not a deep-dive. ~300 lines target.
4. **Perf posture:** **informational baseline** — `bench/BASELINE.md` is a
   committed artefact with the dev-machine numbers and an explicit "no v1
   regression gate" statement. Targets can be set in v1.1 against real
   workloads.
5. **License + publish:** **MIT.** `LICENSE` file added in VP-34;
   `package.json` `license: "MIT"`. The npm-publish call (and the `private`
   flag) is a VP-34 decision once everything else is green.
6. **README scope:** **package root only** (`lib/vecs-physics/README.md`).
   Repo-level README is a separate task, out of M6 scope.
7. **v2 carries (roadmap refresh):** the four already identified — open-chain
   ghost-vertex fidelity at sharp endpoints, dynamic `Sensor` marker toggle,
   CoM-shift velocity adjustment, sensor TOI hits queue. No additions.
8. **Goal posture:** ship v1.0.0 and start using it to find bugs. **Do not
   add features in M6.** A behavioural divergence unmasked by VP-28's parity
   sweep is a `fix:` against the affected milestone, not new scope.

---

## 6. Notes

- **PROGRESS.md trim (Haiku-class subagent?):** my recommendation is **do
  nothing now.** PROGRESS.md is a 2116-line _development log_ — its value is
  precisely that it captures load-bearing per-ticket decisions, box2d line
  maps, and deferrals. A Haiku-class summarizer doesn't know which lines are
  load-bearing institutional knowledge worth preserving vs ephemeral
  implementation note; the failure mode is silent loss of caveat detail, and
  almost every line passes the "future maintainer would want this" bar. The
  user-facing condensation is what **`CHANGELOG.md` (VP-34)** is for —
  release-grouped, written from full context, by me. PROGRESS.md then
  naturally retires as the dev-log of M0–M6 once `v1.0.0` is tagged. If a
  targeted trim ever becomes necessary post-v1 (e.g. someone needs to grep a
  M3 caveat through 2k lines of noise), do it then, with a frontier model and
  full context — never pre-release with Haiku.
- **TASK_FOR_YOU — ✅ DONE.** Audited every test file under `tests/`. All 11
  box2d golden-test ports already carry a file-level header reference **and**
  an inside-describe-block reference to the origin (`test_*.c::<TestName>`):
  `math_parity` (MathTest), `engine/geometry` (ShapeAABBTest, PointInShapeTest,
  AABBTest), `engine/distance` (SegmentDistanceTest, ShapeDistanceTest),
  `engine/dynamic_tree` (all 9 cases), `engine/mass` (ShapeMassTest),
  `lifecycle/hello_world` (HelloWorld), `lifecycle/chain_collision`
  (ChainSegmentShapeTest), `lifecycle/mass_flag_sync` (DeferredMassFlagSyncTest),
  `sleep/sleep` (EnableSleepFlagSyncTest), `ccd/ccd` (SetBulletDriftTest +
  TimeOfImpactTest), `events/sensor_begin_end` (TestSensor). Only one cosmetic
  gap fixed: `chain_collision`'s describe title now names
  `ChainSegmentShapeTest` (header already did). 668 tests still green.

---

_Next step: this plan is now the execution contract. We open VP-27._
