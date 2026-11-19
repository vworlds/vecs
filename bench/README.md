# Benchmarks

Headless, deterministic benchmarks that run against the built `dist` output of the vecs packages,
the same JavaScript a consumer installs.

## Dynamic component sets

Run `node --import ./bench/register-dist.mjs bench/any-of.ts` after building. It compares
`anyOf` over N keys with a static `any` for enter, exit and `modified` writes, plus
`[X, anyOf]` against `[X, static-any]` for writes to `X`. The existing diamond
`any(X, all(X, Extra))` measures non-watched refresh costs; pass `diamond` to run only
that case against an older build with `BENCH_VECS_ROOT`. No update callback is installed,
so updates price membership maintenance rather than explicit watch dispatch.
A `modified` nothing observes does not read the instance, so these rows no longer
price the store lookup; `BENCH_WATCH=1` gives every key an update watcher and prices
delivery, including the sparse-store read. Rows of the two modes are not comparable.
`ANYOF_RESULT` reports each round's nanoseconds per write and exact transition counts.
`BENCH_KEYS` (16), `BENCH_WRITES` (200,000), `BENCH_WARMUP_WRITES` (20,000), and
`BENCH_ROUNDS` (5) accept positive integers. Modes alternate order per round; deferred
runs include enqueue and drain in 100-write batches. Setup and inverse operations are
outside timing. Compare base/head diamond runs in alternating processes.

## Changed-only component writes

Run `node --import ./bench/register-dist.mjs bench/assign.ts` after building. It
compares `assign` and `set` on a four-field component, with equal or alternating
different props and instances, one synchronous watcher, and immediate or deferred
execution (100 writes per drain). Candidates are reused to exclude caller allocation.
`ASSIGN_RESULT` reports median nanoseconds per write over five rounds, including
enqueue and drain, and checks exact update counts. `BENCH_WRITES` (1,000,000) and
`BENCH_WARMUP_WRITES` (100,000) must be positive multiples of 100. Pass `set` to
measure an older build without `assign`; alternate base/head with `BENCH_VECS_ROOT`.
Pass `equal` to isolate immediate equal `assign` (props and instance candidates)
for CPU profiling, without changing warmup or measured rounds.

The default run also includes a mixed drain case (`mixed` runs only that case):
each 100-command batch alternates 50 `set` writes to one entity and 50 `assign`
writes to another, using the same component metadata and one watcher. It checks
500,000 updates for equal assigns and 510,000 for differing assigns. Both props
and instances are measured. In addition to total nanoseconds per command,
`drainNsPerWrite` times only `endDefer` (two clock reads per batch); compare
alternating builds to expose mixed-command shape costs.

## Idle systems

Run `node --import ./bench/register-dist.mjs bench/idle-systems.ts` after building.
Three separate worlds measure N reactive-only systems with a resting member, N `each` systems over an
empty query, and N `run` systems without members. `BENCH_SYSTEMS` defaults to 100,
`BENCH_WARMUP_TICKS` to 10,000, and `BENCH_TICKS` to 108,000 (one simulated hour at
30 Hz). All overrides must be positive integers. Timing is uninstrumented whole-frame
cost, including pipeline and flush overhead, divided by N for nanoseconds per system;
it is not an isolated callback-dispatch measurement. `IDLE_RESULT` reports each
kind's frame milliseconds, nanoseconds per system, callback count, and checksum.
The benchmark checks that reactive/empty-query callbacks never fire and `run`
callbacks fire every frame. Compare alternating builds with identical settings.
`bench:release-check` includes timing and deterministic fingerprint rows for all
three kinds.

## Core storage cases

### Which rows judge which change

Iteration and injection are judged by `iterate`, `inject`, `point`, `singleton-get` and
`sparse-inject`; deferred writes by `set` and `watch`; structural churn by `churn` and
`composite`; small worlds by the 300-entity rows; and retained memory by the heap rows
(`heap`, `composite-heap`, `sparse-terms-heap`, `mixed-heap`, `small-components-heap`). Verdicts
come from the perf runner, with base and head built and measured in one job; builder timings are
directional evidence only.

Run `node --import ./bench/register-dist.mjs bench/core-storage.ts` after building. It prices
the core storage epic's cases at 10,000 and 100,000 entities carrying two small components,
with one `CORE_STORAGE_RESULT` line per case and size:

The `inject`, `set`, `watch`, `churn` and `point` cases also run at 300 entities,
with Vel on all 300 or on 40 carriers distributed across the population. Each runs
with the entity id pool starting at 1000 and at 10000 (client-style); pipeline
infrastructure consumes nine ids before the population. Result fields `firstId`
(the pool start) and `carriers` distinguish these rows. Pos is on every entity.
Timings remain per **world entity**, not per carrier. Set `BENCH_SMALL_WORLD=1`
to run only these rows. Defaults are 2000 warmup and 10000 measured ticks; the
ordinary tick and round overrides apply. Churn rotates a tenth of the carriers.

| Case                  | Body                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| iterate               | `each([], ...)`, no injection                                                                                              |
| inject                | `each([Pos, Vel], ...)` writing in place                                                                                   |
| inject-iter           | as `inject`, with the `Iter` cursor: `each({ cursor: Iter, inject: [Pos, Vel] }, ...)` reading `it.src`                    |
| set                   | `each([Pos, Vel], ...)` calling `entity.set(Pos, {...})`, no watcher                                                       |
| watch                 | as `set`, plus a second system with `update({ watch: Pos }, ...)`                                                          |
| reader                | the `watch` scene at 5, 21 and 320 entities, timing only the watcher system through `world.stats`                          |
| churn                 | each tick a rotating tenth of the entities loses `Vel` and the previous tenth gains it back, one `each([Pos, Vel])` system |
| heap                  | bytes per entity retained after building the `watch` world, measured in a fresh process                                    |
| composite             | `churn` with 16 distinct populated composite queries sharing Pos/Vel, each with synchronous enter/exit callbacks           |
| composite-heap        | bytes per entity retained by the `composite` world in a fresh process                                                      |
| sparse-terms-heap     | incremental bytes per query term for 200 ten-member queries in a 100,000-entity world, in a fresh process                  |
| point                 | `entity.get(Vel)` on a precomputed deterministic random permutation, every entity carrying Vel                             |
| singleton-get         | repeated `entity.get(Vel)` on its single carrier in an otherwise large world                                               |
| sparse-inject         | `each([Vel])` over distributed carriers making up 3% of the population; sparse from first insertion                        |
| mixed-heap            | retained bytes per entity with local ids from 10000 and 200 mixed-density component keys, at 100k entities                 |
| small-components-heap | retained world bytes per entity at 300 entities, with 200 registered components populated once each                        |

Each line reports the median, min and max nanoseconds per entity per tick over the rounds
(bytes per entity for `heap`), the tick counts it used, and a checksum of component field sums
and callback counts that the benchmark asserts exactly every round; it only changes when
observable behavior changes. Tick counts are fixed per case and size so both builds measure
equal work, with a warm-up, and the timed loop is one small shared function, so a case is not
bimodal between JIT tiers. `iterate` is sized for today's core; the four write-heavy cases
carry about six times the headroom, so even a 6x faster storage core still measures a
roughly 200 ms region per round, and a full default run takes about two minutes on the
current core. `BENCH_ROUNDS` (5) sets the rounds per case and size; `BENCH_TICKS` and
`BENCH_WARMUP_TICKS` override the tick counts uniformly. Every override must be a positive
integer. The `heap` case spawns one fresh `--expose-gc` child process per round and reports
the `heapUsed` delta across building the world and settling it with three ticks, so no other
case's garbage pollutes the measurement. The `churn` case precomputes its ten membership
windows outside the timed loop, which therefore contains only the `remove`/`add` calls and
the system. Pass a case name to isolate it for `node --cpu-prof`; unknown names fail rather
than producing an empty run. Set `BENCH_VECS_ROOT` to run the same benchmark against another
built checkout. Timings need an idle host; compare base and head in alternating processes,
and the checksums must stay identical. The `composite` case adds 16 distinct
`with(Pos, Vel).without(Absent)` queries to the churn scene, with a different
absent key per query. It checks exact enter/exit callback totals in addition to
the ordinary churn fingerprint. `composite-heap` measures that world's retained
bytes per entity with the same fresh-process method as `heap`.
`sparse-terms-heap` runs only at 100,000 entities. It measures the incremental
post-GC heap after adding 200 unique component keys to the last ten entities and
building one direct component query per key, divided by 200 query-root terms.
The resting world's heap is excluded; component instances, definitions, leaf
indexes, and query scaffolding are included. Each query must contain exactly
those ten high-id entities. The result reports `terms: 200` and bytes per term,
not bytes per entity.
`bench:release-check` includes one timing row (the
median) and one fingerprint row (the checksum) per case and size.

The `reader` rows time the watcher system alone, the way a consumer's per-system timer
does: `world.stats.enableSystems()` brackets its inbox replay, the clearing of that inbox
and its own flush between two clock reads per run. The writer routes the events during
its own flush, outside the sample, so a routing saving cannot hide a replay cost; the
`watch` rows price both together. `entities` is the number of `update` events replayed per
run (5, 21 and 320, with fixed tick counts each), and the figure is nanoseconds per event,
clock reads included: the 5-event row is mostly the fixed cost of a run, the 320-event row
mostly the cost per event. The checksum also asserts one timed run per measured tick. These
rows ignore `BENCH_SMALL_WORLD`.

`mixed-heap` uses ten ubiquitous keys, thirty keys on every 33rd entity, sixty
on every 1000th entity, and one hundred singleton keys. It includes the whole
world, not just the stores. `point` uses the same permutation for every round;
`singleton-get` times the successful lookup, not an absent lookup. Both assert
the sum of successful reads. `sparse-inject` reports nanoseconds per world entity
per tick like the other core rows; multiply by 100/3 for cost per carrier.

Run `node --import ./bench/register-dist.mjs bench/entity-lifecycle.ts` for separate
creation and destruction timings at 10k and 100k entities (or pass `10000` or
`100000` as the positional argument to isolate one size for CPU profiling). For each size, warmup
worlds are controlled by `BENCH_WARMUP_ROUNDS` (20); `BENCH_ROUNDS` defaults to 31
measured rounds. Each round creates two-component entities in
a fresh world, then times destruction without setup. It asserts component counts
before and after.
The longer horizon lets allocation and JIT tiers settle. Compare process medians
back to back; min/max still expose individual GC outliers rather than hiding them.

### Component-store hot paths

Component terms own their stores for instances, carrier iteration and counts;
leaf `has` checks world identity and the entity's component bit instead of the
store representation. Staging and detachment keep that bit in step with the
store, including discarded staged additions after an interrupted teardown.
Sparse attachment uses the bit for presence and one native `Map.set`; sparse
term-container insertion uses one `Set.add`. Both detect new membership from the
size change, avoiding a separate hash probe. Sparse container deletion already
uses native `delete` without a presence probe.
See [storage internals](../lib/vecs/docs/utilities.md#shared-component-storage)
for the teardown membership contract. Sparse instance lookup is a native `Map` read; direct lookup
reads an id position, checks entity identity, then reads the parallel instance.
Direct-mode cursor mechanics duplicate `DenseEntitySet` rather than composing a
second container into that lookup path.

Direct injection resolves a store once. It intentionally does **not** cache its
representation for an entire query/system traversal: injection is not a counted
store iteration, and synchronous callbacks can change density. Every lookup reads
the current representation; no array snapshot or registry lookup is needed.
One-, two- and three-component invokers unroll those store reads; they do not run
the generic per-term resolver loop. Optional components retain removed-instance
and teardown fallbacks. Required system components inferred from direct `with`
conjunctions skip those fallbacks. `Iter` uses the same reused tuple and reports
the visited entity in each direct source slot, written by arity rather than with
`fill` (a builtin call per entity cost about 29 ns; `inject-iter` prices this path). Relationships, fan-out and clocks
retain the generic resolver, as do larger tuples.
Only explicit store carrier traversal pins representation and maintains cursors.
Numeric `entity.get(id)` resolves the term from the world; class-based `get` uses
the resolved metadata's term. Teardown and removed-instance fallbacks run on misses.
Writes and relationship reads that already resolved metadata use that same direct
store path, without looking the term up again by id. Empty entity-cursor injection
selects a callback-only invoker once; it does not enter the component resolver per entity.

The pre-paging store used density 8, matching term membership. Three CPU-2-pinned processes per
candidate, at default horizons, alternated 8/16/32 then 32/16/8 on the builder.
The 100k medians below are ns per world entity per tick (ns/read for singleton).
Checksums matched across candidates. There was no consistent advantage for 16;
32 had two slow sparse-injection processes (5.86–5.88 versus 1.19 in its third).
These are builder timings, not the quiet perf-runner acceptance results.

| Case          | Density 8 | Density 16 | Density 32 |
| ------------- | --------- | ---------- | ---------- |
| sparse-inject | 1.24      | 1.23       | 5.86       |
| singleton-get | 21.96     | 21.68      | 20.67      |
| inject        | 44.91     | 43.96      | 45.13      |
| churn         | 132.40    | 131.69     | 137.45     |

### Rejected paged component-store measurements

The rejected prototype used 256-id plain-number pages and density 16. Sparse per-page
counts make the density denominator independent of the absolute id offset;
see [storage internals](../lib/vecs/docs/utilities.md#shared-component-storage).
Terms still used their previous representation; these measurements cover only the
component-store stage, not the full lookup-path acceptance matrix.

On the builder (Node 24.15.0, Xeon E3-1270 v6), page bits 7/8/9 and plain/Int32
pages were compared in forward/reverse CPU-2-pinned processes, with five rounds
per row. Bits 9 left the server-offset 40-carrier case sparse and its injection
slower (8.70/10.20 ns per world entity versus 7.09/7.27 at bits 8).
Bits 7 had no consistent small-world advantage and noisier large-world results.
Three further alternating processes per page type at bits 8 gave these process
medians (ns per world entity per tick):

| Case / entities | Plain pages | Int32 pages |
| --------------- | ----------: | ----------: |
| inject / 10k    |       48.91 |       50.49 |
| inject / 100k   |       56.90 |       61.54 |
| churn / 10k     |      120.33 |      120.67 |
| churn / 100k    |      144.72 |      147.01 |

Plain pages won the large-world injection comparison; small-world results
were mixed. Density 8/16/32 comparisons on CPU 4 did not separate the singleton
or 3%-density rows consistently. Density 16 makes both 40-carrier offset scenes
direct; density 32 had no consistent small-world benefit. Inspection confirmed
three allocated pages for the server population and two for the client population,
while ten carriers spread across 100k ids stayed sparse. Singletons stay sparse.
A forced-direct singleton experiment measured 22.41 versus 23.14 ns/read at 100k,
with overlapping process ranges; promoting every singleton would also promote the
scattered case, so that policy was not selected.

Paging alone does **not** recover the sparse single-entity write regression.
With no concurrent local benchmark streams, three alternating CPU-2-pinned runs
of `assign.ts equal` at ten million writes (one million warmup) measured:

| Immediate equal assign | f30ad26 | After component storage | Paged store |
| ---------------------- | ------: | ----------------------: | ----------: |
| props                  |   25.70 |                   30.69 |       29.32 |
| instance               |   23.56 |                   27.88 |       27.96 |

All update fingerprints remained zero. The task's stop gate therefore applies
before term paging or invoker specialisation. Local profiling retains the sparse
Map/metadata lookup path; changing direct page geometry cannot remove that work.
The earlier geometry/density sweeps overlapped other CPU-pinned local work and
are directional, not quiet-runner acceptance results.

#### Inlining follow-up

Deoptimisation traces showed no repeated lookup deoptimisation: both base and
paged builds had the same one-off equality-helper feedback bailout when moving
from props to instances. TurboFan traces instead showed budget-sensitive inlining
decisions across the larger shared-store call graph. Individual `assign` bytecode
stayed at 119 bytes, but its nested lookup grew from a 34-byte array-map get to
`_getFromMeta` (40), store get (103), and the miss-only teardown helper (43).
Whether `World.entity`, `getEntity`, or the outer `assign` fitted varied with
compilation order; they were not universally uninlined. Raising the diagnostic
inlining budget from 920 to 2000 admitted more calls but did not by itself recover
the full baseline. Splitting store get did not improve the equal-assign rows and
was discarded.

Keep `World.entity`'s creation/name and missing-reference error branches in cold
helpers instead: its reference-lookup body drops from 186 to 47 bytecode bytes.
This allows it and `getEntity` to inline alongside store lookup under the default
budget, without changing reference validation, creation, deferral or error behavior.
Five further alternating CPU-2-pinned processes per build, with no concurrent
local benchmark streams, gave:

| Row                    | f30ad26 | Paged before cold split | Paged with cold split |
| ---------------------- | ------: | ----------------------: | --------------------: |
| equal assign, props    |   25.61 |                   28.99 |                 25.58 |
| equal assign, instance |   23.80 |                   27.69 |                 24.05 |
| foreach injected       |   70.70 |                   76.20 |                 76.30 |

Assign uses ten million writes and one million warmup writes; foreach uses its
default two million calls. Assign update counts were zero; foreach checksum was
8800000 in every process. The cold split recovers equal assign locally, not the
remaining foreach gap. Subsequent term-paging measurements regressed static any-of
and composite, so paging and page counters were rejected in both containers.
The retained cold split is independent of that storage choice.

### Flat positions with promotion slack

Both containers retain plain-number flat positions, density 8, and a monotone
highest-id bound. At eight or more members the promotion test adds a fixed
1024-slot allowance: `count * 8 + 1024 >= highestId + 1`; otherwise the original
`count * 8 >= highestId + 1` rule applies. This makes low server/replicated ids direct
without per-mutation page bookkeeping; client-local ids starting at 10000 retain
the old density threshold. An idle insertion beyond twice the slack-adjusted
bound demotes in one pass instead of extending the array. The check includes
retained position length, so a later idle insertion also repairs growth deferred
during active traversal. Nonempty removals never demote, and active traversals
never switch representation. Membership-only store lookup checks the
position and entity identity without loading the instance.

The `small-components-heap` scene reports retained world bytes per entity for 300
entities and 200 populated component types (one carrier per type, spread across
the population). Multiply by 300 for total world bytes. This exposes the cost of
direct singleton stores; sparse-term and mixed-world heaps remain separate rows.

Three alternating CPU-2-pinned processes per candidate (reverse middle order,
five internal rounds) compared minimum populations 8 and 16 at slack 1024.
The minimum-8/16 builds both included the same arity-specialised invokers; the
870b208 comparison build did not, so timing differences against it are combined
changes, not solely the population guard. Some rounds overlapped CPU-isolated
checks and diagnostic profiling, not another timed benchmark stream.

| Retained heap, bytes/unit      | 870b208 | Minimum 8 | Minimum 16 |
| ------------------------------ | ------: | --------: | ---------: |
| small-components-heap (entity) | 4060.48 |   4132.85 |    4063.68 |
| sparse-terms-heap (term)       | 6395.88 |   6350.64 |    6370.72 |
| mixed-heap (entity)            | 1437.19 |   1435.46 |    1435.50 |

Keep minimum 8: all heaps stay within 3%, and it avoids a consistent timing loss
on client-local inject/set/watch/churn. Server 40-carrier inject was 4.12/4.18
ns per world entity/tick (minimum 8/16); composite 300-carrier server 453.70/467.44;
client-local inject 300-carrier 34.89/36.14. Individual scenes also favor 16;
there is no claim that 8 wins every row. After the sparse-term scene, both Query
and Identity stores have **zero allocated position slots**, rather than 101209.
The initial unguarded slack sweep remains rejected: all 1024/2048/4096 candidates
retained about 15.5 KB per sparse term because those bootstrap stores grew to
the later high query ids. Hysteretic demotion fixes that shape.

### Destruction scratch allocation

The 100k destroy-only profile (five warmup worlds, ten profiled worlds) identified
the shared teardown entry array as a local allocation candidate: clearing its
length after every entity discarded backing storage before the next push loop.
The retained fix sets the next borrower's exact length, fills by index, and keeps
the cleared tuple references between borrows. Component-instance references are
still cleared after success; partial-world behavior after throwing hooks is unchanged.
An empty query-membership set also needs no redundant clear during destruction.
Mixed-size/empty teardown tests cover shrinking and growing scratch use.

## Relationship edge updates

Run `node --import ./bench/register-dist.mjs bench/edge-coalesce.ts` after building.
It measures 1,000,000 add/remove pairs on one source with one synchronous watcher, after 100,000
warmup pairs: immediate multi-target changes, deferred multi-target changes, and deferred
exclusive replacements. `BENCH_DRAINS` and `BENCH_WARMUP_DRAINS` override those counts.
Each `EDGE_RESULT` reports nanoseconds per pair/drain and update/edge-hook counts; edge hooks
remain per edge even when deferred updates coalesce. Compare five alternating base/head rounds
with identical loads using `BENCH_VECS_ROOT` for the base build.
Pass `immediate`, `deferred` or `exclusive` as the final argument to isolate one mode for
`node --cpu-prof`; omit it to run all three. Unknown modes fail rather than reporting an empty run.

## Deferred edges and pending reads

Run `node --import ./bench/register-dist.mjs bench/pending-edges.ts` after building. Its
`exclusive` and `many` modes price deferred `add(R, target)` per edge for 1,000 sources in one
deferred scope: once with only the enqueue timed, and once including the drain. `exclusive`
retargets an `Exclusive` relationship across 16 cells; `many` adds one fresh edge to a many-target
relationship and removes it outside the timed window. The `read` mode prices one
`hasTarget(R, t, { pending: true })` and one `targets(R, { pending: true })` with the reader's edge
queued first and 0, 100 and 1,000 other commands after it, the worst case for the queue scan.
`PENDING_EDGES_RESULT` reports median nanoseconds per edge or per read after 750 warmup rounds of
3,000 measured rounds; `BENCH_SOURCES`, `BENCH_ROUNDS` and `BENCH_WARMUP_ROUNDS` override them.
Pass `exclusive`, `many` or `read` to run one mode. Compare five alternating base/head rounds using
`BENCH_VECS_ROOT` for the base build.

## Dead-reckoning eligibility

For the physics-backed dead-reckoning eligibility measurement, run
`node --import ./bench/register-dist.mjs bench/dr-motion.ts` after building. It reports
motion-sync, eligibility, pose-out (including pose-write routing), and total-tick microseconds for
2,000 asleep / 50 moving and 100 asleep / 1,600 moving bodies. Set `BENCH_VECS_ROOT` to select a
different built tree; alternate before/after processes and compare round medians. `BENCH_TICKS`
(default 1,200) and `BENCH_WARMUP_TICKS` (default 300) control the horizons. Timings use the world's
system stats, including each system's flush; total-tick time includes routing and instrumentation.
Bodies occupy separate lanes and moving bodies cannot sleep, keeping the population stable. Moving
bodies translate and rotate, exercising both pose writes rather than constant-rotation fast paths.

`node --import ./bench/register-dist.mjs bench/dr-routing.ts` isolates the rejected membership
probe in `Entity._routeModified` (`lib/vecs/src/entity/entity.queries.ts`). Nine alternating rounds
compare no pose watcher with one excluded watcher, with eight unrelated memberships so the routing
path takes the shorter watcher list. No physics, hooks, flushes, callback dispatch or inbox allocation
is included. It reports nanoseconds/write; set `BENCH_WRITES` to override five million calls/round.

`dr-bandwidth.ts` also hashes raw packets and packets re-encoded with logical entity ids in Networked
creation order. Component payloads, snapshot/removal order and packet order remain untouched; packet
lengths delimit the mapped hash. This scene has no entity references inside component payloads.
Mapped hashes let builds with extra server-local registrations prove equivalence despite shifted ECS ids.
Set `BENCH_PACKET_PREFIX` to capture mapped, length-delimited packets as `<prefix>-<mode>.bin`.

## Sector tick

For real dead-reckoned bodies and the enabled keepalive gate cost, run after building:

```bash
node --import ./bench/register-dist.mjs bench/dead-reckoned-keepalive.ts
BENCH_IDLE_KEEPALIVE=1 node --import ./bench/register-dist.mjs bench/dead-reckoned-keepalive.ts
```

The gate defaults off in this separate benchmark. It reports mean tick time and tracker
count for 200 moving bodies, eight clients sharing four view DSLs, with view-region
mutations included. `BENCH_DR_BODIES` and `BENCH_TICKS` override the workload.
The sector benchmark's default workload and fingerprints are unaffected.

`sector-tick.ts` prices the per-tick bookkeeping of a game server that hosts several worlds, modelled
on a Space Rocks sector lattice: one `ServerWorld` per sector, all advanced in lockstep at 30 Hz.
Each sector runs the system mix of the real server, with a plain-JavaScript stand-in for Box2D:

| Workload                    | How the benchmark produces it                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Physics pose sync           | A `run` system steps the stand-in engine, a second `set`s four pose components per moving body, like vecs-physics pose-out.   |
| Pose-in with ignored source | Four `update` systems watch the pose components and `ignoreSource` the physics systems, so most of their events are silenced. |
| Render pose sync            | `update` on a physics component sets the networked render component, like vecs-phaser-server.                                 |
| Reactive systems            | `enter` / `update` / `exit` systems for bodies, asteroid mass, health bars and client sessions, flushed after every system.   |
| `.each` systems             | Ship control, world wrap, lifetimes and per-client view selection.                                                            |
| Relationship retargeting    | An exclusive `InCell` edge per networked entity, retargeted on every grid-cell crossing and cascaded to `DrawBy` children.    |
| Entity churn                | Asteroids split, bullets and explosions spawn and expire, so entities are created and destroyed every few ticks.              |
| Networking                  | 28 networked component types with `ServerWorld` diff recording, and one in-memory client per sector that acks every frame.    |

With the defaults (8 sectors, 200 asteroids each) every sector holds about 280 game entities (asteroids,
ships, health bars, bullets, explosions, grid cells and a client) next to its component, system and
query entities. Across all sectors a tick sees about 55 `InCell` retargets and 9 spawns, and a run
takes about 15 seconds.

### Run

```bash
npm run build
npm run bench:sector
```

`bench:sector` runs `node --import ./bench/register-dist.mjs bench/sector-tick.ts`. Node strips
the TypeScript types itself, and the import hook resolves every `@vworlds/vecs*` import to its
`lib/*/dist` build, so rebuild after every source change. Only `@vworlds/vecs`,
`@vworlds/vecs-wire`, `@vworlds/vecs-protocol` and `@vworlds/vecs-server` are used:

```bash
npm run build -w @vworlds/vecs -w @vworlds/vecs-wire -w @vworlds/vecs-protocol -w @vworlds/vecs-server
```

Tune the workload with environment variables:

| Variable             | Default | Meaning                                           |
| -------------------- | ------- | ------------------------------------------------- |
| `BENCH_WORLDS`       | 8       | Sectors, one `ServerWorld` each                   |
| `BENCH_ASTEROIDS`    | 200     | Target asteroid population per sector             |
| `BENCH_SHIPS`        | 4       | Ships per sector                                  |
| `BENCH_CLIENTS`      | 1       | In-memory clients per sector, each steers a ship  |
| `BENCH_WARMUP_TICKS` | 150     | Ticks run before measuring, to let the JIT settle |
| `BENCH_TICKS`        | 600     | Measured ticks                                    |
| `BENCH_SEED`         | 24301   | Seed for the per-sector PRNGs and client inputs   |

The benchmark prints a summary and a `BENCH_RESULT` JSON line with the tick time statistics (mean,
median, p95, p99, min, max, standard deviation, all in milliseconds per tick of all sectors) and
its fingerprints, in two kinds:

- `stateChecksum`: the final simulation state — entity counts, mass totals, per-client byte counts,
  and the simulated bodies visited in ascending entity id, with each client's sent bytes summed
  instead of chained, so iteration and record order cannot change it;
- `traceBag` and `traceCount`: a commutative hash of every benchmark callback (`enter`, `exit`,
  `update`, `each`, hooks) with the entity it ran for, plus how many fired;
- `orderedChecksum` and `orderedTrace`: the same state and callbacks, but chained in engine body
  order, send order and firing order;
- `bytesSent`: the total bytes `ServerWorld` sent to the clients.

`stateChecksum`, `traceBag`, `traceCount` and `bytesSent` are behavior fingerprints: the run is
deterministic, so they only change when observable behavior changes, and an optimization that
keeps execution order, hook order and reactive delivery the same leaves them unchanged.
`orderedChecksum` and `orderedTrace` are order-sensitive: they also change when the order in which
query members are visited changes — unspecified unless `orderBy` or `cascade` is used — so
`bench/compare.ts` reports a difference as a member-order note, not a behavior mismatch. The
order-independent accumulation runs inside the timed loop and uses integer arithmetic only (two
multiplies, an add and a counter per callback invocation; one add per sent byte).

Before the order-independent fingerprints existed, the ordered ones were printed as `checksum` and
`trace`; `bench/compare.ts` reads both spellings, so comparisons involving older output keep
working.

### Profile

```bash
node --cpu-prof --cpu-prof-dir=.tmp/prof --import ./bench/register-dist.mjs bench/sector-tick.ts
```

Open the `.cpuprofile` in Chrome DevTools (Performance panel) or [speedscope](https://speedscope.app).
`.tmp/` is ignored by git.

### Compare two builds

`compare.ts` runs the benchmark against two built checkouts in alternating order, in a fresh
process per run, and reports each build's mean tick time and the per-round head/base ratio. It also
fails when the two builds disagree on the behavior fingerprints (`stateChecksum`, `traceBag`,
`traceCount`, `bytesSent`); a difference in `orderedChecksum`/`orderedTrace` prints a member-order
note and does not fail the comparison.

```bash
git worktree add --detach .worktrees/base origin/dev
ln -s "$PWD/node_modules" .worktrees/base/node_modules
(cd .worktrees/base && npm run build -w @vworlds/vecs -w @vworlds/vecs-wire -w @vworlds/vecs-protocol -w @vworlds/vecs-server)
npm run build -w @vworlds/vecs -w @vworlds/vecs-wire -w @vworlds/vecs-protocol -w @vworlds/vecs-server
BENCH_ROUNDS=8 node bench/compare.ts .worktrees/base
```

Timings on a shared or virtualized machine are noisy. Compare back to back on an otherwise idle
machine, use several rounds, and read the per-round ratios rather than a single run. An identical
build compared against itself shows the noise floor.

## Real-WASM physics pose-out

`physics-pose-out.ts` measures one physics world with 500, then 2,000 dynamic circle bodies.
They drift and rotate deterministically without contacts, with sleeping disabled. Every body
carries position, rotation and both velocity components. Timing uses the compiled package output:

```bash
npm run build -w @vworlds/vecs -w @vworlds/vecs-physics
node --import ./bench/register-dist.mjs bench/physics-pose-out.ts
```

After creation and 300 warmup ticks, it measures 1,000 ticks at 30 Hz. Override these counts with
`BENCH_WARMUP_TICKS` and `BENCH_TICKS`. Each `POSE_OUT_RESULT` line reports nanoseconds per body
per step for the whole `world.progress` tick (including deferred writes) and for the built
`PhysicsPoseSyncOut` system alone (excluding its subsequent flush). Two clock reads per step
are included in whole-tick timing. The checksum hashes the exact float64 bytes of every body's
final position, rotation and velocities in creation order. Compare several alternating builds
with identical counts; checksum disagreement is a behavior change, while timings have host noise.

## Dead-reckoning bandwidth

```bash
npm run bench:dr-bandwidth
```

Run the full 200-body scene (50 bullets, 50 damped containers, 100 rocks), with one
client at 30 Hz, one second of connection warm-up and 60 measured seconds. The three
modes are streamed, dead reckoned with the default refresh, and dead reckoned without
refresh. `BENCH_RESULT` contains each mode's total bytes and bytes per second. The
transport is in-memory and time is virtual: these are deterministic wire-size metrics,
not elapsed-time measurements. The default correctness suite keeps a 20-body,
10-second assertion that dead reckoning uses less than one tenth of streamed bytes.

Normal and stress tests resolve workspace packages from source and run before any
build. The application Vitest configurations merge their Vite configurations to
preserve those source aliases while excluding stress files. Built `dist` output is
required for the standalone bandwidth and sector benchmarks.

## Check against the previous release

```bash
npm run bench:release-check
```

This extends `compare.ts`: it builds HEAD and the latest reachable release tag
(`git describe --tags --abbrev=0`), runs the same HEAD benchmark programs against both
builds, and removes the temporary release worktree when done. Set `BENCH_BASE_REF` to test a
specific tag or ref instead. Temporary worktrees and JSON/Markdown reports live under ignored
`.tmp/release-check/`; matching lockfiles reuse this checkout's dependencies, otherwise the base
installs its own. Run `npm ci` first.

The check includes sector tick, core storage, idle systems, DR bandwidth, and an optional physics pose-out benchmark
when a matching benchmark file is present. It defaults to three alternating runs per
build; set `BENCH_ROUNDS` to an integer of at least three for more runs. Missing release
package APIs produce “no previous data” for that benchmark; benchmark crashes fail the
command. Each deterministic metric is compared exactly, including repeatability within
each build; all changes are shown, with a warning when bytes increase. For the sector
benchmark, `stateChecksum`, `traceBag` and `traceCount` are compared as behavior
fingerprints, and an `orderedChecksum`/`orderedTrace` difference prints a
`member order changed` note rather than a change; output that predates the
order-independent fingerprints still fills the ordered rows from its `checksum`/`trace`
fields and reports the order-independent ones as unavailable for that side. Timing means warn
only above 10% regression and when the absolute difference exceeds both builds'
run-to-run ranges. Warnings exit zero and become annotations in GitHub Actions.

`comparison.json` contains the release tag, rounds, metric values, deltas, verdicts,
and timing spread. `comparison.md` contains the single comparison table used in the
nightly/manual workflow's job summary. The older explicit two-build comparison above
still enforces identical fingerprints for optimization experiments.

## ECS microbenchmark

`npm run bench:vecs` runs `lib/vecs/tests/ecs.bench.test.ts` from the TypeScript sources: entity
creation and destruction, component unpacking, adding and removing components, system updates,
iteration and observer events. By default the cases run at 0, 1 and each power of two up to
2,097,152 entities (one observer case stops at 32,768), and the script raises Node's heap limit to
32 GB for that. Pick smaller sizes and fewer timed rounds per case with environment variables:

```bash
RUN_VECS_ECS_BENCH_COUNTS=16384,65536 RUN_VECS_ECS_BENCH_ROUNDS=7 npm run bench:vecs
```

The script pins Vitest's default reporter. Vitest 4 switches to a quieter reporter when it detects
an AI agent, and that reporter hides the results the benchmark prints.

Set `RUN_VECS_ECS_BENCH_FILTER=SystemsUpdate` to select the four system-update cases.
Add `RUN_VECS_ECS_BENCH_SYSTEM_STATS=1` to measure those cases with opt-in system timing;
leave it unset for the default plain-loop baseline. Use odd round counts so the XOR checksum
does not cancel identical results.

## Known trade-off: bulk create and destroy

`IterableArrayMap` (`lib/vecs/src/util/array_map.ts`) holds the world's entity table. It keeps its
entries in parallel arrays that grow by `push`. Before, each
entry was its own `[key, value]` array literal. The new layout took about 9% off the sector-tick
benchmark's mean tick, but V8 cannot pretenure it the way it pretenured the per-entry literals.

That shows in one pattern: a fresh process that creates tens of thousands of long-lived entities
in bulk and then destroys them. With 65,536 two-component entities, across four sessions,
creating them was 3–17% slower and destroying them 19–35% slower than with the literal layout.
The gap comes from V8's allocation-site pretenuring, not from extra work. Under
`node --no-allocation-site-pretenuring`, the literal layout slows down (180 → 199 ms to create,
113 → 143 ms to destroy) while the new one stays at 185 ms and 135 ms, so the new layout is then
the faster of the two. Neither the sector-tick benchmark nor the ECS microbenchmark, which create
and destroy entities inside a longer-running process, shows the slowdown.

## Client diff interpolation

Run `node --import ./bench/register-dist.mjs bench/diff-buffer-pull.ts` after building.
It prints microseconds per pull and per snapshot for 100, 500, 1,000, 2,000 and 4,000
snapshots, using one position interpolator, a three-slot buffer and a new frame every
other pull. Each size warms up for 200 pulls and measures 1,000. Frame construction
is outside timing; the consumer's `snapshots` read is included. Set `BENCH_VECS_ROOT`
to another built checkout for back-to-back comparison. Shared-host timings are noisy;
compare the per-snapshot scaling, not an absolute threshold.

## Injected forEach setup

Run `node --import ./bench/register-dist.mjs bench/foreach-inject.ts` after building. It times a
one-entity `Query.forEach` with component injection against the bare callback form and prints
`FOREACH_INJECT` with nanoseconds per call, their ratio and a checksum. The injected form caches
its invoker per callback, so the figure left over is per-entity resolution, not per-call setup.

## Component removal routing

Run `node --expose-gc --import ./bench/register-dist.mjs bench/carrier-index.ts` to
measure add-heavy and add/remove workloads, both with no query and with one direct
component query. `CARRIER_INDEX` reports median nanoseconds per add and per operation
over 100 batches of 10,000 entities after 20 warmup batches. Retained heap is the
post-GC `heapUsed` delta for a separate 10,000-entity scene with eight components per
entity (and, in the queried case, one query per component). Setup, assertions and GC
are outside timing. Pin alternating before/after processes to the same CPU; use
`BENCH_VECS_ROOT` to select saved baseline builds and report host load with results.

Run `node --import ./bench/register-dist.mjs bench/remove-notify.ts` after building. It reports
median nanoseconds per removal for no query, a storage-reading watched predicate, and an exclusive
component swap (including the replacement add). Each scenario warms up for 20 batches and measures
100 batches of 10,000 entities; setup/addition is outside the timed removal loop. Compare identical
before/after runs on an idle host. `REMOVE_NOTIFY` rows include the scenario and batch counts.
Pass `exclusive`, `predicate`, or `no-query` as the final argument to isolate one scenario for
`node --cpu-prof` profiling; unknown scenario names fail rather than producing an empty run.
