import { afterEach, describe, expect, it } from "vitest";
import { Server2Client } from "@vworlds/vecs-protocol";
import { Decoder, wireType } from "@vworlds/vecs-wire";
import { Networked } from "../src/index.js";
import { ReplicationSim } from "./harness/replication_sim.js";
import { symmetric } from "./harness/lossy_link.js";

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

const HARSH_LINK = symmetric({ oneWayMs: 100, loss: 0.05, reorder: 0.1, reorderExtraMs: 60 });
let sim: ReplicationSim | undefined;
class Moving {}

afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

describe("gated idle keepalives over the lossy harness", () => {
  it("R=2 repeats the last change before pausing when its first send is lost, without fallback", () => {
    sim = new ReplicationSim({
      networkComponents: [Position, Health],
      seed: 7,
      link: symmetric({ oneWayMs: 20 }),
      serverOptions: { keepAliveFrames: 1, redundancyFrames: 2 },
    });
    sim.server.component(Moving);
    sim.server.keepAliveWhile(Moving);
    const body = sim.server.entity().add(Networked).set(Position, { x: 1 });
    const client = sim.addClient();
    sim.run(2000);
    const messages: Server2Client[] = [];
    const fallback: number[] = [];
    const server = sim.server as unknown as { _sessions: Map<string, { fallbackFrame?: number }> };
    sim.onTick(() =>
      server._sessions.forEach((session) => {
        if (session.fallbackFrame !== undefined) {
          fallback.push(session.fallbackFrame);
        }
      })
    );
    const tap = client.down.tap;
    client.down.tap = (data) => {
      tap?.(data);
      const message = new Decoder(data).read(Server2Client);
      messages.push(message);
      if (messages.length === 1) {
        client.down.blocked = true;
        sim!.clock.schedule(sim!.clock.now + 1, () => {
          client.down.blocked = false;
        });
      }
    };
    body.set(Position, { x: 9 });
    sim.run(1000);
    expect(messages[0]!.diff!.snapshots).toHaveLength(1);
    expect(messages[1]!.diff!.toFrame).toBe(messages[0]!.diff!.toFrame + 1);
    // The next K=1 carrier includes the R=2 repeat, rather than an empty clock frame.
    expect(messages[1]!.diff!.snapshots).toEqual(messages[0]!.diff!.snapshots);
    expect(sim.diffFromServer(client)).toEqual([]);
    expect(fallback).toEqual([]);
    expect(client.stats.gapReportsSent).toBe(0);
    expect(client.stats.baselinesSent).toHaveLength(1);
    const paused = client.stats.framesSent;
    sim.run(1000);
    expect(client.stats.framesSent).toBe(paused);
  });
  it.each([undefined, 1, 2, 3])(
    "pauses and resumes without gaps, fallbacks or extra baselines (R=%s)",
    (redundancyFrames) => {
      sim = new ReplicationSim({
        networkComponents: [Position, Health],
        seed: 7,
        link: HARSH_LINK,
        serverOptions: { keepAliveFrames: 1, redundancyFrames },
      });
      sim.server.component(Moving);
      sim.server.keepAliveWhile(Moving);
      const body = sim.server.entity().add(Networked).set(Position, { x: 1 });
      const client = sim.addClient();
      const fallback = [] as number[];
      const server = sim.server as unknown as {
        _sessions: Map<string, { fallbackFrame?: number }>;
      };
      sim.onTick(() =>
        server._sessions.forEach((session) => {
          if (session.fallbackFrame !== undefined) {
            fallback.push(session.fallbackFrame);
          }
        })
      );
      sim.run(2000);
      const paused = client.stats.framesSent;
      sim.run(3000);
      expect(client.stats.framesSent).toBe(paused);
      body.add(Moving).set(Position, { x: 2 });
      sim.run(1000);
      expect(client.stats.framesSent).toBeGreaterThan(paused + 20);
      body.remove(Moving);
      body.set(Position, { x: 3 });
      sim.run(2000);
      const settled = client.stats.framesSent;
      sim.run(3000);
      expect(client.stats.framesSent).toBe(settled);
      expect(client.stats.gapReportsSent).toBe(0);
      expect(fallback).toEqual([]);
      expect(client.stats.baselinesSent).toHaveLength(1);
      expect(sim.diffFromServer(client)).toEqual([]);
    }
  );

  it.each([undefined, 1, 2, 3])(
    "recovers content lost at the pause edge (R=%s)",
    (redundancyFrames) => {
      sim = new ReplicationSim({
        networkComponents: [Position, Health],
        seed: 7,
        link: symmetric({ oneWayMs: 50 }),
        serverOptions: { keepAliveFrames: 1, redundancyFrames },
      });
      sim.server.component(Moving);
      sim.server.keepAliveWhile(Moving);
      const body = sim.server.entity().add(Networked).set(Position, { x: 1 });
      const client = sim.addClient();
      sim.run(2000);
      client.setBlocked("down", true);
      body.set(Position, { x: 9 });
      sim.run(150);
      client.setBlocked("down", false);
      sim.run(2000);
      expect(sim.diffFromServer(client)).toEqual([]);
      expect(client.stats.baselinesSent).toHaveLength(1);
      const paused = client.stats.framesSent;
      sim.run(1000);
      expect(client.stats.framesSent).toBe(paused);
    }
  );
});
