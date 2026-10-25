# Benchmarks

Headless, deterministic benchmarks that run against the built `dist` output of the vecs packages,
the same JavaScript a consumer installs.

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
three fingerprints:

- `checksum`: the final simulation state, entity counts, mass totals and network byte counts;
- `trace`: an order-sensitive hash of every benchmark callback (`enter`, `exit`, `update`, `each`,
  hooks) with the entity it ran for;
- `bytesSent`: the total bytes `ServerWorld` sent to the clients, whose content also feeds the
  checksum.

The run is deterministic, so the fingerprints only change when behavior changes. An optimization
that keeps execution order, hook order and reactive delivery the same leaves all three unchanged.

### Profile

```bash
node --cpu-prof --cpu-prof-dir=.tmp/prof --import ./bench/register-dist.mjs bench/sector-tick.ts
```

Open the `.cpuprofile` in Chrome DevTools (Performance panel) or [speedscope](https://speedscope.app).
`.tmp/` is ignored by git.

### Compare two builds

`compare.ts` runs the benchmark against two built checkouts in alternating order, in a fresh
process per run, and reports each build's mean tick time and the per-round head/base ratio. It also
fails when the two builds disagree on any fingerprint.

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

The check includes sector tick, idle systems, DR bandwidth, and an optional physics pose-out benchmark
when a matching benchmark file is present. It defaults to three alternating runs per
build; set `BENCH_ROUNDS` to an integer of at least three for more runs. Missing release
package APIs produce “no previous data” for that benchmark; benchmark crashes fail the
command. Each deterministic metric is compared exactly, including repeatability within
each build; all changes are shown, with a warning when bytes increase. Timing means warn
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

`IterableArrayMap` (`lib/vecs/src/util/array_map.ts`) holds every entity's components and the
world's entity table. It keeps its entries in parallel arrays that grow by `push`. Before, each
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
