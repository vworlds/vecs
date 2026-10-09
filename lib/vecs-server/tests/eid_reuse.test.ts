import { beforeAll, describe, expect, it } from "vitest";
import {
  ALL_COMPONENTS,
  ComponentSnapshot,
  Server2Client,
  type RemovedComponent,
} from "@vworlds/vecs-protocol";
import { Decoder, wireType } from "@vworlds/vecs-wire";
import { DEFAULT_ID_REUSE_WAIT_FRAMES, ON_UPDATE, POST_UPDATE, type Entity } from "@vworlds/vecs";
import { Networked, type ServerWorld } from "../src/index.js";
import { symmetric, type DuplexConditions } from "./harness/lossy_link.js";
import { ReplicationSim, type SimClient } from "./harness/replication_sim.js";

// A replicated entity's eid is freed when the entity is destroyed, and the id pool hands the lowest
// free id out first, so a later entity can take it. The wire carries no entity generation: a client
// that holds entity A under eid N and is then told about entity B under eid N cannot tell the two
// apart, except by the order a diff means: within one diff, the removal of all of N precedes every
// snapshot of N, so the snapshots are B's. These tests drive a real ServerWorld and a real
// ClientWorld (see ./harness/replication_sim.ts) through an A-destroyed / B-created handover on one
// eid, and assert what the client ends up with: B, and exactly B's components, on a new entity
// rather than on A's.
//
// A server keeps a freed id out of circulation for `historyFrames + 1` frames (65 by default), so on
// a stock server B cannot take A's eid until A's removal has left every session's history. Then a
// client that missed the removal is rebuilt from a baseline, and the ordering rule is never put to
// the test. The ordering rule is what makes the handover safe whatever the id policy, so the
// scenarios that cannot happen on a stock server patch the pool, which no option allows:
//
// - "legacy" gives it the 16-frame quarantine servers had before the fix, a window the history
//   outlives, which reaches the downlink gap and the render stall with the ordering rule alone;
// - "off" lets B take the eid at once, in the frame of the destroy or the next one.
//
// `localSeq` counts the rebuilds of the entity under the eid. A reset travels in every delta whose
// span includes A's removal, and a delta is built from the newest ack, so a client whose acks lag
// receives overlapping deltas and rebuilds B once for each of them until its ack passes the
// removal. Where that can happen the tests only require a rebuilt entity (`localSeq` 2 or more, A's
// mark is 1) and the right replicated state; where a lone frame carries the reset they require
// exactly one rebuild.

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

class Health {
  @wireType("i32")
  public hp = 0;
}

class Team {
  @wireType("i32")
  public id = 0;
}

/** Client-local, never replicated: stands for a sprite or any state a game hangs on an entity. */
class LocalMark {
  public seq = 0;
}

/** The server's default `historyFrames`. */
const HISTORY_FRAMES = 64;

/** How long a stock server keeps a freed id out of circulation: one frame more than its history. */
const STOCK_QUARANTINE_FRAMES = HISTORY_FRAMES + 1;

/** The quarantine servers had before it was tied to the history: `DEFAULT_ID_REUSE_WAIT_FRAMES`. */
const LEGACY_QUARANTINE_FRAMES = DEFAULT_ID_REUSE_WAIT_FRAMES;

/** Ticks before the handover, enough for the client to take its baseline and settle. */
const WARMUP_TICKS = 45;

/** Ack timer fast enough that every ack reaches the server before its next tick (a 33 ms tick). */
const FAST_ACK_MS = 8;

const A_POSITION = { x: 1, y: 2 };
const A_HEALTH = 55;
const B_POSITION = { x: 700, y: 8 };
const B_TEAM = 3;

const NETWORK_COMPONENTS = [Position, Health, Team];

/** What the client holds under one eid. */
interface ClientEntityState {
  position: { x: number; y: number } | undefined;
  health: number | undefined;
  team: number | undefined;
  /** The `enter` count the client-local mark was set on: 1 for A's entity, 2 for a rebuilt one. */
  localSeq: number | undefined;
}

/** B's replicated components as a client should hold them: B's own and nothing of A's. */
const B_REPLICATED = { position: B_POSITION, health: undefined, team: B_TEAM };

/** A as the client holds it before the handover. */
const A_ON_CLIENT: ClientEntityState = {
  position: A_POSITION,
  health: A_HEALTH,
  team: undefined,
  localSeq: 1,
};

/** Acks that take 70 ms to reach the server, a little over two ticks, and a clean link otherwise. */
const LATE_ACKS: DuplexConditions = { down: {}, up: { oneWayMs: 70 } };

/** One server frame as it left for the client, restricted to the eid under test. */
interface WireFrame {
  fromFrame: number;
  toFrame: number;
  snapshots: string[];
  removed: string[];
  /** The frame was sent while the downlink was cut, or chosen to be lost, so the client never got it. */
  lost: boolean;
}

/**
 * How the quarantine of the server's `entity` pool is set:
 *
 * - `"stock"` leaves it as the server built it: `historyFrames + 1` frames;
 * - `"legacy"` patches it to the 16 frames servers had before, to reach the handover with the
 *   ordering rule alone;
 * - `"off"` patches it to reuse at once.
 */
type Quarantine = "stock" | "legacy" | "off";

interface Scenario {
  quarantine: Quarantine;
  /** Ticks between A's destroy and B's creation: 0 is the same frame. */
  spawnAfterTicks: number;
  /** Destroy and create from the tick hook, before the frame (default), or from two systems inside it. */
  via?: "hook" | "systems";
  /** How often the client acks. Default: the harness's, once per tick, so a delta spans two frames. */
  ackIntervalMs?: number;
  /** Conditions of the client's link. Default: a perfect one. */
  link?: DuplexConditions;
  /** Cut the downlink from tick `from` to tick `to` after the destroy (a network hiccup). */
  downOutage?: readonly [from: number, to: number];
  /** Stop the client's render loop from tick `from` to tick `to` after the destroy (a hidden tab). */
  renderStall?: readonly [from: number, to: number];
  /** Lose the first frame that carries A's removal, and only that one. */
  loseRemovalFrame?: boolean;
  /** B's position changes on every tick after it is created, as a bullet's does. */
  bMoves?: boolean;
}

interface HandoverResult {
  /** B was given A's eid. */
  reused: boolean;
  eid: number;
  /** Frames between A's destroy and B's creation, as the server numbers them. */
  frameGap: number;
  /** Frames the delta built for B's frame covers: B's frame minus the session's ack. 1 is a lone frame. */
  pullSpan: number;
  /** What the client held under the eid before the handover. */
  before: ClientEntityState | undefined;
  /** What the client holds under the eid once everything has settled. */
  after: ClientEntityState | undefined;
  /** The client's entity under the eid before the handover is the very object it holds afterwards. */
  keptTheSameEntityObject: boolean;
  /** Frames sent to the client that mention the eid. */
  wire: WireFrame[];
  /** Baselines the client applied: 1 is the first one only, more means it was rebuilt from scratch. */
  resets: number;
  /** Server and client differences once everything has settled. */
  differences: string[];
}

describe("a replicated eid handed from a destroyed entity to a new one", () => {
  describe("what a stock server does with a freed eid", () => {
    it("holds it for historyFrames + 1 frames: a new entity in the frame of the destroy gets another eid", () => {
      const result = runHandover({ quarantine: "stock", spawnAfterTicks: 0 });

      expect(result.reused).toBe(false);
      expect(result.differences).toEqual([]);
    });

    it("still holds it one frame short of that", () => {
      const result = runHandover({
        quarantine: "stock",
        spawnAfterTicks: STOCK_QUARANTINE_FRAMES - 1,
      });

      expect(result.reused).toBe(false);
      expect(result.differences).toEqual([]);
    });

    it("hands it out again exactly historyFrames + 1 frames after the destroy, lowest id first", () => {
      const result = runHandover({ quarantine: "stock", spawnAfterTicks: STOCK_QUARANTINE_FRAMES });

      expect(result.reused).toBe(true);
      expect(result.frameGap).toBe(STOCK_QUARANTINE_FRAMES);
      expect(result.differences).toEqual([]);
    });
  });

  describe("case 1: A is destroyed and B created in the same frame (quarantine off)", () => {
    describeScenario(
      "with acks that keep up, so the delta for the frame is the frame alone",
      { quarantine: "off", spawnAfterTicks: 0, ackIntervalMs: FAST_ACK_MS },
      (getResult) => {
        it("reuses the eid, and sends the removal of all of A with B's snapshots in one frame", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.frameGap).toBe(0);
          expect(result.pullSpan).toBe(1);
          expect(result.before).toEqual(A_ON_CLIENT);
          const carrier = result.wire.find((frame) => frame.removed.length > 0);
          expect(carrier?.removed).toEqual([`${result.eid}:ALL`]);
          expect(carrier?.snapshots).toEqual([`${result.eid}:Position`, `${result.eid}:Team`]);
        });

        it("leaves the client with B and exactly B's replicated components, built once", () => {
          const result = getResult();

          expectFreshB(result, "once");
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "with acks 2 or more frames late",
      { quarantine: "off", spawnAfterTicks: 0, ackIntervalMs: FAST_ACK_MS, link: LATE_ACKS },
      (getResult) => {
        it("reuses the eid, and the delta for the frame spans at least 3 frames", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.frameGap).toBe(0);
          expect(result.pullSpan).toBeGreaterThanOrEqual(3);
          expect(result.before).toEqual(A_ON_CLIENT);
        });

        it("sends B's snapshots to the client, with the removal of A they replace", () => {
          const result = getResult();

          const deltas = result.wire.filter((frame) => frame.fromFrame !== 0);
          const sent = deltas.flatMap((frame) => frame.snapshots);
          expect(sent).toContain(`${result.eid}:Position`);
          expect(sent).toContain(`${result.eid}:Team`);
          deltas
            .filter((frame) => frame.snapshots.length > 0)
            .forEach((frame) => {
              expect(frame.removed).toEqual([`${result.eid}:ALL`]);
            });
        });

        it("leaves the client with B and exactly B's replicated components", () => {
          const result = getResult();

          expectFreshB(result, "overlapping deltas");
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "with the harness's default acks, when a destroying system and a spawning system run in the same frame",
      { quarantine: "off", spawnAfterTicks: 0, via: "systems" },
      (getResult) => {
        it("reuses the eid in the frame of the destroy", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.frameGap).toBe(0);
        });

        it("leaves the client with B and exactly B's replicated components", () => {
          const result = getResult();

          expectFreshB(result, "overlapping deltas");
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "with the harness's default acks, when B keeps changing, as a bullet does",
      { quarantine: "off", spawnAfterTicks: 0, bMoves: true },
      (getResult) => {
        it("reuses the eid", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.frameGap).toBe(0);
        });

        it("leaves the client with all of B, not only the components that changed", () => {
          const result = getResult();

          expect(result.after).toMatchObject({ team: B_TEAM });
          expect(result.differences).toEqual([]);
        });
      }
    );
  });

  describe("case 2: A is destroyed in one frame and B takes its eid in the next (quarantine off)", () => {
    describeScenario(
      "with acks that keep up and a clean link",
      { quarantine: "off", spawnAfterTicks: 1, ackIntervalMs: FAST_ACK_MS },
      (getResult) => {
        it("reuses the eid, and sends B's frame alone, without the removal the client already has", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.frameGap).toBe(1);
          expect(result.pullSpan).toBe(1);
        });

        it("leaves the client with B and exactly B's replicated components", () => {
          const result = getResult();

          expect(result.keptTheSameEntityObject).toBe(false);
          expectFreshB(result, "once");
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "with acks 2 or more frames late and a clean link",
      { quarantine: "off", spawnAfterTicks: 1, ackIntervalMs: FAST_ACK_MS, link: LATE_ACKS },
      (getResult) => {
        it("reuses the eid, and sends B's snapshots with the removal of A that the frame before carried", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.frameGap).toBe(1);
          expect(result.pullSpan).toBeGreaterThanOrEqual(3);
          const resets = result.wire.filter(
            (frame) =>
              frame.fromFrame !== 0 && frame.removed.length > 0 && frame.snapshots.length > 0
          );
          expect(resets.length).toBeGreaterThan(0);
          resets.forEach((frame) => {
            expect(frame.removed).toEqual([`${result.eid}:ALL`]);
            expect(frame.snapshots).toEqual([`${result.eid}:Position`, `${result.eid}:Team`]);
          });
        });

        it("leaves the client with B and exactly B's replicated components, as it was told of A's removal before", () => {
          const result = getResult();

          expect(result.keptTheSameEntityObject).toBe(false);
          expectFreshB(result, "overlapping deltas");
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "with acks that keep up, when the frame that removes A is lost",
      {
        quarantine: "off",
        spawnAfterTicks: 1,
        ackIntervalMs: FAST_ACK_MS,
        loseRemovalFrame: true,
      },
      (getResult) => {
        it("reuses the eid, and sends B's frame as a delta from before the removal, which carries it", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.wire.filter((frame) => frame.lost)).toHaveLength(1);
          expect(result.pullSpan).toBe(2);
          const bFrame = result.wire.find(
            (frame) => frame.fromFrame !== 0 && frame.snapshots.length > 0 && !frame.lost
          );
          expect(bFrame?.removed).toEqual([`${result.eid}:ALL`]);
        });

        it("leaves the client with B and exactly B's replicated components", () => {
          const result = getResult();

          expectFreshB(result, "overlapping deltas");
          expect(result.differences).toEqual([]);
        });

        it("builds B as a new entity, not on top of the entity the client holds for A", () => {
          const result = getResult();

          expect(result.keptTheSameEntityObject).toBe(false);
        });
      }
    );

    describeScenario(
      "with acks 2 or more frames late, when the frame that removes A is lost",
      {
        quarantine: "off",
        spawnAfterTicks: 1,
        ackIntervalMs: FAST_ACK_MS,
        link: LATE_ACKS,
        loseRemovalFrame: true,
      },
      (getResult) => {
        it("reuses the eid, and sends B's frame as a delta from before the removal, which carries it", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.wire.filter((frame) => frame.lost)).toHaveLength(1);
          expect(result.pullSpan).toBeGreaterThanOrEqual(3);
          const bFrame = result.wire.find(
            (frame) => frame.fromFrame !== 0 && frame.snapshots.length > 0 && !frame.lost
          );
          expect(bFrame?.removed).toEqual([`${result.eid}:ALL`]);
        });

        it("leaves the client with B and exactly B's replicated components", () => {
          const result = getResult();

          expectFreshB(result, "overlapping deltas");
          expect(result.differences).toEqual([]);
        });
      }
    );
  });

  describe("case 2 with the quarantine servers had before the fix: B takes A's eid 16 frames later, while the client is cut off", () => {
    describeScenario(
      "when the downlink is cut from the destroy for 20 frames, past the quarantine",
      {
        quarantine: "legacy",
        spawnAfterTicks: LEGACY_QUARANTINE_FRAMES,
        downOutage: [0, 20],
      },
      (getResult) => {
        it("reuses the eid while the client still holds A and has not been told it is gone", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.frameGap).toBe(LEGACY_QUARANTINE_FRAMES);
          expect(result.pullSpan).toBeGreaterThan(LEGACY_QUARANTINE_FRAMES);
          expect(result.resets).toBe(1);
          expect(result.before).toEqual(A_ON_CLIENT);
        });

        it("sends the first frame the client receives after the outage with B's snapshots and the removal of A", () => {
          const result = getResult();

          const firstDelivered = result.wire.find(
            (frame) => frame.fromFrame !== 0 && frame.snapshots.length > 0 && !frame.lost
          );
          expect(firstDelivered?.removed).toEqual([`${result.eid}:ALL`]);
          expect(firstDelivered?.snapshots).toEqual([
            `${result.eid}:Position`,
            `${result.eid}:Team`,
          ]);
        });

        it("leaves the client with B and exactly B's replicated components, on a new entity", () => {
          const result = getResult();

          expect(result.keptTheSameEntityObject).toBe(false);
          expectFreshB(result, "overlapping deltas");
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "when the downlink is cut for 10 frames, and restored before the eid comes back",
      {
        quarantine: "legacy",
        spawnAfterTicks: LEGACY_QUARANTINE_FRAMES,
        downOutage: [0, 10],
      },
      (getResult) => {
        it("leaves the client with B and exactly B's replicated components", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expectFreshB(result, "once");
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "when the downlink is cut for longer than the history, so the client is rebuilt from a baseline",
      {
        quarantine: "legacy",
        spawnAfterTicks: LEGACY_QUARANTINE_FRAMES,
        downOutage: [0, HISTORY_FRAMES + 20],
      },
      (getResult) => {
        it("rebuilds the client from a baseline, which leaves it with exactly B", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.resets).toBe(2);
          expectFreshB(result, "once");
          expect(result.differences).toEqual([]);
        });
      }
    );
  });

  describe("case 2 on a stock server: B takes A's eid historyFrames + 1 frames later, while the client is cut off", () => {
    describeScenario(
      "when the downlink is cut from the destroy until after the eid is handed out",
      {
        quarantine: "stock",
        spawnAfterTicks: STOCK_QUARANTINE_FRAMES,
        downOutage: [0, STOCK_QUARANTINE_FRAMES + 5],
      },
      (getResult) => {
        it("reuses the eid after A's removal has left the history, so the client is sent a baseline", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.frameGap).toBe(STOCK_QUARANTINE_FRAMES);
          expect(result.pullSpan).toBeGreaterThan(HISTORY_FRAMES);
          expect(result.before).toEqual(A_ON_CLIENT);
          const afterOutage = result.wire.filter((frame) => !frame.lost);
          expect(afterOutage.length).toBeGreaterThan(0);
          afterOutage.forEach((frame) => {
            expect(frame.fromFrame).toBe(0);
          });
        });

        it("rebuilds the client from that baseline, which leaves it with exactly B", () => {
          const result = getResult();

          expect(result.resets).toBe(2);
          expectFreshB(result, "once");
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "when the downlink is cut for 40 frames, and restored before the eid comes back",
      {
        quarantine: "stock",
        spawnAfterTicks: STOCK_QUARANTINE_FRAMES,
        downOutage: [0, 40],
      },
      (getResult) => {
        it("catches the client up with a delta that removes A, and later sends it B", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.resets).toBe(1);
          expectFreshB(result, "once");
          expect(result.differences).toEqual([]);
        });
      }
    );
  });

  describe("case 3: the client applies the removal of A and B's snapshots in one go", () => {
    describeScenario(
      "when a stock server's client stops rendering for longer than the quarantine, as a hidden tab does",
      {
        quarantine: "stock",
        spawnAfterTicks: STOCK_QUARANTINE_FRAMES,
        renderStall: [0, STOCK_QUARANTINE_FRAMES + 5],
      },
      (getResult) => {
        it("is sent the removal of A in one frame and B's snapshots in a later one, both received", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.frameGap).toBe(STOCK_QUARANTINE_FRAMES);
          expect(result.resets).toBe(1);
          const deltas = result.wire.filter((frame) => frame.fromFrame !== 0 && !frame.lost);
          const removal = deltas.find((frame) => frame.removed.length > 0);
          const creation = deltas.find((frame) => frame.snapshots.length > 0);
          expect(removal?.removed).toEqual([`${result.eid}:ALL`]);
          expect(removal?.snapshots).toEqual([]);
          expect(creation?.snapshots).toEqual([`${result.eid}:Position`, `${result.eid}:Team`]);
          expect(creation?.removed).toEqual([]);
        });

        it("leaves the client with B and exactly B's replicated components, on a new entity", () => {
          const result = getResult();

          expect(result.keptTheSameEntityObject).toBe(false);
          expectFreshB(result, "once");
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "when a stock server's client stops rendering for 40 frames, and resumes before the eid comes back",
      { quarantine: "stock", spawnAfterTicks: STOCK_QUARANTINE_FRAMES, renderStall: [0, 40] },
      (getResult) => {
        it("leaves the client with B and exactly B's replicated components", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expectFreshB(result, "once");
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "when a stock server's client stops rendering for longer than the quarantine and B keeps changing, as a bullet does",
      {
        quarantine: "stock",
        spawnAfterTicks: STOCK_QUARANTINE_FRAMES,
        renderStall: [0, STOCK_QUARANTINE_FRAMES + 5],
        bMoves: true,
      },
      (getResult) => {
        it("leaves the client with all of B, not only the components that changed", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.after).toMatchObject({ team: B_TEAM });
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "when the client stops rendering for 20 frames and the server still has the 16-frame quarantine",
      {
        quarantine: "legacy",
        spawnAfterTicks: LEGACY_QUARANTINE_FRAMES,
        renderStall: [0, 20],
      },
      (getResult) => {
        it("is sent the removal of A in one frame and B's snapshots in a later one, both received", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.frameGap).toBe(LEGACY_QUARANTINE_FRAMES);
          expect(result.resets).toBe(1);
          const deltas = result.wire.filter((frame) => frame.fromFrame !== 0 && !frame.lost);
          const removal = deltas.find((frame) => frame.removed.length > 0);
          const creation = deltas.find((frame) => frame.snapshots.length > 0);
          expect(removal?.removed).toEqual([`${result.eid}:ALL`]);
          expect(removal?.snapshots).toEqual([]);
          expect(creation?.snapshots).toEqual([`${result.eid}:Position`, `${result.eid}:Team`]);
          expect(creation?.removed).toEqual([]);
        });

        it("leaves the client with B and exactly B's replicated components, on a new entity", () => {
          const result = getResult();

          expect(result.keptTheSameEntityObject).toBe(false);
          expectFreshB(result, "once");
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "when the client stops rendering for 10 frames and resumes before the eid comes back (16-frame quarantine)",
      { quarantine: "legacy", spawnAfterTicks: LEGACY_QUARANTINE_FRAMES, renderStall: [0, 10] },
      (getResult) => {
        it("leaves the client with B and exactly B's replicated components", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expectFreshB(result, "once");
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "when the client stops rendering for 20 frames and B keeps changing, as a bullet does (16-frame quarantine)",
      {
        quarantine: "legacy",
        spawnAfterTicks: LEGACY_QUARANTINE_FRAMES,
        renderStall: [0, 20],
        bMoves: true,
      },
      (getResult) => {
        it("leaves the client with all of B, not only the components that changed", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.after).toMatchObject({ team: B_TEAM });
          expect(result.differences).toEqual([]);
        });
      }
    );

    describeScenario(
      "when B takes the eid in the next frame and the client's render loop stalls for 4 frames (quarantine off)",
      { quarantine: "off", spawnAfterTicks: 1, ackIntervalMs: FAST_ACK_MS, renderStall: [0, 4] },
      (getResult) => {
        it("reuses the eid, and sends B's frame alone", () => {
          const result = getResult();

          expect(result.reused).toBe(true);
          expect(result.pullSpan).toBe(1);
        });

        it("leaves the client with B and exactly B's replicated components", () => {
          const result = getResult();

          expectFreshB(result, "once");
          expect(result.differences).toEqual([]);
        });
      }
    );
  });
});

/**
 * The client holds B under the eid: B's replicated components and nothing of A's, on an entity
 * built after A's, which is what the client-local mark shows (A's is 1). `"once"` also requires
 * that it was built exactly once; `"overlapping deltas"` allows a rebuild for every delta whose
 * span included A's removal.
 */
function expectFreshB(result: HandoverResult, rebuilds: "once" | "overlapping deltas"): void {
  expect(result.after).toBeDefined();
  const { localSeq, ...replicated } = result.after as ClientEntityState;
  expect(replicated).toEqual(B_REPLICATED);
  if (rebuilds === "once") {
    expect(localSeq).toBe(2);
  } else {
    expect(localSeq).toBeGreaterThanOrEqual(2);
  }
}

/** Run `scenario` once for the tests `define` registers, which read its result. */
function describeScenario(
  title: string,
  scenario: Scenario,
  define: (getResult: () => HandoverResult) => void
): void {
  describe(title, () => {
    let result: HandoverResult;
    beforeAll(() => {
      result = runHandover(scenario);
    });
    define(() => result);
  });
}

/**
 * Entity A (Position and Health) is replicated to a client; A is destroyed and entity B (Position
 * and Team) is created `spawnAfterTicks` later, and the client is left to sort out the eid.
 */
function runHandover(scenario: Scenario): HandoverResult {
  const simulation = new ReplicationSim({
    networkComponents: NETWORK_COMPONENTS,
    link: scenario.link ?? symmetric({}),
    ackIntervalMs: scenario.ackIntervalMs,
  });
  try {
    return runOn(simulation, scenario);
  } finally {
    simulation.dispose();
  }
}

function runOn(simulation: ReplicationSim, scenario: Scenario): HandoverResult {
  const server = simulation.server;
  if (scenario.quarantine === "legacy") {
    setIdQuarantine(server, LEGACY_QUARANTINE_FRAMES);
  } else if (scenario.quarantine === "off") {
    setIdQuarantine(server, 0);
  }
  const client = simulation.addClient();

  const enters = new Map<number, number>();
  client.world.component(LocalMark);
  client.world
    .query("eid-reuse:mark")
    .with(Position)
    .enter((entity) => {
      const seq = (enters.get(entity.eid) ?? 0) + 1;
      enters.set(entity.eid, seq);
      entity.set(LocalMark, { seq });
    })
    .build();

  // Content in every frame, so the client's ack keeps up with the server.
  const heartbeat = server.entity().add(Networked).set(Position, { x: 0, y: 0 });
  for (let i = 0; i < 4; i++) {
    server.entity().add(Networked).set(Position, { x: i, y: i });
  }
  const a = server.entity().add(Networked).set(Position, A_POSITION).set(Health, { hp: A_HEALTH });
  const eid = a.eid;

  const wire = recordWire(client, eid);
  if (scenario.loseRemovalFrame) {
    loseFirstRemoval(client, eid, wire);
  }

  const destroyTick = WARMUP_TICKS;
  const spawnTick = destroyTick + scenario.spawnAfterTicks;
  let tick = 0;
  let b: Entity | undefined;
  let frameOfDestroy = 0;
  let frameOfSpawn = 0;
  let ackAtSpawn = 0;
  let beating = true;
  let moving = scenario.bMoves === true;

  const destroyA = (): void => {
    frameOfDestroy = server.frame;
    a.destroy();
  };
  const spawnB = (): void => {
    b = server.entity().add(Networked).set(Position, B_POSITION).set(Team, { id: B_TEAM });
    frameOfSpawn = server.frame;
    ackAtSpawn = ackedFrame(server);
  };

  if (scenario.via === "systems") {
    server
      .system("eid-reuse:destroy")
      .phase(ON_UPDATE)
      .run(() => {
        if (tick === destroyTick) {
          destroyA();
        }
      });
    server
      .system("eid-reuse:spawn")
      .phase(POST_UPDATE)
      .run(() => {
        if (tick === spawnTick) {
          spawnB();
        }
      });
  }

  simulation.onTick((now) => {
    tick = now;
    if (beating) {
      heartbeat.set(Position, { x: now, y: 0 });
    }
    if (b !== undefined && moving) {
      b.set(Position, { x: B_POSITION.x + (now - spawnTick), y: B_POSITION.y });
    }
    if (scenario.via !== "systems") {
      if (now === destroyTick) {
        destroyA();
      }
      if (now === spawnTick) {
        spawnB();
      }
    }
    const downOutage = scenario.downOutage;
    if (downOutage !== undefined) {
      if (now === destroyTick + downOutage[0]) {
        client.setBlocked("down", true);
      }
      if (now === destroyTick + downOutage[1]) {
        client.setBlocked("down", false);
      }
    }
    const renderStall = scenario.renderStall;
    if (renderStall !== undefined) {
      if (now === destroyTick + renderStall[0]) {
        stopRendering(client, true);
      }
      if (now === destroyTick + renderStall[1]) {
        stopRendering(client, false);
      }
    }
  });

  runUntilTick(simulation, destroyTick);
  const before = clientState(client, eid);
  const clientA = client.world.getEntity(eid);

  const windowEnd = Math.max(
    80,
    scenario.spawnAfterTicks + 10,
    (scenario.downOutage?.[1] ?? 0) + 10,
    (scenario.renderStall?.[1] ?? 0) + 10
  );
  runUntilTick(simulation, destroyTick + windowEnd);
  beating = false;
  moving = false;
  client.setBlocked("both", false);
  simulation.run(2_000);

  return {
    reused: b !== undefined && b.eid === eid,
    eid,
    frameGap: frameOfSpawn - frameOfDestroy,
    pullSpan: frameOfSpawn - ackAtSpawn,
    before,
    after: clientState(client, eid),
    keptTheSameEntityObject: clientA !== undefined && client.world.getEntity(eid) === clientA,
    wire,
    resets: client.stats.resets.length,
    differences: simulation.diffFromServer(client),
  };
}

/** Run the simulation until `tick` ticks have run. */
function runUntilTick(simulation: ReplicationSim, tick: number): void {
  while (simulation.ticks < tick) {
    simulation.run(simulation.tickMs / 2);
  }
}

/**
 * Make the entity pool hold a freed id for `frames` frames instead of the `historyFrames + 1` the
 * server built it with; no option allows less. Reaches into the pool, so call it before anything is
 * freed. The pool's wait buckets are sized for the stock wait, which is at least as many as `frames`.
 */
function setIdQuarantine(server: ServerWorld, frames: number): void {
  const pool = (server as unknown as { _entityPool: { reuseWaitFrames: number } })._entityPool;
  pool.reuseWaitFrames = frames;
}

/** The newest frame the server has had acked by the session; the harness has no public way to read it. */
function ackedFrame(server: ServerWorld): number {
  const sessions = (server as unknown as { _sessions: Map<string, { ackFrame: number }> })
    ._sessions;
  return [...sessions.values()][0].ackFrame;
}

/** Stop the client's render loop, as a hidden tab does, or resume it. The acks go on. */
function stopRendering(client: SimClient, stopped: boolean): void {
  const world = client.world as unknown as { progress?: () => void };
  if (stopped) {
    world.progress = (): void => undefined;
  } else {
    delete world.progress;
  }
}

/** Record every frame the server sends this client that mentions `eid`. */
function recordWire(client: SimClient, eid: number): WireFrame[] {
  const wire: WireFrame[] = [];
  const previousTap = client.down.tap;
  client.down.tap = (data) => {
    previousTap?.(data);
    const diff = new Decoder(data).read(Server2Client).diff;
    if (diff === undefined) {
      return;
    }
    const snapshots = diff.snapshots
      .map((encoded) => new Decoder(encoded.bytes).read(ComponentSnapshot))
      .filter((snapshot) => snapshot.eid === eid)
      .map((snapshot) => describeSnapshot(snapshot.eid, snapshot.wireType));
    const removed = diff.removed.filter(([id]) => id === eid).map(describeRemoval);
    if (snapshots.length > 0 || removed.length > 0) {
      wire.push({
        fromFrame: diff.fromFrame,
        toFrame: diff.toFrame,
        snapshots,
        removed,
        lost: client.down.blocked,
      });
    }
  };
  return wire;
}

/** Lose the first frame that removes `eid`, and mark it lost in `wire`. */
function loseFirstRemoval(client: SimClient, eid: number, wire: WireFrame[]): void {
  let lost = false;
  client.down.drop = (data) => {
    if (lost) {
      return false;
    }
    const diff = new Decoder(data).read(Server2Client).diff;
    if (diff === undefined || !diff.removed.some(([id]) => id === eid)) {
      return false;
    }
    lost = true;
    wire[wire.length - 1].lost = true;
    return true;
  };
}

function clientState(client: SimClient, eid: number): ClientEntityState | undefined {
  const entity = client.world.getEntity(eid);
  if (entity === undefined) {
    return undefined;
  }
  const position = entity.get(Position);
  return {
    position: position === undefined ? undefined : { x: position.x, y: position.y },
    health: entity.get(Health)?.hp,
    team: entity.get(Team)?.id,
    localSeq: entity.get(LocalMark)?.seq,
  };
}

const WIRE_TYPE_NAMES = ["", "Position", "Health", "Team"];

function describeSnapshot(eid: number, wireTypeId: number): string {
  return `${eid}:${WIRE_TYPE_NAMES[wireTypeId]}`;
}

function describeRemoval([eid, wireTypeId]: RemovedComponent): string {
  return wireTypeId === ALL_COMPONENTS ? `${eid}:ALL` : describeSnapshot(eid, wireTypeId);
}
