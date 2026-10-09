// A server may switch a body between a streamed pose and a Motion baseline while it lives. These
// tests feed a real ClientWorld the frames such a switch sends and check that the render pose stays
// present through the hand-off, in both directions, and that the difference between the pose just
// shown and the pose the new source gives fades out instead of jumping. The end-to-end runs against
// a real server are in lib/vecs-phaser-server/tests/dead_reckoning_replication.test.ts.

import { ON_STORE, type Entity } from "@vworlds/vecs";
import { Arc, DrawBy, Motion, MotionParams, Position, Rotation } from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { BODY, Client, pathAt, removeOnWire, setOnWire } from "./dead_reckoned_fixtures.js";
import { expectPose, spawnChild } from "./parenting_fixtures.js";

const STEP = Math.fround(1 / 30);
const BLEND_SECONDS = 0.1;

/**
 * A baseline whose values are all exact f32, so the wire returns them unchanged. A body gliding at
 * 3 m/s along x, with no damping and the pose (2.5, 3.125) at frame 5.
 */
const GLIDE: Partial<Motion> = { frame: 5, x: 2.5, y: 3.125, angle: 0.5, vx: 3, vy: 0, w: 0 };
const NO_CONSTANTS = {};

/** What is left of a blend that began at `from`, `frames` physics steps later. */
function remaining(frames: number): number {
  return 1 - (frames * STEP) / BLEND_SECONDS;
}

/** A client that was sent a streamed body at (2, 3), turned by 0.25 rad, and rendered it. */
function streamedClient(
  config?: ConstructorParameters<typeof Client>[0],
  render = false
): { client: Client; body: Entity } {
  const client = new Client(config, render, true);
  client.send([
    setOnWire(BODY, Position, { x: 2, y: 3 }),
    setOnWire(BODY, Rotation, { angle: 0.25 }),
  ]);
  client.render(1);
  return { client, body: client.world.entity(BODY) };
}

/** A client that was sent a body gliding on `GLIDE`'s path, and rendered it at `renderFrame`. */
function glidingClient(
  renderFrame: number,
  config?: ConstructorParameters<typeof Client>[0],
  render = false
): { client: Client; body: Entity } {
  const client = new Client(config, render, true);
  client.send([setOnWire(BODY, Motion, GLIDE)]);
  client.render(renderFrame);
  return { client, body: client.world.entity(BODY) };
}

/** The client-local track of `entity`, found by name: its class is private to the module. */
function trackOf(entity: Entity): object | undefined {
  let found: object | undefined;
  entity.components.forEach((component) => {
    if (component.constructor.name === "MotionTrack") {
      found = component;
    }
  });
  return found;
}

/** Count the `add` and `remove` hooks that fire for the render pose from now on. */
function watchRenderPose(client: Client): { added: string[]; removed: string[] } {
  const events = { added: [] as string[], removed: [] as string[] };
  for (const [Class, name] of [
    [Position, "Position"],
    [Rotation, "Rotation"],
  ] as const) {
    client.world
      .component(Class)
      .on("add", () => events.added.push(name))
      .on("remove", () => events.removed.push(name));
  }
  return events;
}

/** The server's frame for a streamed body that becomes dead reckoned on `motion`. */
function becomeDeadReckoned(client: Client, motion: Partial<Motion>): void {
  client.send(
    [setOnWire(BODY, Motion, motion)],
    [removeOnWire(BODY, Position), removeOnWire(BODY, Rotation)]
  );
}

describe("a streamed body that becomes dead reckoned", () => {
  it("keeps the pose it showed at the first baseline, then blends onto the baseline's path", () => {
    const { client, body } = streamedClient();
    const events = watchRenderPose(client);

    becomeDeadReckoned(client, GLIDE);
    client.render(5);

    // The first sample is the baseline's pose (2.5, 3.125, 0.5); the entity was showing (2, 3, 0.25).
    expectPose(body, { x: 2, y: 3, angle: 0.25 });

    // Half the blend later: the path, plus half of the error between the old pose and the path at
    // the moment of the hand-off.
    const first = pathAt(GLIDE, 5, NO_CONSTANTS);
    const error = { x: 2 - first.x, y: 3 - first.y, angle: 0.25 - first.angle };
    client.render(6.5);
    const path = pathAt(GLIDE, 6.5, NO_CONSTANTS);
    const left = remaining(1.5);
    expect(left).toBeCloseTo(0.5, 6);
    expect(body.get(Position)!.x).toBeCloseTo(path.x + error.x * left, 6);
    expect(body.get(Position)!.y).toBeCloseTo(path.y + error.y * left, 6);
    expect(body.get(Rotation)!.angle).toBeCloseTo(path.angle + error.angle * left, 6);

    // After the blend the entity is on the path.
    client.render(8.5);
    expectPose(body, pathAt(GLIDE, 8.5, NO_CONSTANTS));
    expect(events).toEqual({ added: [], removed: [] });
  });

  it("jumps to the path at the first baseline when the blend is off", () => {
    const { client, body } = streamedClient({ blendMs: 0 });

    becomeDeadReckoned(client, GLIDE);
    client.render(5);

    expectPose(body, pathAt(GLIDE, 5, NO_CONSTANTS));
  });

  it("snaps to the path when the pose it showed is further away than the snap limits", () => {
    const far = streamedClient();
    becomeDeadReckoned(far.client, { ...GLIDE, x: 3.5 });
    far.client.render(5);
    expectPose(far.body, pathAt({ ...GLIDE, x: 3.5 }, 5, NO_CONSTANTS));

    const turned = streamedClient();
    const turnedBaseline = { ...GLIDE, x: 2, y: 3, angle: 0.25 + 0.75 };
    becomeDeadReckoned(turned.client, turnedBaseline);
    turned.client.render(5);
    expectPose(turned.body, pathAt(turnedBaseline, 5, NO_CONSTANTS));
  });

  it("blends nothing for a body that enters the view with only a baseline", () => {
    const { client, body } = glidingClient(5);

    // The Position `Motion` brought sat at the origin; the track must not start from it.
    expectPose(body, pathAt(GLIDE, 5, NO_CONSTANTS));
    client.render(5.5);
    expectPose(body, pathAt(GLIDE, 5.5, NO_CONSTANTS));
    client.render(6);
    expectPose(body, pathAt(GLIDE, 6, NO_CONSTANTS));
  });

  it("does not start the track over when a retransmitted baseline replaces the Motion", () => {
    const { client, body } = streamedClient();
    becomeDeadReckoned(client, GLIDE);
    client.render(5);
    const track = trackOf(body);

    // The server repeats the baseline in every frame until the client acks it.
    client.send([setOnWire(BODY, Motion, GLIDE)]);
    client.render(5.5);
    client.send([setOnWire(BODY, Motion, GLIDE)]);
    client.render(6);

    expect(trackOf(body)).toBe(track);
    const first = pathAt(GLIDE, 5, NO_CONSTANTS);
    const error = { x: 2 - first.x, y: 3 - first.y };
    const path = pathAt(GLIDE, 6, NO_CONSTANTS);
    expect(body.get(Position)!.x).toBeCloseTo(path.x + error.x * remaining(1), 6);
    expect(body.get(Position)!.y).toBeCloseTo(path.y + error.y * remaining(1), 6);
  });

  it("starts its own blend from the pose a hand-off was still fading", () => {
    // Dead reckoned, streamed for a moment, dead reckoned again within the blend.
    const { client, body } = glidingClient(6);
    client.send(
      [setOnWire(BODY, Position, { x: 3.5, y: 3.125 }), setOnWire(BODY, Rotation, { angle: 0.5 })],
      [removeOnWire(BODY, Motion)]
    );
    client.render(6);
    client.render(6.5);
    const mid = { x: body.get(Position)!.x, y: body.get(Position)!.y };
    const handoff = trackOf(body);
    expect(handoff).toBeDefined();

    becomeDeadReckoned(client, { ...GLIDE, frame: 7, x: 3.6 });
    client.render(7);

    // A fresh track, blending from what was on screen.
    expect(trackOf(body)).not.toBe(handoff);
    expect(body.get(Position)!.x).toBeCloseTo(mid.x, 9);
    expect(body.get(Position)!.y).toBeCloseTo(mid.y, 9);
  });
});

describe("a dead-reckoned body that becomes streamed", () => {
  /** The body renders on `GLIDE`'s path at frame 12, then the server streams it 0.2 m ahead of it. */
  function switched(config?: ConstructorParameters<typeof Client>[0], render = false) {
    const setup = glidingClient(12, config, render);
    const path = pathAt(GLIDE, 12, NO_CONSTANTS);
    const streamed = { x: Math.fround(path.x + 0.25), y: Math.fround(path.y), angle: path.angle };
    return { ...setup, path, streamed };
  }
  const SEND_STREAMED = (client: Client, pose: { x: number; y: number; angle: number }): void => {
    client.send(
      [
        setOnWire(BODY, Position, { x: pose.x, y: pose.y }),
        setOnWire(BODY, Rotation, { angle: pose.angle }),
      ],
      [removeOnWire(BODY, Motion), removeOnWire(BODY, MotionParams)]
    );
  };

  it("fades the difference between the two poses out over the streamed pose, then drops the track", () => {
    const { client, body, path, streamed } = switched();
    const events = watchRenderPose(client);
    expect(trackOf(body)).toBeDefined();

    SEND_STREAMED(client, streamed);
    client.render(12);

    // The entity stays where the path put it...
    expectPose(body, path);
    expect(body.has(Motion)).toBe(false);
    expect(trackOf(body)).toBeDefined();

    // ...and no new Position arrives, so the offset fades from the instance it was added to.
    client.render(13.5);
    expect(body.get(Position)!.x).toBeCloseTo(
      streamed.x + (path.x - streamed.x) * remaining(1.5),
      6
    );
    client.render(14.5);
    expect(body.get(Position)!.x).toBeCloseTo(
      streamed.x + (path.x - streamed.x) * remaining(2.5),
      6
    );

    client.render(16);
    expect(body.get(Position)!.x).toBeCloseTo(streamed.x, 9);
    expect(body.get(Position)!.y).toBeCloseTo(streamed.y, 9);
    expect(body.get(Rotation)!.angle).toBeCloseTo(streamed.angle, 6);
    expect(trackOf(body)).toBeUndefined();
    // And once it is gone it adds nothing.
    client.render(30);
    expect(body.get(Position)!.x).toBeCloseTo(streamed.x, 9);
    expect(events).toEqual({ added: [], removed: [] });
  });

  it("adds the fading offset to each streamed pose the network applies", () => {
    const { client, body, path, streamed } = switched();
    SEND_STREAMED(client, streamed);
    client.render(12);

    // The body moves at 3 m/s: the streamed x grows 0.1 m per server frame.
    for (let k = 1; k <= 4; k++) {
      client.send([
        setOnWire(BODY, Position, { x: Math.fround(streamed.x + 0.1 * k), y: streamed.y }),
      ]);
      client.render(12 + k);
      const left = Math.max(0, remaining(k));
      expect(body.get(Position)!.x).toBeCloseTo(
        Math.fround(streamed.x + 0.1 * k) + (path.x - streamed.x) * left,
        6
      );
    }
    client.send([setOnWire(BODY, Position, { x: Math.fround(streamed.x + 0.5), y: streamed.y })]);
    client.render(17);
    expect(body.get(Position)!.x).toBeCloseTo(Math.fround(streamed.x + 0.5), 9);
    expect(trackOf(body)).toBeUndefined();
  });

  it("shows the streamed pose at once when the blend is off", () => {
    const { client, body, streamed } = switched({ blendMs: 0 });

    SEND_STREAMED(client, streamed);
    client.render(12);

    expectPose(body, streamed);
    expect(trackOf(body)).toBeUndefined();
  });

  it("snaps to the streamed pose when it is further away than the snap limits", () => {
    const { client, body, path } = switched();

    SEND_STREAMED(client, { x: Math.fround(path.x + 1.5), y: path.y, angle: path.angle });
    client.render(12);

    expect(body.get(Position)!.x).toBeCloseTo(path.x + 1.5, 6);
    expect(trackOf(body)).toBeUndefined();
  });

  it("drops the track at once when the streamed pose is where the path was", () => {
    const { client, body, path } = switched();

    SEND_STREAMED(client, { x: Math.fround(path.x), y: Math.fround(path.y), angle: path.angle });
    client.render(12);

    expect(trackOf(body)).toBeUndefined();
  });

  it("survives the entity being destroyed during the hand-off", () => {
    const { client, body, streamed } = switched();
    SEND_STREAMED(client, streamed);
    client.render(12);
    expect(trackOf(body)).toBeDefined();

    body.destroy();

    expect(() => client.render(13)).not.toThrow();
  });
});

describe("the render pose through a switch", () => {
  it("never leaves a DrawBy child's parent without a Position, in either direction", () => {
    const { client, body } = streamedClient(undefined, true);
    body.set(Arc, { radius: 0.5 });
    const child = spawnChild(client.world, body, { offset: { x: 1, y: 0 } });
    let entered = 0;
    let exited = 0;
    client.world
      .system("test.child-parent-pose")
      .with({ target: [DrawBy, Position] })
      .phase(ON_STORE)
      .enter(() => entered++)
      .exit(() => exited++);
    client.render(2);
    expect(entered).toBe(1);
    const events = watchRenderPose(client);

    // Streamed to dead reckoned.
    becomeDeadReckoned(client, GLIDE);
    client.render(5);
    expect(body.has(Position) && body.has(Rotation)).toBe(true);
    client.render(7);
    expect(body.has(Position) && body.has(Rotation)).toBe(true);

    // Dead reckoned to streamed.
    const path = pathAt(GLIDE, 9, NO_CONSTANTS);
    client.send(
      [
        setOnWire(BODY, Position, { x: Math.fround(path.x), y: Math.fround(path.y) }),
        setOnWire(BODY, Rotation, { angle: Math.fround(path.angle) }),
      ],
      [removeOnWire(BODY, Motion)]
    );
    client.render(9);
    client.render(12);

    expect(body.has(Motion)).toBe(false);
    expect(body.has(Position) && body.has(Rotation)).toBe(true);
    expect(entered).toBe(1);
    expect(exited).toBe(0);
    expect(events).toEqual({ added: [], removed: [] });
    expect(child.get(Position)).toBeDefined();
  });
});
