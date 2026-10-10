// The client extrapolator: DeadReckonedModule turns each Motion baseline into a client-local render
// pose at ClientWorld.renderFrame. These tests drive renderFrame directly; the end-to-end runs
// against a real server are in lib/vecs-phaser-server/tests/dead_reckoning_replication.test.ts.

import { ON_UPDATE, World } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  Arc,
  Motion,
  MotionClock,
  MotionParams,
  Offset,
  phaserMotionComponents,
  phaserNetworkComponents,
  Position,
  Rotation,
} from "@vworlds/vecs-phaser";
import { describe, expect, it, vi } from "vitest";

import { DeadReckonedModule } from "../../src/index.js";
import { Client, CLOCK, DAMPING, DRIFT, pathAt, pathMotion } from "./dead_reckoned_fixtures.js";
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

describe("DeadReckonedModule (client)", () => {
  it("finishes a long late-correction blend on loop time while renderFrame holds", () => {
    const client = new Client({ blendMs: 300 });
    const body = client.world.entity().set(Motion, { frame: 1, x: 0, rest: true });
    client.render(10);
    body.set(Motion, { frame: 8, x: 0.3, rest: true });
    client.render(10, 0);
    expect(body.get(Position)!.x).toBe(0);
    client.render(10, 150);
    expect(body.get(Position)!.x).toBeCloseTo(0.15, 6);
    client.render(10, 150);
    expect(body.get(Position)!.x).toBe(0.3);
  });

  it("finishes a first-baseline blend while renderFrame holds", () => {
    const client = new Client({ blendMs: 300 });
    const body = client.world.entity().set(Position, { x: 0 }).set(Rotation, { angle: 0 });
    client.render(10);
    body.set(Motion, { frame: 10, x: 0.3, rest: true });
    client.render(10, 0);
    expect(body.get(Position)!.x).toBe(0);
    client.render(10, 300);
    expect(body.get(Position)!.x).toBe(0.3);
  });
  it("gives a body that arrives with only a baseline a render pose, extrapolated at renderFrame", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, DRIFT).set(MotionParams, DAMPING);

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
    const body = client.world.entity().set(Motion, DRIFT).set(MotionParams, DAMPING);

    client.render(310.5);

    expectPose(body, pathAt(DRIFT, 310.5));
  });

  it("holds a body at rest", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, { frame: 3, x: -4, y: 5, angle: 1, rest: true });

    client.render(3);
    client.render(90.5);

    expectPose(body, { x: -4, y: 5 });
    expect(body.get(Rotation)!.angle).toBeCloseTo(1, 4);
  });

  it("reads whether a body is at rest from the baseline, never from its velocities or the gravity", () => {
    const client = new Client();
    // A world with gravity and a body that has velocities: only the baseline's `rest` decides.
    client.clockEntity.set(MotionClock, { gravityY: -10 });
    const held = client.world.entity().set(Motion, { ...DRIFT, rest: true });
    const moving = client.world.entity().set(Motion, DRIFT);

    client.render(20.5);

    expectPose(held, { x: 1, y: 2 });
    expect(held.get(Rotation)!.angle).toBeCloseTo(0.25, 4);
    expectPose(moving, pathAt(DRIFT, 20.5, {}, { gravityY: -10 }));
    expect(moving.get(Position)!.x).toBeGreaterThan(1.5);
  });

  it("holds a body at rest at exactly the pose it carries, whatever center of mass its constants hold", () => {
    const client = new Client();
    // An off-center body, at angles whose cosine and sine round, so a pose derived through the
    // center of mass and `atan2` would come back a few ulps off.
    const baselines = [
      { frame: 3, x: -4.1, y: 5.3, angle: 1 },
      { frame: 3, x: 2.3, y: -1.7, angle: 0.7 },
      { frame: 3, x: 9.9, y: 0.1, angle: -2.4 },
    ].map((pose) => Object.assign(new Motion(), pose, { rest: true }));
    const bodies = baselines.map((baseline) =>
      client.world.entity().set(Motion, baseline).set(MotionParams, DAMPING)
    );

    client.render(3);
    client.render(90.5);

    bodies.forEach((body, i) => {
      expect(body.get(Position)!.x).toBe(baselines[i]!.x);
      expect(body.get(Position)!.y).toBe(baselines[i]!.y);
      expect(body.get(Rotation)!.angle).toBe(baselines[i]!.angle);
    });
  });

  it("steps a baseline with its entity's MotionParams, or with the defaults when it has none", () => {
    const client = new Client();
    const damped = client.world.entity().set(Motion, DRIFT).set(MotionParams, DAMPING);
    const bare = client.world.entity().set(Motion, DRIFT);

    client.render(40.5);

    expectPose(damped, pathAt(DRIFT, 40.5, DAMPING));
    expectPose(bare, pathAt(DRIFT, 40.5, {}));
    // The constants matter: the two paths end up apart.
    const apart = Math.hypot(
      damped.get(Position)!.x - bare.get(Position)!.x,
      damped.get(Position)!.y - bare.get(Position)!.y
    );
    expect(apart).toBeGreaterThan(0.1);
  });

  it("applies a gravity scale and fast rotation from the MotionParams", () => {
    const client = new Client();
    client.clockEntity.set(MotionClock, { gravityY: -10 });
    const baseline = { frame: 5, vx: 1, vy: 4, w: 60 };
    const constants = { gravityScale: 0.25, allowFastRotation: true };
    const body = client.world.entity().set(Motion, baseline).set(MotionParams, constants);

    client.render(35);

    expectPose(body, pathAt(baseline, 35, constants, { gravityY: -10 }));
    // The defaults would pull the body down four times as hard: 5 m in a second instead of 1.25 m.
    const defaults = pathAt(baseline, 35, {}, { gravityY: -10 });
    expect(body.get(Position)!.y - defaults.y).toBeGreaterThan(3);
  });

  it("takes new constants at the next baseline, and keeps the old ones until then", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, DRIFT).set(MotionParams, DAMPING);
    client.render(20);

    // The constants alone change nothing: the path is the one the held baseline was taken on.
    const stronger = { linearDamping: 0.9, angularDamping: 0.7, localCenterX: -0.3 };
    body.set(MotionParams, stronger);
    client.render(24.5);
    expectPose(body, pathAt(DRIFT, 24.5, DAMPING));

    // A newer baseline, received in time, takes the entity's constants as they are by then.
    const later = pathMotion(DRIFT, 26, DAMPING);
    body.set(Motion, later);
    client.render(26.5);
    client.render(30.25);

    expectPose(body, pathAt(later, 30.25, { ...DAMPING, ...stronger }));
  });

  it("falls back to the defaults at the next baseline when the constants are gone", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, DRIFT).set(MotionParams, DAMPING);
    client.render(20);

    body.remove(MotionParams);
    const later = pathMotion(DRIFT, 22, DAMPING);
    body.set(Motion, later);
    client.render(22.5);
    client.render(26.5);

    expectPose(body, pathAt(later, 26.5, {}));
  });

  it("takes constants that arrive in the same frame as the baseline they belong to", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, DRIFT);
    client.render(20);

    // One diff: a newer baseline and the constants it needs, applied together.
    const stronger = { linearDamping: 0.9, localCenterX: -0.3 };
    const later = pathMotion(DRIFT, 21, {});
    body.set(MotionParams, stronger).set(Motion, later);
    client.render(21.5);
    client.render(27.5);

    expectPose(body, pathAt(later, 27.5, stronger));
  });

  it("looks the constants up only when it takes a baseline", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, DRIFT).set(MotionParams, DAMPING);
    client.render(10);
    const get = vi.spyOn(body, "get");

    client.render(10.5);
    client.render(12);
    client.render(30.25);
    expect(get).not.toHaveBeenCalled();

    body.set(Motion, pathMotion(DRIFT, 31, DAMPING));
    client.render(31.5);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(MotionParams);
  });

  it("ignores a baseline older than the one it holds", () => {
    const client = new Client();
    const body = client.world
      .entity()
      .set(Motion, { ...DRIFT, frame: 20 })
      .set(MotionParams, DAMPING);
    client.render(20.5);

    body.set(Motion, { ...DRIFT, frame: 15, vx: -8 });
    client.render(21);

    expectPose(body, pathAt({ ...DRIFT, frame: 20 }, 21));
  });

  it("applies a correction received in time at once", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, DRIFT).set(MotionParams, DAMPING);
    client.render(19.6);

    const correction = { ...DRIFT, frame: 20, x: 30, y: 2.5, vx: 1 };
    body.set(Motion, correction);
    client.render(20.2);

    expectPose(body, pathAt(correction, 20.2));
  });

  it("blends a late correction out over 100 ms", () => {
    const client = new Client();
    const body = client.world.entity().set(Motion, DRIFT).set(MotionParams, DAMPING);
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
      const body = client.world.entity().set(Motion, DRIFT).set(MotionParams, DAMPING);
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
    tolerant.render(25, 150); // 150 ms of 200: a quarter of the error left
    expect(bodies[2]!.get(Position)!.x).toBeCloseTo(pathAt(corrections[2]!, 25).x - 0.25 * 1.5, 2);
  });

  it("extrapolates nothing until the MotionClock arrives", () => {
    const world = new ClientWorld({
      networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
    });
    let frame = 12;
    vi.spyOn(world, "renderFrame", "get").mockImplementation(() => frame);
    world.module(DeadReckonedModule);
    const body = world.entity().set(Motion, DRIFT).set(MotionParams, DAMPING);

    world.progress(0, 16);
    expectPose(body, { x: 0, y: 0, angle: 0 });

    world.entity().set(MotionClock, CLOCK);
    frame = 12.5;
    world.progress(16, 16);
    expectPose(body, pathAt(DRIFT, 12.5));
  });

  it("writes the pose before gameplay and render systems, so a DrawBy child keeps up in the same frame", () => {
    const client = new Client(undefined, true);
    const parent = client.world
      .entity()
      .set(Motion, DRIFT)
      .set(MotionParams, DAMPING)
      .set(Arc, { radius: 0.5 });
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
