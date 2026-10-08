// The client extrapolator: DeadReckonedModule turns each Motion baseline into a client-local render
// pose at ClientWorld.renderFrame. These tests drive renderFrame directly; the end-to-end runs
// against a real server are in lib/vecs-phaser-server/tests/dead_reckoning_replication.test.ts.

import { ON_UPDATE, World } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  Arc,
  Motion,
  MotionClock,
  MotionPose,
  MotionState,
  motionPose,
  motionStateFrom,
  Offset,
  phaserMotionComponents,
  phaserNetworkComponents,
  Position,
  Rotation,
  stepMotion,
} from "@vworlds/vecs-phaser";
import { describe, expect, it, vi } from "vitest";

import { DeadReckonedModule, PhaserRenderModule } from "../../src/index.js";
import type { DeadReckonedModuleConfig } from "../../src/index.js";
import { createMockScene } from "../mock_phaser.js";
import {
  expectPose,
  expectRendered,
  gameObjectOf,
  lastCall,
  PPM,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  spawnChild,
} from "./parenting_fixtures.js";

const CLOCK: Partial<MotionClock> = {
  stepSeconds: Math.fround(1 / 30),
  subSteps: 4,
  gravityX: 0,
  gravityY: 0,
  maxLinearSpeed: 400,
};

/** A drifting, spinning, damped body. */
const DRIFT: Partial<Motion> = {
  frame: 10,
  x: 1,
  y: 2,
  angle: 0.25,
  vx: 3,
  vy: -1,
  w: 0.5,
  linearDamping: 0.15,
  angularDamping: 0.1,
};

/** A ClientWorld with dead reckoning and a `renderFrame` the test sets. */
class Client {
  public readonly world: ClientWorld;
  public frame = 0;
  private _now = 0;

  public constructor(config?: DeadReckonedModuleConfig, render = false) {
    this.world = new ClientWorld({
      networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
    });
    vi.spyOn(this.world, "renderFrame", "get").mockImplementation(() => this.frame);
    if (render) {
      // Installed first, so only the phase order can put the extrapolator ahead of it.
      const scene = createMockScene(SCENE_WIDTH, SCENE_HEIGHT);
      this.world.module(PhaserRenderModule, { scene, pixelsPerMeter: PPM });
    }
    this.world.module(DeadReckonedModule, config ?? {});
    this.world.entity().set(MotionClock, CLOCK);
  }

  /** Render one frame at `renderFrame`. */
  public render(renderFrame: number): void {
    this.frame = renderFrame;
    this.world.progress(this._now, 16);
    this._now += 16;
  }
}

describe("DeadReckonedModule (client)", () => {
  it("gives a body that arrives with only a baseline a render pose, extrapolated at renderFrame", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, DRIFT);

    client.render(10);
    expect(body.has(Position)).toBe(true);
    expect(body.has(Rotation)).toBe(true);
    expectPose(body, pathAt(DRIFT, 10));

    client.render(13.5);
    expectPose(body, pathAt(DRIFT, 13.5));

    client.render(14.25);
    expectPose(body, pathAt(DRIFT, 14.25));
  });

  it("catches up a baseline from long ago in one frame", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, DRIFT);

    client.render(310.5);

    expectPose(body, pathAt(DRIFT, 310.5));
  });

  it("holds a body at rest", () => {
    const client = new Client();
    const body = client.world
      .entity()
      .set(Motion, { frame: 3, x: -4, y: 5, angle: 1, gravityScale: 0 });

    client.render(3);
    client.render(90.5);

    expectPose(body, { x: -4, y: 5 });
    expect(body.get(Rotation)!.angle).toBeCloseTo(1, 4);
  });

  it("ignores a baseline older than the one it holds", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, { ...DRIFT, frame: 20 });
    client.render(20.5);

    body.set(Motion, { ...DRIFT, frame: 15, vx: -8 });
    client.render(21);

    expectPose(body, pathAt({ ...DRIFT, frame: 20 }, 21));
  });

  it("applies a correction received in time at once", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, DRIFT);
    client.render(19.6);

    const correction = { ...DRIFT, frame: 20, x: 30, y: 2.5, vx: 1 };
    body.set(Motion, correction);
    client.render(20.2);

    expectPose(body, pathAt(correction, 20.2));
  });

  it("blends a late correction out over 100 ms", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, DRIFT);
    client.render(20);

    // Frame 18's correction arrives while frame 20.5 renders: 2.5 frames late, 0.3 m off.
    const late = { ...pathMotion(DRIFT, 18), x: pathMotion(DRIFT, 18).x + 0.3 };
    body.set(Motion, late);
    client.render(20.5);
    expectPose(body, pathAt(DRIFT, 20.5)); // no jump

    client.render(22); // 50 ms later: half the error left
    const halfway = pathAt(late, 22);
    const old = pathAt(DRIFT, 20.5);
    const fresh = pathAt(late, 20.5);
    // stepSeconds is an f32, so "half" is half to within 1e-7.
    expect(body.get(Position)!.x).toBeCloseTo(halfway.x + 0.5 * (old.x - fresh.x), 6);
    expect(body.get(Position)!.y).toBeCloseTo(halfway.y + 0.5 * (old.y - fresh.y), 6);

    client.render(23.5); // 100 ms later: on the new path
    expectPose(body, pathAt(late, 23.5));
  });

  it("snaps a late correction above 1 m or 0.5 rad, and takes other limits from its options", () => {
    const far = new Client();
    const turned = new Client();
    const tolerant = new Client({ snapDistance: 5, blendMs: 200 });
    const bodies = [far, turned, tolerant].map((client) => {
      const body = client.world.entity().set(Motion, DRIFT);
      client.render(20);
      return body;
    });
    const base = pathMotion(DRIFT, 18);
    const corrections = [
      { ...base, x: base.x + 1.5 },
      { ...base, angle: base.angle + 0.6 },
      { ...base, x: base.x + 1.5 },
    ];

    [far, turned, tolerant].forEach((client, i) => {
      bodies[i]!.set(Motion, corrections[i]!);
      client.render(20.5);
    });

    expectPose(bodies[0]!, pathAt(corrections[0]!, 20.5));
    expectPose(bodies[1]!, pathAt(corrections[1]!, 20.5));
    expectPose(bodies[2]!, pathAt(DRIFT, 20.5));
    tolerant.render(25); // 150 ms of 200: a quarter of the error left
    expect(bodies[2]!.get(Position)!.x).toBeCloseTo(pathAt(corrections[2]!, 25).x - 0.25 * 1.5, 2);
  });

  it("extrapolates nothing until the MotionClock arrives", () => {
    const world = new ClientWorld({
      networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
    });
    let frame = 12;
    vi.spyOn(world, "renderFrame", "get").mockImplementation(() => frame);
    world.module(DeadReckonedModule);
    const body = world.entity().set(Motion, DRIFT);

    world.progress(0, 16);
    expectPose(body, { x: 0, y: 0, angle: 0 });

    world.entity().set(MotionClock, CLOCK);
    frame = 12.5;
    world.progress(16, 16);
    expectPose(body, pathAt(DRIFT, 12.5));
  });

  it("writes the pose before gameplay and render systems, so a DrawBy child keeps up in the same frame", () => {
    const client = new Client(undefined, true);
    const parent = client.world.entity().set(Motion, DRIFT).set(Arc, { radius: 0.5 });
    const child = spawnChild(client.world, parent, { offset: { x: 1, y: 0.5 } });
    const seen: Array<{ x: number; y: number }> = [];
    client.world
      .system("test.gameplay")
      .with(Motion, Position)
      .phase(ON_UPDATE)
      .each([Position], (_entity, [position]) => {
        seen.push({ x: position.x, y: position.y });
      });

    for (const renderFrame of [10, 11.5, 12.25]) {
      client.render(renderFrame);
      const pose = pathAt(DRIFT, renderFrame);
      expect(seen[seen.length - 1]!.x).toBeCloseTo(pose.x, 9);
      expectPose(child, { x: pose.x + 1, y: pose.y + 0.5 });
      expectRendered(gameObjectOf(parent), pose);
      expect(lastCall(gameObjectOf(child), "setPosition")).toEqual([
        expect.closeTo(SCENE_WIDTH / 2 + PPM * (pose.x + 1), 6),
        expect.closeTo(SCENE_HEIGHT / 2 - PPM * (pose.y + 0.5), 6),
      ]);
    }
  });

  it("does not interfere with an entity's Offset or with entities without Motion", () => {
    const client = new Client();
    const plain = client.world.entity().set(Position, { x: 7, y: 8 }).set(Offset, { x: 1, y: 1 });

    client.render(30);

    expectPose(plain, { x: 7, y: 8 });
    expect(plain.has(Rotation)).toBe(false);
  });

  it("requires a ClientWorld with the motion components on the wire", () => {
    expect(() => new World().module(DeadReckonedModule)).toThrow(/ClientWorld/);
    const streamedOnly = new ClientWorld({ networkComponents: phaserNetworkComponents });
    expect(() => streamedOnly.module(DeadReckonedModule)).toThrow(/phaserMotionComponents/);
  });
});

/** The baseline's own path at `renderFrame`, sampled the way the extrapolator samples it. */
function pathAt(
  baseline: Partial<Motion>,
  renderFrame: number
): { x: number; y: number; angle: number } {
  const motion = Object.assign(new Motion(), baseline);
  const clock = Object.assign(new MotionClock(), CLOCK);
  const elapsed = renderFrame - motion.frame;
  const steps = Math.floor(elapsed);
  const state = motionStateFrom(motion, new MotionState());
  for (let i = 0; i < steps; i++) {
    stepMotion(state, motion, clock);
  }
  const from = motionPose(state, motion, new MotionPose());
  stepMotion(state, motion, clock);
  const to = motionPose(state, motion, new MotionPose());
  const fraction = elapsed - steps;
  return {
    x: from.x + (to.x - from.x) * fraction,
    y: from.y + (to.y - from.y) * fraction,
    angle: from.angle + (to.angle - from.angle) * fraction,
  };
}

/** A baseline on `baseline`'s path at whole frame `frame`, as the server would send it. */
function pathMotion(baseline: Partial<Motion>, frame: number): Motion {
  const motion = Object.assign(new Motion(), baseline);
  const clock = Object.assign(new MotionClock(), CLOCK);
  const state = motionStateFrom(motion, new MotionState());
  for (let i = motion.frame; i < frame; i++) {
    stepMotion(state, motion, clock);
  }
  const pose = motionPose(state, motion, new MotionPose());
  return Object.assign(new Motion(), baseline, {
    frame,
    x: pose.x,
    y: pose.y,
    angle: pose.angle,
    vx: state.vx,
    vy: state.vy,
    w: state.w,
  });
}
