# Render-clock characterization

Run the deterministic #257/#272 clock measurements against real server physics and client rendering.

From the repository root:

```bash
node lib/vecs-phaser-server/tests/render-clock-matrix.mjs
```

The command prints one `RENDER_CLOCK_RESULT {JSON}` line per scenario and exits nonzero on a test
failure. It starts a fresh Vitest/WASM runtime per `K`: the existing physics test harness does not
release engine worlds, and one process cannot accommodate the entire matrix. The normal `npm test`
run includes a five-second mixed-scene smoke case, repeated to check determinism, a sparse K = 8
drift smoke case, and the minimal `it.fails` reproduction in
`lib/vecs-client/tests/render_clock_defects.test.ts`.

## Method

`render_clock.ts` builds on `ReplicationSim`. The worlds, DR modules, Box2D physics, interpolation,
wire encoder, decoder, and acknowledgements are real. The seeded virtual clock and transport are
test doubles. Default seed: 257. Server: 30 Hz. Renderer: 60 or 59 Hz. Acks: 30 Hz. One-way base
delay: half the scenario's RTT. Jitter adds seeded uniform 0–40 ms delay in each direction to every
packet, allowing reordering; its base RTT is 100 ms, not its mean RTT. Isolated loss drops every
47th downstream send after warmup. Burst loss drops downstream sends in `[3000,3300)` ms of each
five-second cycle. A render pause skips `progress` in `[10000,10000 + pause)` ms, while delivery,
server ticks, and acks continue. The resumed renderer receives the full elapsed delta.

Bodies are isolated dynamic circles with no gravity, damping, or rotation. A DR body drifts at
1 m/s, with baseline refresh disabled. Corrections teleport it 0.2 m every 90 server ticks. The
mixed scene adds a streamed body moving at 1 m/s every tick. Resume starts a resting DR body at tick
120; idle never starts it. These deliberately simple straight-line scenes isolate timing from
collision and integrator error. Position error is measured in meters; angular error is not exercised.

An `ON_STORE` server system records the physics pose for every frame, including frames with no
replicated change. Each actual client `progress` sample uses `ClientWorld.renderFrame`, including
its fraction, to interpolate between those independently recorded poses. No received snapshot
is used as truth. Error is therefore **at rendered time**, not against the server's current pose:
zero error can accompany visibly uneven playback or a long delay. `null` metrics mean no entity
of that kind exists, not zero error.

Thirty-second runs exclude their first two seconds from metrics. Extra rate-mismatch diagnostics
run for 60 s; resume phase diagnostics run for 6 s. Actual scheduling can be 29.8 Hz while the
client is configured for nominal 30 Hz, using the harness-only `serverTickIntervalMs` option.
This is a controlled clock-rate mismatch, not a claim about SpaceRocks' scheduler.

## Selected matrix

For each `K = 1, 2, 3, 4, 8`:

- All five scenes, gate on/off, redundancy unset/2, clean 100 ms RTT, steady 60 Hz.
- Jitter, isolated loss, and burst loss at 100 ms base RTT, all four active/resuming scenes,
  gate on, redundancy unset/2.
- Clean 20/200 ms RTT and 59 Hz rendering for drift, gate on, redundancy unset/2.
- Pauses of 100/500/2000 ms for drift, mixed, and resume, gate on, redundancy unset/2.
- Clean drift with a test-only two-slot refill delay and, separately, 29.8 Hz server scheduling.

For `K = 1`, eight seeded resume phases at both 60/59 Hz, 40 ms RTT, and a two-slot refill
counterfactual for the non-boundary seed-4/59-Hz race. Total: 367 scenarios.

Skipped combinations:

- Faults with gate off for continuously moving scenes: the gate stays open with gate on, so those
  runs have the same policy. Clean on/off controls verify this.
- Faults and pauses in permanently idle gated scenes: there is no post-ack downstream traffic.
  Idle clean controls quantify that case; resume/fault runs exercise recovery.
- Corrections combined with render pauses, and simultaneous jitter/loss/pauses: single-axis
  perturbations identify the mechanisms without confounding them. The mixed/DR pause controls
  exercise compaction and the correction fault controls exercise late baselines.
- Every scene at every RTT/render rate: keepalive-only drift isolates clock sensitivity; the
  16 extra resume phase cases specifically exercise the startup race.

This is a targeted characterization, not an exhaustive fault-combination guarantee.

## Result fields

- `holds`: episodes of render samples whose advancement is within `1e-8` frames of zero while
  virtual server time advances; each includes start time, sample count, elapsed server ticks,
  and whether every held sample is at the accepted-version cap. Subtick holds are retained.
- `rate`: mean per-sample advancement divided by elapsed server ticks, worst absolute deviation
  from 1, and every progression greater than `1.5 + 1e-8` frames per tick. The epsilon avoids
  labeling a mathematically 1.5 rate as a jump through floating-point noise.
- `delay`: current integer server frame minus actual fractional render frame, mean/min/p95/max,
  and last-minus-first drift. The endpoint drift includes server-tick sampling phase; a 0.5-frame
  endpoint difference alone does not prove accumulated clock drift.
- `pose`: sample count and mean/min/p95/max position error for DR and streamed bodies.
- `packetsPerSecond`, `bytesPerSecond`: downstream socket sends before loss, excluding warmup;
  wire payload only, excluding transport and upstream ACK overhead.
- `events`: compactions in `_accept` with time/base/deadline, applied motion baselines with their
  rendered frame, dry-pull count, and `_tServ` reset count. Wrappers observe the production
  buffer exclusively from tests. Compaction timestamps use delivery time, not the last pull.
- `trace`, `compactionTrace`: pulls around the first hold after four seconds and first measured
  compaction, respectively, with pre-pull frame/version/base/deadline/slots and resulting frame.
- `errors`, `disconnects`: must be empty. Every rendered sample must have independent DR truth;
  mixed scenarios must also have streamed truth for every rendered sample. Missing truth is never
  replaced with a received snapshot or silently excluded from the matrix's error measurement.

The `refill: "two-slots"` counterfactual changes **only test instances**, immediately after a dry
pull, from a three-slot delay to two. It tests one #271 direction, not a complete corrected clock
or a proposed solution. It can trade a smaller refill buffer for more cap holds. No ACK or
accepted version is changed, and no production source is patched.

See the measured diagnosis in [Replication](../../../../architecture/REPLICATION.md#render-clock-characterization-257).
