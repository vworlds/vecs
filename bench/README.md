# Benchmarks

Headless, deterministic benchmarks that run against the built `dist` output of the vecs packages,
the same JavaScript a consumer installs.

## Sector tick

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
