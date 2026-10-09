import { afterEach, describe, expect, it } from "vitest";
import { Server2Client } from "@vworlds/vecs-protocol";
import { Decoder, wireType } from "@vworlds/vecs-wire";
import type { Entity } from "@vworlds/vecs";
import { Networked } from "../src/index.js";
import { symmetric } from "./harness/lossy_link.js";
import { ReplicationSim, type SimClient, type VersionAdvance } from "./harness/replication_sim.js";

// Replication over an unordered, partially reliable link, end to end: a real
// ServerWorld, real ClientWorlds, and simulated links that delay, drop and
// reorder datagrams (see ./harness/replication_sim.ts). Each test names the
// production symptom it pins down.

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

class Health {
  @wireType("i32")
  public hp = 100;
}

/** 200 ms round trip, 5% loss each way, and one datagram in ten overtaken by up to 60 ms. */
const HARSH_LINK = symmetric({ oneWayMs: 100, loss: 0.05, reorder: 0.1, reorderExtraMs: 60 });

/** The server's default `historyFrames`: about two seconds at 30 Hz. */
const WINDOW_FRAMES = 64;

/** Long enough for the last change to be re-sent through the loss and acked. */
const SETTLE_MS = 800;

/** Seed 2 loses the first baseline, which exercises the retry; the others do not. */
const SEEDS = [1, 2, 3, 4];

let sim: ReplicationSim | undefined;

afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

describe("replication over a lossy, high-latency link", () => {
  describe.each(SEEDS)("seed %i", (seed) => {
    it("connects with exactly one baseline and never rebuilds over 60 s at 200 ms round trip, 5% loss and reordering", () => {
      const run = startSim({ seed, entityCount: 40 });
      const client = run.sim.addClient();

      run.sim.run(60_000);
      run.freeze();
      run.sim.run(SETTLE_MS);

      expect(summarize(run.sim, client)).toEqual({
        errors: [],
        disconnects: [],
        resets: 1,
        baselinesDelivered: 1,
        baselinesSentAfterFirstReset: 0,
        enters: 40,
        exits: 0,
        differences: [],
      });
      expect(client.stats.resets[0].initial).toBe(true);
    }, 120_000);

    it("sends an idle view nothing for ten windows, then the change as a regular delta from its old ack", () => {
      const run = startSim({ seed, entityCount: 20, mutation: "none" });
      const client = run.sim.addClient();

      run.sim.run(10 * WINDOW_FRAMES * run.sim.tickMs);
      const ackedFrame = client.stats.resets[0].toFrame;
      expect(client.stats.deltasSent).toEqual([]);

      run.touch(3);
      run.sim.run(2_000);

      expect(summarize(run.sim, client)).toEqual({
        errors: [],
        disconnects: [],
        resets: 1,
        baselinesDelivered: 1,
        baselinesSentAfterFirstReset: 0,
        enters: 20,
        exits: 0,
        differences: [],
      });
      // The first delta starts from the frame the client really acked, which is the baseline
      // and about ten windows back (a lost first baseline moves it a little later).
      const [first] = client.stats.deltasSent;
      expect(first.fromFrame).toBe(ackedFrame);
      expect(first.toFrame - first.fromFrame).toBeGreaterThan(8 * WINDOW_FRAMES);
    }, 120_000);

    it("does not resync a view that changes less often than the window is long", () => {
      const run = startSim({
        seed,
        entityCount: 20,
        mutation: { everyFrames: WINDOW_FRAMES + 3 },
      });
      const client = run.sim.addClient();

      run.sim.run(60_000);
      run.freeze();
      run.sim.run(SETTLE_MS);

      expect(summarize(run.sim, client)).toEqual({
        errors: [],
        disconnects: [],
        resets: 1,
        baselinesDelivered: 1,
        baselinesSentAfterFirstReset: 0,
        enters: 20,
        exits: 0,
        differences: [],
      });
      // About 50 changes, each of which arrived as a delta.
      expect(client.stats.deltasSent.length).toBeGreaterThan(50);
    }, 120_000);
  });

  it("produces exactly one client rebuild on connect at 200 ms round trip", () => {
    const run = startSim({ seed: 1, entityCount: 40, link: symmetric({ oneWayMs: 100 }) });
    const client = run.sim.addClient();

    run.sim.run(10_000);
    run.freeze();
    run.sim.run(SETTLE_MS);

    expect(client.stats.baselinesSent).toHaveLength(1);
    expect(summarize(run.sim, client)).toEqual({
      errors: [],
      disconnects: [],
      resets: 1,
      baselinesDelivered: 1,
      baselinesSentAfterFirstReset: 0,
      enters: 40,
      exits: 0,
      differences: [],
    });
  });

  describe("a stall longer than the history window", () => {
    const STALL_START_MS = 10_000;
    // Longer than the history window, which is about 2.1 s at 30 Hz.
    const STALL_MS = Math.ceil(1.5 * WINDOW_FRAMES * (1000 / 30));

    it("applies one recovery baseline once the link returns, then goes back to deltas", () => {
      const run = startSim({ seed: 3, entityCount: 40 });
      const client = run.sim.addClient();
      run.sim.run(STALL_START_MS);
      expect(client.stats.resets).toHaveLength(1);

      client.setBlocked("both", true);
      run.sim.run(STALL_MS);
      client.setBlocked("both", false);
      const resumedAtMs = run.sim.clock.now;
      run.sim.run(10_000);
      run.freeze();
      run.sim.run(SETTLE_MS);

      // Everything sent during the outage was lost, so exactly one baseline gets
      // through after it, and at most one more was sent because the first one
      // was dropped.
      const recovery = client.stats.resets.filter((reset) => reset.atMs >= resumedAtMs);
      expect(recovery).toHaveLength(1);
      expect(client.baselinesSentSince(resumedAtMs)).toBeLessThanOrEqual(2);
      expect(summarize(run.sim, client)).toMatchObject({
        errors: [],
        disconnects: [],
        resets: 2,
        differences: [],
      });
    }, 120_000);

    it("re-sends a baseline no faster than twice the round trip while only the acks are missing", () => {
      const run = startSim({ seed: 4, entityCount: 40 });
      const client = run.sim.addClient();
      run.sim.run(STALL_START_MS);

      client.setBlocked("up", true);
      run.sim.run(STALL_MS);
      client.setBlocked("up", false);
      const resumedAtMs = run.sim.clock.now;
      run.sim.run(10_000);
      run.freeze();
      run.sim.run(SETTLE_MS);

      // The server cannot tell lost acks from a dead client, so it keeps offering a
      // baseline, but only once the last one has gone unacked for twice the round
      // trip, which the link makes at least 2 x 200 ms: not once per 33 ms frame.
      const sentAt = client.stats.baselinesSent
        .filter((baseline) => baseline.atMs >= STALL_START_MS)
        .map((baseline) => baseline.atMs);
      expect(sentAt.length).toBeGreaterThan(0);
      sentAt.slice(1).forEach((at, index) => {
        expect(at - sentAt[index]).toBeGreaterThanOrEqual(400);
      });
      expect(client.baselinesSentSince(resumedAtMs + 1_000)).toBe(0);
      expect(summarize(run.sim, client)).toMatchObject({
        errors: [],
        disconnects: [],
        differences: [],
      });
    }, 120_000);
  });

  describe("acks that go missing while the view changes on every frame", () => {
    // A 400 ms round trip, so the ack lag is already about 13 of the 64 frames of history, and a
    // link with no loss, so the baseline's own timing is the only variable.
    const SLOW_LINK = symmetric({ oneWayMs: 200 });

    function stallAcksFor(frames: number) {
      const run = startSim({ seed: 5, entityCount: 40, link: SLOW_LINK });
      const client = run.sim.addClient();
      run.sim.run(10_000);
      const stalledAtMs = run.sim.clock.now;

      client.setBlocked("up", true);
      run.sim.run(frames * run.sim.tickMs);
      client.setBlocked("up", false);
      run.sim.run(10_000);
      run.freeze();
      run.sim.run(SETTLE_MS);
      return { client, run, stalledAtMs };
    }

    it("resyncs once when they stop for longer than the window, then goes back to deltas", () => {
      const { client, run, stalledAtMs } = stallAcksFor(WINDOW_FRAMES + 2);

      expect(client.baselinesSentSince(stalledAtMs)).toBe(1);
      expect(summarize(run.sim, client)).toMatchObject({
        errors: [],
        disconnects: [],
        resets: 2,
        baselinesDelivered: 2,
        baselinesSentAfterFirstReset: 1,
        exits: 40,
        differences: [],
      });
    }, 120_000);

    it("does not resync when they are only late by a few frames", () => {
      const { client, run, stalledAtMs } = stallAcksFor(8);

      expect(client.baselinesSentSince(stalledAtMs)).toBe(0);
      expect(summarize(run.sim, client)).toMatchObject({
        errors: [],
        disconnects: [],
        resets: 1,
        exits: 0,
        differences: [],
      });
    }, 120_000);
  });

  describe("datagrams reordered by hundreds of milliseconds", () => {
    // The channel retransmits a lost datagram after a retransmission timeout, so it can arrive
    // hundreds of milliseconds after the ones sent behind it. Once the client has applied those,
    // the straggler is stale, and must not roll the client back and make its next delta, which
    // starts at the frame the server last saw acked, look as if it started past the client.
    const REORDERING = [
      { name: "5% by up to 800 ms", conditions: { reorder: 0.05, reorderExtraMs: 800 } },
      { name: "10% by up to 400 ms", conditions: { reorder: 0.1, reorderExtraMs: 400 } },
      { name: "20% by up to 300 ms", conditions: { reorder: 0.2, reorderExtraMs: 300 } },
    ];

    describe.each(SEEDS.slice(0, 3))("seed %i", (seed) => {
      it.each(REORDERING)(
        "keeps the client connected and converging: $name",
        ({ conditions }) => {
          const run = startSim({
            seed,
            entityCount: 20,
            link: symmetric({ oneWayMs: 100, loss: 0.05, ...conditions }),
          });
          const client = run.sim.addClient();

          run.sim.run(30_000);
          run.freeze();
          run.sim.run(4_000);

          expect(summarize(run.sim, client)).toMatchObject({
            errors: [],
            disconnects: [],
            differences: [],
          });
        },
        120_000
      );
    });
  });

  describe("a round trip longer than the history window", () => {
    it("settles on a quiet view instead of re-sending baselines for ever", () => {
      // 10 frames of history last 333 ms; the 600 ms round trip is nearly twice that. The server
      // has to measure a round trip longer than its window, and wait out each baseline.
      const run = startSim({
        seed: 1,
        entityCount: 10,
        link: symmetric({ oneWayMs: 300 }),
        historyFrames: 10,
      });
      const client = run.sim.addClient();
      run.sim.run(10_000);
      run.freeze();
      const quietAtMs = run.sim.clock.now;

      run.sim.run(15_000);

      expect(client.baselinesSentSince(quietAtMs + 5_000)).toBe(0);
      expect(summarize(run.sim, client)).toMatchObject({
        errors: [],
        disconnects: [],
        differences: [],
      });
    }, 120_000);
  });

  describe("a client that stalls while every entity leaves its view", () => {
    it("holds no entities afterwards: the empty baseline is what clears them", () => {
      const run = startSim({ seed: 6, entityCount: 20, link: symmetric({ oneWayMs: 100 }) });
      const client = run.sim.addClient();
      run.sim.run(5_000);
      expect(client.stats.enters).toBe(20);

      client.setBlocked("both", true);
      run.destroyAll();
      run.sim.run(Math.ceil(1.5 * WINDOW_FRAMES * run.sim.tickMs));
      client.setBlocked("both", false);
      run.sim.run(8_000);

      // Nothing is left to replicate, so the one baseline that got through after the outage
      // (the ones sent during it were lost) was empty, and rebuilding from it is what removed
      // the 20 entities the client still held.
      expect(summarize(run.sim, client)).toMatchObject({
        errors: [],
        disconnects: [],
        resets: 2,
        baselinesDelivered: 2,
        enters: 20,
        exits: 20,
        differences: [],
      });
    }, 120_000);
  });

  describe("a client that joins a busy world mid-stream", () => {
    const EXISTING_CLIENTS = 3;
    const JOIN_AT_MS = 5_000;

    it("applies exactly one baseline, converges, and leaves the other sessions alone", () => {
      const run = startSim({ seed: 11, entityCount: 100 });
      const existing: SimClient[] = [];
      for (let i = 0; i < EXISTING_CLIENTS; i++) {
        existing.push(run.sim.addClient());
      }
      run.sim.run(JOIN_AT_MS);
      existing.forEach((client) => expect(client.stats.resets).toHaveLength(1));

      const joiner = run.sim.addClient();
      run.sim.run(10_000);
      run.freeze();
      run.sim.run(SETTLE_MS);

      // One reset, one rebuild (the joiner's entities enter once and never exit), nothing
      // sent to it after that baseline, and its state ends up the server's.
      expect(summarize(run.sim, joiner)).toEqual({
        errors: [],
        disconnects: [],
        resets: 1,
        baselinesDelivered: 1,
        baselinesSentAfterFirstReset: 0,
        enters: 100,
        exits: 0,
        differences: [],
      });
      expect(joiner.stats.resets[0].initial).toBe(true);
      // The other sessions are not sent a baseline, or rebuilt, because someone joined.
      existing.forEach((client) => {
        expect(client.baselinesSentSince(JOIN_AT_MS)).toBe(0);
        expect(summarize(run.sim, client)).toEqual({
          errors: [],
          disconnects: [],
          resets: 1,
          baselinesDelivered: 1,
          baselinesSentAfterFirstReset: 0,
          enters: 100,
          exits: 0,
          differences: [],
        });
      });
    }, 120_000);
  });
});

describe("the optimistic base (redundancyFrames) over the same link", () => {
  // Every R is run on the same seed as the run with R unset, so both links see the same loss and
  // reordering draws and the runs differ only in what the server sends. The link is the one the
  // sweep above uses: a 200 ms round trip, 5% loss each way and reordering, for 60 s.
  const REDUNDANCIES = [1, 2, 3];
  const SEEDS_COMPARED = [1, 2];
  const RUN_MS = 60_000;
  /** The connect handshake holds every run's view still for a round trip; stalls start after it. */
  const WARMUP_MS = 2_000;
  /** A client whose view stands still longer than this is stuck, not merely waiting out a loss. */
  const STUCK_MS = 1_000;

  const WORKLOADS: Array<{ name: string; mutation: Mutation }> = [
    // Every position changes on every frame, so a resend is superseded by the next frame's change
    // and the merged delta of the unset run is no larger than one frame's.
    { name: "every component changes on every frame", mutation: "every frame" },
    // Three entities change per frame, each about every 13 frames, so with an ack lag of 7 frames
    // a change is not superseded before it is acked and the unset run resends it in every frame.
    { name: "a few entities change per frame", mutation: { perFrame: 3 } },
    // One entity changes every fourth frame, as a dead-reckoned body does between its corrections.
    // Most frames hold nothing, so a base "R frames back" mostly names a frame that was never sent.
    { name: "one entity changes every fourth frame", mutation: { everyFrames: 4 } },
  ];

  /** One run, reduced to what the comparison needs. */
  interface RedundancyRun {
    redundancyFrames: number | undefined;
    bytesSent: number;
    gapReportsSent: number;
    optimisticFramesSent: number;
    /** How long the client's accepted frame stood still, each time it did, after the warm-up. */
    standstillsMs: number[];
    /**
     * How long each change took to reach the client after the warm-up: from the server building
     * the frame it was made in until the client's accepted frame was that frame or a later one.
     * Unlike a standstill it is not inflated by the quiet between changes of a sparse workload.
     */
    deliveryMs: number[];
    summary: ReturnType<typeof summarize>;
  }

  const unsetRuns = new Map<string, RedundancyRun>();

  function runWith(
    seed: number,
    mutation: Mutation,
    redundancyFrames: number | undefined
  ): RedundancyRun {
    const run = startSim({ seed, entityCount: 40, mutation, redundancyFrames });
    const client = run.sim.addClient();
    run.sim.run(RUN_MS);
    const frozenAtMs = run.sim.clock.now;
    run.freeze();
    run.sim.run(SETTLE_MS);

    const advances = client.stats.versionAdvances
      .map(({ atMs }) => atMs)
      .filter((atMs) => atMs >= WARMUP_MS && atMs <= frozenAtMs);
    const result: RedundancyRun = {
      redundancyFrames,
      bytesSent: client.stats.bytesSent,
      gapReportsSent: client.stats.gapReportsSent,
      optimisticFramesSent: client.stats.optimisticFramesSent,
      standstillsMs: advances.slice(1).map((atMs, index) => atMs - advances[index]),
      deliveryMs: deliveryTimes(
        run.changes.filter((change) => change.atMs >= WARMUP_MS),
        client.stats.versionAdvances
      ),
      summary: summarize(run.sim, client),
    };
    run.sim.dispose();
    sim = undefined;
    return result;
  }

  /** How long each of `changes` took to reach the client whose accepted frame moved as `advances`. */
  function deliveryTimes(changes: ChangeRecord[], advances: VersionAdvance[]): number[] {
    const times: number[] = [];
    let next = 0;
    for (const change of changes) {
      while (next < advances.length && advances[next].version < change.frame) {
        next++;
      }
      if (next < advances.length) {
        times.push(advances[next].atMs - change.atMs);
      }
    }
    return times;
  }

  function unsetRun(seed: number, name: string, mutation: Mutation): RedundancyRun {
    const key = `${seed}:${name}`;
    let run = unsetRuns.get(key);
    if (run === undefined) {
      run = runWith(seed, mutation, undefined);
      unsetRuns.set(key, run);
    }
    return run;
  }

  /**
   * The stalls of `run`: the times its view stood still for more than one frame interval longer
   * than the longest it ever did in the run with `redundancyFrames` unset on the same seed.
   */
  function stallsOf(run: RedundancyRun, unset: RedundancyRun): number[] {
    const thresholdMs = Math.max(...unset.standstillsMs) + 1000 / 30;
    return run.standstillsMs.filter((durationMs) => durationMs > thresholdMs);
  }

  /**
   * The changes of `run` that reached the client more than one frame interval later than the
   * slowest change of the run with `redundancyFrames` unset on the same seed.
   */
  function lateChangesOf(run: RedundancyRun, unset: RedundancyRun): number[] {
    const thresholdMs = Math.max(...unset.deliveryMs) + 1000 / 30;
    return run.deliveryMs.filter((durationMs) => durationMs > thresholdMs);
  }

  /**
   * One line per run when `VECS_SIM_REPORT` is set: the numbers the design is judged by. A stall is
   * a standstill of the client's view; in a workload that is quiet between changes the view also
   * stands still for the quiet, so the late changes are the better measure there.
   */
  function report(label: string, run: RedundancyRun, unset: RedundancyRun): void {
    if (process.env.VECS_SIM_REPORT === undefined) {
      return;
    }
    const stalls = stallsOf(run, unset);
    const late = lateChangesOf(run, unset);
    const meanMs =
      stalls.length === 0 ? 0 : stalls.reduce((sum, ms) => sum + ms, 0) / stalls.length;
    console.info(
      `${label} R=${String(run.redundancyFrames ?? "unset").padEnd(5)} ` +
        `bytes ${run.bytesSent} (${((100 * run.bytesSent) / unset.bytesSent).toFixed(0)}% of unset), ` +
        `optimistic frames ${run.optimisticFramesSent}, gap reports ${run.gapReportsSent}, ` +
        `longest standstill ${Math.max(...run.standstillsMs).toFixed(0)} ms, ` +
        `stalls ${stalls.length} (mean ${meanMs.toFixed(0)} ms, max ${Math.max(0, ...stalls).toFixed(0)} ms), ` +
        `late changes ${late.length} of ${run.deliveryMs.length} ` +
        `(slowest ${Math.max(...run.deliveryMs).toFixed(0)} ms)`
    );
  }

  describe.each(WORKLOADS)("$name", ({ name, mutation }) => {
    describe.each(SEEDS_COMPARED)("seed %i", (seed) => {
      it.each(REDUNDANCIES)(
        "redundancyFrames %i: no protocol error, disconnect or rebuild, the client converges and is never stuck",
        (redundancyFrames) => {
          const unset = unsetRun(seed, name, mutation);
          const optimistic = runWith(seed, mutation, redundancyFrames);
          report(`${name}, seed ${seed},`, unset, unset);
          report(`${name}, seed ${seed},`, optimistic, unset);

          expect(optimistic.summary).toEqual({
            errors: [],
            disconnects: [],
            resets: 1,
            baselinesDelivered: 1,
            baselinesSentAfterFirstReset: 0,
            enters: 40,
            exits: 0,
            differences: [],
          });
          expect(Math.max(...optimistic.standstillsMs)).toBeLessThan(STUCK_MS);
          // Never more than a run that resends every change until it is acked.
          expect(optimistic.bytesSent).toBeLessThan(unset.bytesSent);
        },
        300_000
      );
    });
  });

  describe("alongside the baseline handshake", () => {
    it("applies one recovery baseline after a stall longer than the window, then goes back to optimistic deltas", () => {
      const run = startSim({ seed: 3, entityCount: 40, redundancyFrames: 2 });
      const client = run.sim.addClient();
      run.sim.run(10_000);
      expect(client.stats.resets).toHaveLength(1);

      client.setBlocked("both", true);
      run.sim.run(Math.ceil(1.5 * WINDOW_FRAMES * run.sim.tickMs));
      client.setBlocked("both", false);
      const resumedAtMs = run.sim.clock.now;
      const optimisticBefore = client.stats.optimisticFramesSent;
      run.sim.run(10_000);
      run.freeze();
      run.sim.run(SETTLE_MS);

      // Everything sent during the outage was lost, so one baseline got through after it, and at
      // most one more was sent because the first was dropped. No optimistic delta ran ahead of it.
      const recovery = client.stats.resets.filter((reset) => reset.atMs >= resumedAtMs);
      expect(recovery).toHaveLength(1);
      expect(client.baselinesSentSince(resumedAtMs)).toBeLessThanOrEqual(2);
      expect(client.stats.optimisticFramesSent).toBeGreaterThan(optimisticBefore);
      expect(summarize(run.sim, client)).toMatchObject({
        errors: [],
        disconnects: [],
        resets: 2,
        differences: [],
      });
    }, 120_000);

    it("applies exactly one baseline to a client that joins a busy world mid-stream, and leaves the others alone", () => {
      const run = startSim({ seed: 11, entityCount: 100, redundancyFrames: 2 });
      const existing = [run.sim.addClient(), run.sim.addClient()];
      run.sim.run(5_000);

      const joiner = run.sim.addClient();
      run.sim.run(10_000);
      run.freeze();
      run.sim.run(SETTLE_MS);

      expect(summarize(run.sim, joiner)).toEqual({
        errors: [],
        disconnects: [],
        resets: 1,
        baselinesDelivered: 1,
        baselinesSentAfterFirstReset: 0,
        enters: 100,
        exits: 0,
        differences: [],
      });
      existing.forEach((client) => {
        expect(client.baselinesSentSince(5_000)).toBe(0);
        expect(summarize(run.sim, client)).toMatchObject({
          errors: [],
          disconnects: [],
          resets: 1,
          differences: [],
        });
      });
    }, 120_000);
  });

  describe("on a link that loses nothing", () => {
    const CLEAN_LINK = symmetric({ oneWayMs: 100 });

    it.each(REDUNDANCIES)(
      "redundancyFrames %i never reports a gap, even when the view goes quiet between changes",
      (redundancyFrames) => {
        // One entity changes every 5 frames, so the view is quiet for four of them and the frame
        // before a change is empty, while the previous change is still unacked (the ack lag is
        // 7 frames): a base one redundancy window back would name a frame the client never
        // received, and the client would read the change as a gap.
        const run = startSim({
          seed: 1,
          entityCount: 20,
          link: CLEAN_LINK,
          mutation: { everyFrames: 5 },
          redundancyFrames,
        });
        const client = run.sim.addClient();

        run.sim.run(20_000);
        run.freeze();
        run.sim.run(SETTLE_MS);

        expect(client.stats.gapReportsSent).toBe(0);
        expect(client.stats.optimisticFramesSent).toBeGreaterThan(50);
        expect(summarize(run.sim, client)).toMatchObject({
          errors: [],
          disconnects: [],
          resets: 1,
          differences: [],
        });
      },
      120_000
    );

    it("finds a change lost with nothing after it by the ack timeout, and the client has it one link delay later", () => {
      const run = startSim({
        seed: 1,
        entityCount: 5,
        link: CLEAN_LINK,
        mutation: "none",
        redundancyFrames: 2,
      });
      const client = run.sim.addClient();
      run.sim.run(3_000);
      expect(run.sim.diffFromServer(client)).toEqual([]);
      const deltasBefore = client.stats.deltasSent.length;

      // The change is made, and the two frames that carry it, with the redundancy of two, are
      // lost. Nothing else ever changes, so no later frame shows the client a gap.
      client.setBlocked("down", true);
      run.touch(0);
      const changedAtMs = run.sim.clock.now;
      run.sim.run(2.5 * run.sim.tickMs);
      client.setBlocked("down", false);
      const lost = client.stats.deltasSent.slice(deltasBefore);
      expect(lost).toHaveLength(2);
      expect(run.sim.diffFromServer(client)).not.toEqual([]);

      let convergedAtMs: number | undefined;
      while (convergedAtMs === undefined && run.sim.clock.now - changedAtMs < 5_000) {
        run.sim.run(10);
        if (run.sim.diffFromServer(client).length === 0) {
          convergedAtMs = run.sim.clock.now;
        }
      }

      // The smoothed round trip is the link's 200 ms plus a wait of up to one ack interval, and the
      // timeout is twice that: 400 to 467 ms, counted from when the lost frame was sent. The
      // server notices on the first frame past it and sends the change again from the ack, and it
      // takes a link delay to arrive and the client's interpolation delay to apply.
      const resent = client.stats.deltasSent[deltasBefore + 2];
      const sentAtMs = lost[0].atMs;
      expect(resent.fromFrame).toBe(lost[0].fromFrame);
      expect(resent.atMs - sentAtMs).toBeGreaterThan(400);
      expect(resent.atMs - sentAtMs).toBeLessThanOrEqual(2 * (200 + 1000 / 30) + run.sim.tickMs);
      expect(convergedAtMs).toBeDefined();
      expect(convergedAtMs! - sentAtMs).toBeLessThan(
        2 * (200 + 1000 / 30) + run.sim.tickMs + 100 + 200
      );
      expect(summarize(run.sim, client)).toMatchObject({
        errors: [],
        disconnects: [],
        resets: 1,
        differences: [],
      });
    }, 120_000);
  });

  describe("frames lost in sparse traffic, on a link that otherwise loses nothing", () => {
    // The base of an optimistic delta is the state frame of the send `R` sends ago: the frame at
    // which the view had last changed as of that send, which the client holds if it lost at most
    // R - 1 sends in a row. In sparse traffic the sends are far apart in time, so a base chosen by
    // frame number alone ("R frames back") would land on a frame that was never sent, or on the
    // last copy of the previous change, and the loss of that one frame would read as a gap. Each
    // run loses `lost` consecutive deltas of the sends of an otherwise identical run, in turn, and
    // none may make the client report a gap.
    const CLEAN_LINK = symmetric({ oneWayMs: 100 });
    const SCENARIOS: Array<{
      name: string;
      mutation: Mutation;
      ticks: number;
      keepAliveFrames?: number;
    }> = [
      { name: "one change every four frames", mutation: { everyFrames: 4 }, ticks: 150 },
      {
        // Between the changes the frames are keepalives, which name the state frame of the change
        // before them.
        name: "four-frame changes + keepalive",
        mutation: { everyFrames: 4 },
        ticks: 150,
        keepAliveFrames: 1,
      },
      {
        // Quiet stretches of 2, 3, 5, 8, 13, 21, 34 and 55 frames, shorter and longer than the
        // 7 frames the acks lag behind.
        name: "single changes after quiet stretches",
        mutation: { atTicks: [12, 14, 17, 22, 30, 43, 64, 98, 153] },
        ticks: 190,
      },
    ];
    const LOSSES = [
      { redundancyFrames: 2, lost: 1 },
      { redundancyFrames: 3, lost: 2 },
    ];

    /** Run `ticks` frames with the deltas whose frame number is in `lostFrames` lost on the way down. */
    function runLosing(
      mutation: Mutation,
      ticks: number,
      redundancyFrames: number,
      lostFrames: ReadonlySet<number>,
      keepAliveFrames?: number
    ) {
      const run = startSim({
        seed: 1,
        entityCount: 10,
        link: CLEAN_LINK,
        mutation,
        redundancyFrames,
        keepAliveFrames,
      });
      const client = run.sim.addClient();
      client.down.drop = (data) => {
        const diff = new Decoder(data).read(Server2Client).diff;
        return diff !== undefined && diff.fromFrame > 0 && lostFrames.has(diff.toFrame);
      };
      run.sim.run(ticks * run.sim.tickMs);
      run.freeze();
      run.sim.run(SETTLE_MS);
      const result = {
        deltaFrames: client.stats.deltasSent.map((delta) => delta.toFrame),
        changeFrames: run.changes.map((change) => change.frame),
        gapReports: client.stats.gapReportsSent,
        optimisticFrames: client.stats.optimisticFramesSent,
        summary: summarize(run.sim, client),
      };
      run.sim.dispose();
      sim = undefined;
      return result;
    }

    /**
     * What happened when each of `lostSets` was lost in turn, for those runs that were not clean: the
     * client reported a gap, hit an error or a disconnect, was rebuilt, or ended up different from
     * the server.
     */
    function uncleanRuns(
      mutation: Mutation,
      ticks: number,
      redundancyFrames: number,
      lostSets: number[][],
      keepAliveFrames?: number
    ) {
      const failures: Array<{
        lostFrames: number[];
        gapReports: number;
        summary: ReturnType<typeof summarize>;
      }> = [];
      for (const lostFrames of lostSets) {
        const run = runLosing(
          mutation,
          ticks,
          redundancyFrames,
          new Set(lostFrames),
          keepAliveFrames
        );
        const clean =
          run.gapReports === 0 &&
          run.summary.errors.length === 0 &&
          run.summary.disconnects.length === 0 &&
          run.summary.resets === 1 &&
          run.summary.differences.length === 0;
        if (!clean) {
          failures.push({ lostFrames, gapReports: run.gapReports, summary: run.summary });
        }
      }
      return failures;
    }

    /** Every run of `count` consecutive frames of `sent`. */
    function consecutive(sent: number[], count: number): number[][] {
      const windows: number[][] = [];
      for (let first = 0; first + count <= sent.length; first++) {
        windows.push(sent.slice(first, first + count));
      }
      return windows;
    }

    describe.each(SCENARIOS)("$name", ({ mutation, ticks, keepAliveFrames }) => {
      it.each(LOSSES)(
        "redundancyFrames $redundancyFrames: $lost consecutive lost deltas never make the client report a gap",
        ({ redundancyFrames, lost }) => {
          const reference = runLosing(
            mutation,
            ticks,
            redundancyFrames,
            new Set(),
            keepAliveFrames
          );
          expect(reference.gapReports).toBe(0);
          expect(reference.optimisticFrames).toBeGreaterThan(0);
          const sent = reference.deltaFrames;
          expect(sent.length).toBeGreaterThan(8);

          expect(
            uncleanRuns(mutation, ticks, redundancyFrames, consecutive(sent, lost), keepAliveFrames)
          ).toEqual([]);
        },
        120_000
      );
    });

    describe("a lost frame that carried nothing the client lacked", () => {
      // The state frame of a keepalive, or of the repeat of a change the client already holds, is
      // the frame of that change, so losing it leaves the client exactly where the server's state
      // is. A base chosen from the frames sent would land on the lost frame instead, and the
      // client would hold the next delta and report a gap though nothing was missing, as soon as
      // `R` such frames were lost in a row.

      const IDLE_LOSSES = [
        { redundancyFrames: 1, lost: 1 },
        { redundancyFrames: 2, lost: 1 },
        { redundancyFrames: 2, lost: 2 },
        { redundancyFrames: 3, lost: 1 },
        { redundancyFrames: 3, lost: 2 },
        { redundancyFrames: 3, lost: 3 },
      ];

      it.each(IDLE_LOSSES)(
        "an idle view, redundancyFrames $redundancyFrames: $lost consecutive lost keepalives never make the client report a gap",
        ({ redundancyFrames, lost }) => {
          const reference = runLosing("none", 80, redundancyFrames, new Set(), 1);
          // Past the baseline, a keepalive on every frame.
          expect(reference.deltaFrames.length).toBeGreaterThan(60);

          expect(
            uncleanRuns("none", 80, redundancyFrames, consecutive(reference.deltaFrames, lost), 1)
          ).toEqual([]);
        },
        120_000
      );

      const CARRY_SCENARIOS: Array<{ name: string; mutation: Mutation; ticks: number }> = [
        { name: "one change every four frames", mutation: { everyFrames: 4 }, ticks: 100 },
        {
          name: "single changes after quiet stretches",
          mutation: { atTicks: [12, 14, 17, 22, 30, 43, 64] },
          ticks: 100,
        },
      ];

      describe.each(CARRY_SCENARIOS)("$name", ({ mutation, ticks }) => {
        it.each([2, 3])(
          "redundancyFrames %i: the repeats of a change and the first copy of the next, all lost, never make the client report a gap",
          (redundancyFrames) => {
            const reference = runLosing(mutation, ticks, redundancyFrames, new Set());
            const changes = new Set(reference.changeFrames);
            const sent = reference.deltaFrames;
            // The R - 1 repeats of a change, then the frame that sends the next one for the first
            // time: R sends in a row, of which the client has none that it lacked. The first delta
            // is left out, because it sends for the first time what was withheld while the
            // baseline was in flight.
            const lostSets = consecutive(sent, redundancyFrames).filter(
              (frames) =>
                frames[0] !== sent[0] &&
                changes.has(frames[frames.length - 1]) &&
                frames.slice(0, -1).every((frame) => !changes.has(frame))
            );
            expect(lostSets.length).toBeGreaterThan(2);

            expect(uncleanRuns(mutation, ticks, redundancyFrames, lostSets)).toEqual([]);
          },
          120_000
        );
      });

      it.each([
        { redundancyFrames: 1, keepAliveFrames: undefined },
        { redundancyFrames: 2, keepAliveFrames: undefined },
        { redundancyFrames: 3, keepAliveFrames: undefined },
        { redundancyFrames: 1, keepAliveFrames: 1 },
        { redundancyFrames: 2, keepAliveFrames: 1 },
        { redundancyFrames: 3, keepAliveFrames: 1 },
      ])(
        "redundancyFrames $redundancyFrames, keepAliveFrames $keepAliveFrames: losing every send that carried a change still makes the client report a gap, and it recovers",
        ({ redundancyFrames, keepAliveFrames }) => {
          // Changes in frames 13, 41 and 49. All R sends of the second are lost, so the client
          // lacks it, and the first frame after them that starts at it, a keepalive or the third
          // change, is a gap, well before the ack timeout (about 400 ms) would have found the loss.
          // The server falls back to the ack and the client catches up.
          const mutation: Mutation = { atTicks: [12, 40, 48] };
          const reference = runLosing(mutation, 100, redundancyFrames, new Set(), keepAliveFrames);
          const second = reference.changeFrames[1];
          const lostFrames = Array.from({ length: redundancyFrames }, (_, i) => second + i);
          expect(lostFrames.every((frame) => reference.deltaFrames.includes(frame))).toBe(true);

          const run = runLosing(
            mutation,
            100,
            redundancyFrames,
            new Set(lostFrames),
            keepAliveFrames
          );

          expect(run.gapReports).toBeGreaterThan(0);
          expect(run.summary).toEqual({
            errors: [],
            disconnects: [],
            resets: 1,
            baselinesDelivered: 1,
            baselinesSentAfterFirstReset: 0,
            enters: 10,
            exits: 0,
            differences: [],
          });
        },
        120_000
      );
    });
  });
});

describe("the keepalive (keepAliveFrames) over the same link", () => {
  const RUN_MS = 60_000;
  /** The connect handshake holds every run's view still for a round trip. */
  const WARMUP_MS = 2_000;
  /** A client whose view stands still longer than this is stuck, not merely waiting out a loss. */
  const STUCK_MS = 1_000;

  /** The longest the client's accepted frame stood still between two advances after the warm-up. */
  function longestStandstillMs(client: SimClient): number {
    const advances = client.stats.versionAdvances
      .map(({ atMs }) => atMs)
      .filter((atMs) => atMs >= WARMUP_MS);
    return advances.slice(1).reduce((longest, atMs, i) => Math.max(longest, atMs - advances[i]), 0);
  }

  /** The standstills of the client's accepted frame after the warm-up that lasted over `overMs`. */
  function standstillsOver(client: SimClient, overMs: number): number[] {
    const advances = client.stats.versionAdvances
      .map(({ atMs }) => atMs)
      .filter((atMs) => atMs >= WARMUP_MS);
    return advances
      .slice(1)
      .map((atMs, i) => atMs - advances[i])
      .filter((durationMs) => durationMs > overMs);
  }

  // An idle view of 20 entities, kept alive by a keepalive on every frame. After the baseline it
  // holds no change, so there is nothing for the redundancy to protect, and nothing the client can
  // lack: a lost keepalive carries no state, so no loss can make it miss anything and none may make
  // it report a gap. What the redundancy costs here is its bytes only.
  describe.each([1, 2])(
    "an idle view for 60 s at 200 ms round trip, 5% loss and reordering, seed %i",
    (seed) => {
      it.each([undefined, 1, 2, 3])(
        "keeps moving and reports no gap, with keepAliveFrames 1 and redundancyFrames %s",
        (redundancyFrames) => {
          const run = startSim({
            seed,
            entityCount: 20,
            mutation: "none",
            redundancyFrames,
            keepAliveFrames: 1,
          });
          const client = run.sim.addClient();

          run.sim.run(RUN_MS);
          run.freeze();
          run.sim.run(SETTLE_MS);

          if (process.env.VECS_SIM_REPORT !== undefined) {
            const standstills = standstillsOver(client, 100);
            console.info(
              `idle view, seed ${seed}, K=1 R=${String(redundancyFrames ?? "unset").padEnd(5)} ` +
                `frames ${client.stats.deltasSent.length}, bytes ${client.stats.bytesSent}, ` +
                `gap reports ${client.stats.gapReportsSent}, ` +
                `standstills over 100 ms ${standstills.length} ` +
                `(longest ${longestStandstillMs(client).toFixed(0)} ms), late changes 0 of 0`
            );
          }

          // One rebuild, on connect: a keepalive that goes missing is never a protocol error or a
          // disconnect, and the idle client ends where the server is.
          expect(summarize(run.sim, client)).toMatchObject({
            errors: [],
            disconnects: [],
            resets: 1,
            enters: 20,
            exits: 0,
            differences: [],
          });
          // A frame on nearly every tick: the 1800 of a minute at 30 Hz, less the handshake.
          expect(client.stats.deltasSent.length).toBeGreaterThan(1700);
          // No change was ever made after the baseline, so no loss can have cost the client one.
          expect(client.stats.gapReportsSent).toBe(0);
          expect(longestStandstillMs(client)).toBeLessThan(STUCK_MS);
        },
        120_000
      );
    }
  );

  describe("on a link that loses nothing", () => {
    const CLEAN_LINK = symmetric({ oneWayMs: 100 });
    const COMBINATIONS = [
      { keepAliveFrames: 1, redundancyFrames: 1 },
      { keepAliveFrames: 1, redundancyFrames: 2 },
      { keepAliveFrames: 1, redundancyFrames: 3 },
      { keepAliveFrames: 2, redundancyFrames: 2 },
    ];
    const WORKLOADS: Array<{ name: string; mutation: Mutation }> = [
      { name: "an idle view", mutation: "none" },
      { name: "one change every fifth frame", mutation: { everyFrames: 5 } },
    ];

    describe.each(WORKLOADS)("$name", ({ mutation }) => {
      it.each(COMBINATIONS)(
        "never reports a gap, with keepAliveFrames $keepAliveFrames and redundancyFrames $redundancyFrames",
        ({ keepAliveFrames, redundancyFrames }) => {
          const run = startSim({
            seed: 1,
            entityCount: 20,
            link: CLEAN_LINK,
            mutation,
            redundancyFrames,
            keepAliveFrames,
          });
          const client = run.sim.addClient();

          run.sim.run(20_000);
          run.freeze();
          run.sim.run(SETTLE_MS);

          expect(client.stats.gapReportsSent).toBe(0);
          if (mutation === "none") {
            // Once the baseline is acked an idle view has nothing the client lacks, so every
            // keepalive starts at the ack and presumes nothing.
            expect(client.stats.optimisticFramesSent).toBe(0);
          } else {
            expect(client.stats.optimisticFramesSent).toBeGreaterThan(50);
          }
          expect(summarize(run.sim, client)).toMatchObject({
            errors: [],
            disconnects: [],
            resets: 1,
            differences: [],
          });
        },
        120_000
      );
    });
  });
});

/** How the entities' components change as the run goes on. */
type Mutation =
  /** Every component of every entity changes on every frame (the default). */
  | "every frame"
  /** Nothing changes by itself; a test changes things with `touch`. */
  | "none"
  /** One entity's position changes on every `everyFrames`th frame. */
  | { everyFrames: number }
  /** `perFrame` entities' positions change on every frame, taking turns. */
  | { perFrame: number }
  /** One entity's position changes on each of the listed ticks (frame number minus one). */
  | { atTicks: number[] };

interface StartOptions {
  seed: number;
  entityCount: number;
  link?: ReturnType<typeof symmetric>;
  mutation?: Mutation;
  /** The server's `historyFrames`; the default when omitted. */
  historyFrames?: number;
  /** The server's `redundancyFrames`; unset (today's behavior) when omitted. */
  redundancyFrames?: number;
  /** The server's `keepAliveFrames`; unset (today's behavior) when omitted. */
  keepAliveFrames?: number;
}

/** Something changed in server frame `frame`, which the server built at `atMs`. */
interface ChangeRecord {
  frame: number;
  atMs: number;
}

interface Run {
  sim: ReplicationSim;
  /** Every frame in which the mutation changed something, until the run was frozen. */
  changes: ChangeRecord[];
  /** Stop changing components, so a client can catch up with the final state. */
  freeze(): void;
  /** Change one component of one entity right now. */
  touch(index: number): void;
  /** Destroy every entity, so the world has nothing left to replicate. */
  destroyAll(): void;
}

/** A server with `entityCount` entities, whose components change as `mutation` says. */
function startSim(options: StartOptions): Run {
  const simulation = new ReplicationSim({
    networkComponents: [Position, Health],
    seed: options.seed,
    link: options.link ?? HARSH_LINK,
    serverOptions: {
      historyFrames: options.historyFrames,
      redundancyFrames: options.redundancyFrames,
      keepAliveFrames: options.keepAliveFrames,
    },
  });
  sim = simulation;
  const entities: Entity[] = [];
  for (let i = 0; i < options.entityCount; i++) {
    entities.push(
      simulation.server
        .entity()
        .add(Networked)
        .set(Position, { x: i * 10, y: i })
        .set(Health, { hp: 100 })
    );
  }
  const mutation = options.mutation ?? "every frame";
  const changes: ChangeRecord[] = [];
  let frozen = false;

  /** Change the entities as `mutation` says on this tick; whether anything changed. */
  function mutate(tick: number): boolean {
    if (mutation === "none") {
      return false;
    }
    if (mutation === "every frame") {
      entities.forEach((entity, index) => {
        const position = entity.get(Position)!;
        entity.set(Position, { x: position.x + 1, y: (position.y + index + 1) % 1000 });
        if (tick % 4 === index % 4) {
          entity.set(Health, { hp: (entity.get(Health)!.hp + 7) % 101 });
        }
      });
      return true;
    }
    if ("atTicks" in mutation) {
      const index = mutation.atTicks.indexOf(tick);
      if (index < 0) {
        return false;
      }
      moveOne(entities[index % entities.length]);
      return true;
    }
    if ("perFrame" in mutation) {
      for (let k = 0; k < mutation.perFrame; k++) {
        moveOne(entities[(tick * mutation.perFrame + k) % entities.length]);
      }
      return true;
    }
    if (tick % mutation.everyFrames !== mutation.everyFrames - 1) {
      return false;
    }
    moveOne(entities[Math.floor(tick / mutation.everyFrames) % entities.length]);
    return true;
  }

  simulation.onTick((tick) => {
    if (!frozen && mutate(tick)) {
      // Tick n runs the server's frame n + 1.
      changes.push({ frame: tick + 1, atMs: simulation.clock.now });
    }
  });
  return {
    sim: simulation,
    changes,
    freeze: () => {
      frozen = true;
    },
    touch: (index) => {
      entities[index].set(Health, { hp: 7 });
    },
    destroyAll: () => {
      frozen = true;
      entities.forEach((entity) => entity.destroy());
    },
  };
}

function moveOne(entity: Entity): void {
  const position = entity.get(Position)!;
  entity.set(Position, { x: position.x + 1, y: position.y });
}

/** Everything a test asserts about one client, in one object so a failure shows it all. */
function summarize(simulation: ReplicationSim, client: SimClient) {
  const firstResetAtMs = client.stats.resets[0]?.atMs ?? Number.POSITIVE_INFINITY;
  return {
    errors: client.stats.errors,
    disconnects: client.stats.disconnects,
    resets: client.stats.resets.length,
    baselinesDelivered: client.stats.baselinesDelivered,
    baselinesSentAfterFirstReset: client.stats.baselinesSent.filter(
      (baseline) => baseline.atMs > firstResetAtMs
    ).length,
    enters: client.stats.enters,
    exits: client.stats.exits,
    differences: simulation.diffFromServer(client).slice(0, 5),
  };
}
