import { afterEach, describe, expect, it } from "vitest";
import { wireType } from "@vworlds/vecs-wire";
import type { Entity } from "@vworlds/vecs";
import { Networked } from "../src/index.js";
import { symmetric } from "./harness/lossy_link.js";
import { ReplicationSim, type SimClient } from "./harness/replication_sim.js";

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
  ];

  /** One run, reduced to what the comparison needs. */
  interface RedundancyRun {
    redundancyFrames: number | undefined;
    bytesSent: number;
    gapReportsSent: number;
    optimisticFramesSent: number;
    /** How long the client's accepted frame stood still, each time it did, after the warm-up. */
    standstillsMs: number[];
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

    const advances = client.stats.versionAdvancesAtMs.filter(
      (atMs) => atMs >= WARMUP_MS && atMs <= frozenAtMs
    );
    const result: RedundancyRun = {
      redundancyFrames,
      bytesSent: client.stats.bytesSent,
      gapReportsSent: client.stats.gapReportsSent,
      optimisticFramesSent: client.stats.optimisticFramesSent,
      standstillsMs: advances.slice(1).map((atMs, index) => atMs - advances[index]),
      summary: summarize(run.sim, client),
    };
    run.sim.dispose();
    sim = undefined;
    return result;
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

  /** One line per run when `VECS_SIM_REPORT` is set: the numbers the design is judged by. */
  function report(label: string, run: RedundancyRun, unset: RedundancyRun): void {
    if (process.env.VECS_SIM_REPORT === undefined) {
      return;
    }
    const stalls = stallsOf(run, unset);
    const meanMs =
      stalls.length === 0 ? 0 : stalls.reduce((sum, ms) => sum + ms, 0) / stalls.length;
    console.info(
      `${label} R=${String(run.redundancyFrames ?? "unset").padEnd(5)} ` +
        `bytes ${run.bytesSent} (${((100 * run.bytesSent) / unset.bytesSent).toFixed(0)}% of unset), ` +
        `optimistic frames ${run.optimisticFramesSent}, gap reports ${run.gapReportsSent}, ` +
        `longest standstill ${Math.max(...run.standstillsMs).toFixed(0)} ms, ` +
        `stalls ${stalls.length} (mean ${meanMs.toFixed(0)} ms, max ${Math.max(0, ...stalls).toFixed(0)} ms)`
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
  | { perFrame: number };

interface StartOptions {
  seed: number;
  entityCount: number;
  link?: ReturnType<typeof symmetric>;
  mutation?: Mutation;
  /** The server's `historyFrames`; the default when omitted. */
  historyFrames?: number;
  /** The server's `redundancyFrames`; unset (today's behavior) when omitted. */
  redundancyFrames?: number;
}

interface Run {
  sim: ReplicationSim;
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
  let frozen = false;
  simulation.onTick((tick) => {
    if (frozen || mutation === "none") {
      return;
    }
    if (mutation === "every frame") {
      entities.forEach((entity, index) => {
        const position = entity.get(Position)!;
        entity.set(Position, { x: position.x + 1, y: (position.y + index + 1) % 1000 });
        if (tick % 4 === index % 4) {
          entity.set(Health, { hp: (entity.get(Health)!.hp + 7) % 101 });
        }
      });
      return;
    }
    if ("perFrame" in mutation) {
      for (let k = 0; k < mutation.perFrame; k++) {
        const entity = entities[(tick * mutation.perFrame + k) % entities.length];
        const position = entity.get(Position)!;
        entity.set(Position, { x: position.x + 1, y: position.y });
      }
      return;
    }
    if (tick % mutation.everyFrames === mutation.everyFrames - 1) {
      const entity = entities[Math.floor(tick / mutation.everyFrames) % entities.length];
      const position = entity.get(Position)!;
      entity.set(Position, { x: position.x + 1, y: position.y });
    }
  });
  return {
    sim: simulation,
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
