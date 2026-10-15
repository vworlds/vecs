import { ON_STORE } from "@vworlds/vecs";
import {
  Motion,
  phaserMotionComponents,
  phaserNetworkComponents,
  Position,
  Rotation,
} from "@vworlds/vecs-phaser";
import {
  Body,
  BodyType,
  Circle,
  LinearVelocity,
  PhysicsModule,
  preloadPhysics,
  Position as PhysicsPosition,
} from "@vworlds/vecs-physics";
import { Networked } from "@vworlds/vecs-server";
import { Server2Client } from "@vworlds/vecs-protocol";
import { Decoder } from "@vworlds/vecs-wire";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DeadReckonedModule as ClientMotion } from "../../vecs-phaser-client/src/modules/dead_reckoned.js";
import { phaserInterpolators } from "../../vecs-phaser-client/src/sync.js";
import { ReplicationSim } from "../../vecs-server/tests/harness/replication_sim.js";
import { symmetric } from "../../vecs-server/tests/harness/lossy_link.js";
import { DeadReckoned, DeadReckonedModule, DeadReckonedMoving } from "../src/dead_reckoned.js";

let sim: ReplicationSim | undefined;
beforeAll(preloadPhysics);
afterEach(() => {
  sim?.dispose();
  sim = undefined;
});

describe("idle keepalive end to end", () => {
  it.each([
    { phase: "in-time", oneWayMs: 20, compacted: false },
    { phase: "compacted", oneWayMs: 11, compacted: true },
  ])("resumes smoothly in the $phase phase", ({ phase, oneWayMs, compacted }) => {
    // #271: 59 Hz avoids a now == tServ boundary. With seed 7, 11 ms arrivals
    // compact before the due pull; 20 ms arrivals leave the first slot intact.
    // The due pull is 1.69 ms past its deadline, rather than a rounding epsilon.
    const run = resumeRig(oneWayMs, true);
    sim = run.sim;
    let previousFrame = 0;
    let previousX = 1;
    let first:
      { baselineFrame: number; renderFrame: number; errorX: number; atMs: number } | undefined;
    let completed: { renderFrame: number; x: number } | undefined;
    run.client.world
      .system("resume.observe")
      .phase(ON_STORE)
      .run(() => {
        const renderFrame = run.client.world.renderFrame;
        expect(renderFrame).toBeGreaterThanOrEqual(previousFrame);
        previousFrame = renderFrame;
        const seen = run.client.world.getEntity(run.body.eid);
        if (seen === undefined) {
          return;
        }
        const x = seen.get(Position)!.x;
        expect(x).toBeGreaterThanOrEqual(previousX);
        previousX = x;
        const motion = seen.get(Motion)!;
        const track = seen.components
          .values()
          .find((value) => value.constructor.name === "MotionTrack") as { errorX: number };
        if (!motion.rest && first === undefined) {
          first = {
            baselineFrame: motion.frame,
            renderFrame,
            errorX: track.errorX,
            atMs: run.sim.clock.now,
          };
        }
        if (
          first !== undefined &&
          completed === undefined &&
          run.sim.clock.now - first.atMs >= 100
        ) {
          expect(track.errorX).toBe(0);
          completed = { renderFrame, x };
        }
      });
    sim.run(3000);
    const held = run.client.world.renderFrame;
    sim.run(1000);
    expect(run.client.world.renderFrame).toBe(held);
    const baselinesBefore = run.client.stats.baselinesSent.length;
    run.body.set(LinearVelocity, { x: 1 });
    sim.run(500);
    expect(first!.renderFrame - first!.baselineFrame).toBeLessThan(compacted ? 2 : 1);
    if (compacted) {
      expect(Math.abs(first!.errorX)).toBeGreaterThan(0);
      expect(Math.abs(first!.errorX)).toBeLessThan(1);
    } else {
      expect(first!.errorX).toBe(0);
    }
    expect(run.client.stats.baselinesSent.length).toBe(baselinesBefore);
    expect(run.client.stats.gapReportsSent).toBe(0);
    expect(run.client.stats.errors).toEqual([]);
    expect(run.client.stats.disconnects).toEqual([]);
    const sample = completed!;
    expect(sample.renderFrame).toBeGreaterThan(first!.renderFrame);
    sim.dispose();
    const control = resumeRig(oneWayMs, false);
    sim = control.sim;
    sim.run(4000);
    control.body.set(LinearVelocity, { x: 1 });
    sim.run(500);
    // Sample the ungated client's extrapolator at the exact replicated-state
    // clock of the completed gated blend, rather than comparing different times.
    const clock = vi
      .spyOn(control.client.world, "renderFrame", "get")
      .mockReturnValue(sample.renderFrame);
    control.client.world.progress(sim.clock.now, 0);
    expect(sample.x).toBeCloseTo(
      control.client.world.getEntity(control.body.eid)!.get(Position)!.x,
      6
    );
    clock.mockRestore();
    console.log(
      "IDLE_RESUME",
      JSON.stringify({
        phase,
        sentFrame: first!.baselineFrame,
        appliedRenderFrame: first!.renderFrame,
      })
    );
  });

  it.each([
    { kind: "handoff", lost: false },
    { kind: "handoff", lost: true },
    { kind: "late correction", lost: false },
    { kind: "late correction", lost: true },
  ])("finishes a $kind through a pause (first change lost: $lost)", ({ kind, lost }) => {
    sim = new ReplicationSim({
      networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
      seed: 7,
      link: symmetric({ oneWayMs: 20 }),
      serverOptions: { keepAliveFrames: 1, redundancyFrames: 1 },
    });
    sim.server.module(PhysicsModule, { fixedTimeStep: 1 / 30, gravity: { x: 0, y: 0 } });
    sim.server.module(DeadReckonedModule);
    // Drive wire baselines explicitly so the late correction and hand-off have known errors.
    const body = sim.server
      .entity()
      .add(Networked)
      .add(DeadReckonedMoving)
      .set(Motion, { frame: 1, x: 0, y: 0, vx: 1, rest: false });
    const client = sim.addClient({ interpolators: phaserInterpolators() });
    client.world.module(ClientMotion);
    let previous = 0;
    let blending = false;
    client.world
      .system("observe.motion")
      .phase(ON_STORE)
      .run(() => {
        const frame = client.world.renderFrame;
        expect(frame).toBeGreaterThanOrEqual(previous);
        previous = frame;
        const seen = client.world.getEntity(body.eid);
        const track = (seen?.components.values() ?? []).find(
          (value) => value.constructor.name === "MotionTrack"
        ) as { errorX: number; frame: number } | undefined;
        if (track && track.errorX !== 0) {
          blending = true;
        }
      });
    sim.run(1000);
    const frame = sim.server.frame;
    const target = (frame - 1) / 30 + 0.15;
    const tap = client.down.tap;
    let dropped = 0;
    client.down.tap = (data) => {
      tap?.(data);
      const diff = new Decoder(data).read(Server2Client).diff;
      if (lost && diff?.toFrame === frame) {
        client.down.blocked = true;
        dropped++;
      }
    };
    body.remove(DeadReckonedMoving);
    if (kind === "handoff") {
      body.remove(Motion);
      body.set(Position, { x: target, y: 0 }).set(Rotation, { angle: 0 });
    } else {
      body.set(Motion, { frame: frame - 3, x: target, y: 0, rest: true });
    }
    sim.run(120);
    client.down.blocked = false;
    sim.run(1880);
    expect(dropped).toBe(lost ? 1 : 0);
    expect(blending).toBe(true);
    const seen = client.world.getEntity(body.eid)!;
    expect(seen.get(Position)!.x).toBeCloseTo(target, 6);
    if (kind === "handoff") {
      expect(
        seen.components.values().some((value) => value.constructor.name === "MotionTrack")
      ).toBe(false);
    }
    const paused = client.stats.framesSent;
    const held = client.world.renderFrame;
    sim.run(1000);
    expect(client.stats.framesSent).toBe(paused);
    expect(client.world.renderFrame).toBe(held);

    expect(client.stats.baselinesSent).toHaveLength(1);
    expect(client.stats.errors).toEqual([]);
  });

  it.each([false, true])("measures downstream idle cadence (idleKeepAlive=%s)", (idleKeepAlive) => {
    sim = new ReplicationSim({
      networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
      seed: 7,
      link: symmetric({ oneWayMs: 100 }),
      serverOptions: { keepAliveFrames: 1 },
    });
    sim.server.module(PhysicsModule, { fixedTimeStep: 1 / 30 });
    sim.server.module(DeadReckonedModule, { idleKeepAlive });
    const client = sim.addClient();
    client.world.module(ClientMotion);
    sim.run(2000);
    const before = client.stats.framesSent;
    const tail = client.stats.deltasSent.length;
    sim.run(1000.1);
    const fps = client.stats.framesSent - before;
    expect(fps).toBe(idleKeepAlive ? 0 : 30);
    if (idleKeepAlive) {
      expect(tail).toBe(0);
    }
    console.log("IDLE_CADENCE", JSON.stringify({ idleKeepAlive, fps, tail }));
  });
});

describe("render-loop stalls across an idle pause", () => {
  it.each(["rest correction", "handoff"])(
    "finishes a 300 ms $kind with no further downstream frames",
    (kind) => {
      sim = new ReplicationSim({
        networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
        seed: 7,
        link: symmetric({ oneWayMs: 20 }),
        serverOptions: { keepAliveFrames: 1, redundancyFrames: 2 },
      });
      sim.server.module(PhysicsModule, { fixedTimeStep: 1 / 30, gravity: { x: 0, y: 0 } });
      sim.server.module(DeadReckonedModule);
      const body = sim.server
        .entity()
        .add(Networked)
        .add(DeadReckonedMoving)
        .set(Motion, { frame: 1, x: 0, vx: 0.3, rest: false });
      const client = sim.addClient({ interpolators: phaserInterpolators() });
      client.world.module(ClientMotion, { blendMs: 300 });
      sim.run(1000);
      const stalledPose = client.world.getEntity(body.eid)!.get(Position)!.x;
      const target = Math.fround(stalledPose + 0.2);
      // Stop only progress: receives and ACKs continue, as in a backgrounded tab.
      const render = vi.spyOn(client.world, "progress").mockImplementation(() => {});
      body.remove(DeadReckonedMoving);
      if (kind === "handoff") {
        body.remove(Motion);
        body.set(Position, { x: target }).set(Rotation, { angle: 0 });
      } else {
        body.set(Motion, { frame: sim.server.frame - 3, x: target, rest: true });
      }
      sim.run(1000);
      const pausedFrames = client.stats.framesSent;
      sim.run(500);
      expect(client.stats.framesSent).toBe(pausedFrames);
      render.mockRestore();
      // Resume explicitly with the real elapsed loop delta, not the harness's
      // normal 60 Hz delta. No server frame arrives during these render samples.
      client.world.progress(sim.clock.now, 1500);
      const seen = client.world.getEntity(body.eid)!;
      const firstPose = seen.get(Position)!.x;
      const heldFrame = client.world.renderFrame;
      const motionTrack = seen.components
        .values()
        .find((value) => value.constructor.name === "MotionTrack") as {
        errorX: number;
        blendFrom: number;
      };
      // The entire captured path error must be visible on its first sample.
      expect(firstPose).toBeCloseTo(target + motionTrack.errorX, 6);
      expect(Math.abs(firstPose - target)).toBeGreaterThan(0);
      expect(Math.abs(firstPose - target)).toBeLessThan(1);
      client.world.progress(sim.clock.now + 150, 150);
      expect(seen.get(Position)!.x).toBeCloseTo(target + (firstPose - target) / 2, 6);
      client.world.progress(sim.clock.now + 299, 149);
      expect(seen.get(Position)!.x).not.toBe(target);
      client.world.progress(sim.clock.now + 300, 1);
      expect(client.world.renderFrame).toBe(heldFrame);
      expect(client.stats.framesSent).toBe(pausedFrames);
      expect(seen.get(Position)!.x).toBe(target);
      if (kind === "handoff") {
        expect(
          seen.components.values().some((value) => value.constructor.name === "MotionTrack")
        ).toBe(false);
      }
      expect(client.stats.baselinesSent).toHaveLength(1);
      expect(client.stats.gapReportsSent).toBe(0);
      expect(client.stats.errors).toEqual([]);
    }
  );
});

function resumeRig(oneWayMs: number, idleKeepAlive: boolean) {
  const simulation = new ReplicationSim({
    networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
    seed: 7,
    renderHz: 59,
    link: symmetric({ oneWayMs }),
    serverOptions: { keepAliveFrames: 1, redundancyFrames: 1 },
  });
  simulation.server.module(PhysicsModule, { fixedTimeStep: 1 / 30, gravity: { x: 0, y: 0 } });
  simulation.server.module(DeadReckonedModule, { idleKeepAlive });
  const body = simulation.server
    .entity()
    .add(Networked)
    .add(DeadReckoned)
    .set(Body, { type: BodyType.Dynamic })
    .set(PhysicsPosition, { x: 1 });
  simulation.server.entity().childOf(body).set(Circle, { radius: 0.5 });
  const client = simulation.addClient({ interpolators: phaserInterpolators() });
  client.world.module(ClientMotion);
  return { sim: simulation, body, client };
}
