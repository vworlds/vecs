import { describe, expect, it } from "vitest";
import { wireType } from "@vworlds/vecs-wire";
import type { Entity } from "@vworlds/vecs";
import { Networked } from "../src/index.js";
import { symmetric, type DuplexConditions } from "./harness/lossy_link.js";
import { ReplicationSim, type SimClient } from "./harness/replication_sim.js";

// An entity that leaves a session's view and comes back is the case the server resets and a
// client has to rebuild, with no id reuse involved: the client held the entity, the server
// removes it from the view in one frame and shows it again in a later one, and what the entity
// lost while it was out of sight must be gone on the client. A delta starts at the newest acked
// frame, so a client whose acks lag receives the reset in every delta that overlaps, and rebuilds
// the entity exactly once, as a client that acks at once does.

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

/** A tag the session's view requires: an entity without it is out of sight. */
class Visible {}

/** Ticks before the entity leaves, enough for the client to take its baseline and settle. */
const WARMUP_TICKS = 45;

/** Ack timer fast enough that every ack reaches the server before its next tick (a 33 ms tick). */
const FAST_ACK_MS = 8;

/** Client-to-server delay that makes the acks lag the server by about `frames` frames (a 33 ms tick). */
function ackLag(frames: number): DuplexConditions {
  return { down: {}, up: { oneWayMs: frames * 33.4 + 4 } };
}

const LAGS = [0, 2, 5] as const;

/** Frames between the entity leaving the view and entering it again. */
const GAPS = [1, 3] as const;

interface Outcome {
  /** Replicated entities that entered the client's world after the entity left, all of them. */
  enters: number;
  /** Replicated entities that left the client's world after the entity left, all of them. */
  exits: number;
  /** The entity the client holds is the one it held before the entity left the view. */
  keptTheSameEntity: boolean;
  /** What the client holds of the entity at the end. */
  position: { x: number; y: number } | undefined;
  health: number | undefined;
  /** Differences between the server's state and the client's at the end. */
  differences: string[];
  /** The span of the delta the server sent in the frame the entity came back, in frames. */
  pullSpan: number;
}

describe("an entity that leaves a session's view and returns", () => {
  describe.each(LAGS)("with the client's acks about %i frames late", (lag) => {
    describe.each(GAPS)("coming back %i frames later", (gap) => {
      it("is rebuilt on the client exactly once", () => {
        const outcome = run(lag, gap);

        expect(outcome.enters).toBe(1);
        expect(outcome.exits).toBe(1);
        expect(outcome.keptTheSameEntity).toBe(false);
      });

      it("comes back without the component it lost while it was out of sight", () => {
        const outcome = run(lag, gap);

        expect(outcome.health).toBeUndefined();
        expect(outcome.position).toEqual({ x: 9, y: 9 });
        expect(outcome.differences).toEqual([]);
      });

      it("is sent in a delta that spans the lag", () => {
        const outcome = run(lag, gap);

        // The delta for the frame the entity returned in starts at the newest ack, so the more
        // the acks lag, the more frames it spans, and the more of them hold the reset.
        expect(outcome.pullSpan).toBeGreaterThanOrEqual(lag === 0 ? 1 : lag);
      });
    });
  });
});

function run(lag: number, gap: number): Outcome {
  const simulation = new ReplicationSim({
    networkComponents: [Position, Health],
    view: [Visible],
    link: lag === 0 ? symmetric({}) : ackLag(lag),
    ackIntervalMs: FAST_ACK_MS,
  });
  try {
    return runOn(simulation, gap);
  } finally {
    simulation.dispose();
  }
}

function runOn(simulation: ReplicationSim, gap: number): Outcome {
  const server = simulation.server;
  server.component(Visible);
  const client = simulation.addClient();

  // Content in every frame, so the client's ack keeps up with the server.
  const heartbeat = server.entity().add(Networked).add(Visible).set(Position, { x: 0, y: 0 });
  const entity = server
    .entity()
    .add(Networked)
    .add(Visible)
    .set(Position, { x: 1, y: 2 })
    .set(Health, { hp: 55 });

  const leaveTick = WARMUP_TICKS;
  const returnTick = leaveTick + gap;
  let frameOfReturn = 0;
  let ackAtReturn = 0;
  let beating = true;

  simulation.onTick((tick) => {
    if (beating) {
      heartbeat.set(Position, { x: tick, y: 0 });
    }
    if (tick === leaveTick) {
      entity.remove(Visible);
    }
    if (tick === leaveTick + 1) {
      // It lost its Health while out of sight, and moves: the server tells the session nothing.
      entity.remove(Health);
      entity.set(Position, { x: 9, y: 9 });
    }
    if (tick === returnTick) {
      entity.add(Visible);
      frameOfReturn = server.frame;
      ackAtReturn = ackedFrame(server);
    }
  });

  runUntilTick(simulation, leaveTick);
  const before = { enters: client.stats.enters, exits: client.stats.exits };
  const held = client.world.getEntity(entity.eid);
  expect(held).toBeDefined();

  runUntilTick(simulation, returnTick + 40);
  beating = false;
  simulation.run(2_000);

  return {
    enters: client.stats.enters - before.enters,
    exits: client.stats.exits - before.exits,
    keptTheSameEntity: client.world.getEntity(entity.eid) === held,
    position: positionOf(client, entity),
    health: client.world.getEntity(entity.eid)?.get(Health)?.hp,
    differences: simulation.diffFromServer(client),
    pullSpan: frameOfReturn - ackAtReturn,
  };
}

function positionOf(client: SimClient, entity: Entity): { x: number; y: number } | undefined {
  const position = client.world.getEntity(entity.eid)?.get(Position);
  return position === undefined ? undefined : { x: position.x, y: position.y };
}

/** Run the simulation until `tick` ticks have run. */
function runUntilTick(simulation: ReplicationSim, tick: number): void {
  while (simulation.ticks < tick) {
    simulation.run(simulation.tickMs / 2);
  }
}

/** The newest frame the server has had acked by the session; the harness has no public way to read it. */
function ackedFrame(server: ReplicationSim["server"]): number {
  const sessions = (server as unknown as { _sessions: Map<string, { ackFrame: number }> })
    ._sessions;
  return [...sessions.values()][0].ackFrame;
}
