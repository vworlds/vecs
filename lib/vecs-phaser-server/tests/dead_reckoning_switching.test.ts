// Switching a body between a streamed pose and dead reckoning while it lives, and the pose guard
// that keeps an entity created or switched late in a frame from shipping an unsynced pose. A real
// ServerWorld with physics and DeadReckonedModule feeds real ClientWorlds through the replication
// harness; each test decodes what the server put on the wire, frame by frame.

import {
  ON_STORE,
  ON_UPDATE,
  POST_UPDATE,
  PRE_STORE,
  type Entity,
  type World,
} from "@vworlds/vecs";
import {
  Motion,
  MotionClock,
  MotionParams,
  phaserMotionComponents,
  phaserNetworkComponents,
  Position as RenderPosition,
  Rotation as RenderRotation,
} from "@vworlds/vecs-phaser";
import {
  AngularVelocity,
  Body,
  BodyType,
  Circle,
  Damping,
  LinearVelocity,
  Material,
  PhysicsModule,
  Polygon,
  Position as PhysicsPosition,
  preloadPhysics,
  Rotation as PhysicsRotation,
  type Vec2,
} from "@vworlds/vecs-physics";
import { ComponentSnapshot, Server2Client } from "@vworlds/vecs-protocol";
import { Networked, type ServerWorld } from "@vworlds/vecs-server";
import { Decoder } from "@vworlds/vecs-wire";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DeadReckonedModule as ClientDeadReckonedModule } from "../../vecs-phaser-client/src/modules/dead_reckoned.js";
import { phaserInterpolators } from "../../vecs-phaser-client/src/sync.js";
import { symmetric } from "../../vecs-server/tests/harness/lossy_link.js";
import { ReplicationSim, type SimClient } from "../../vecs-server/tests/harness/replication_sim.js";
import { DeadReckoned, DeadReckonedModule, PhaserServerModule } from "../src/index.js";

const HZ = 30;
const NETWORK_COMPONENTS = [...phaserNetworkComponents, ...phaserMotionComponents];
const POSITION = NETWORK_COMPONENTS.indexOf(RenderPosition) + 1;
const ROTATION = NETWORK_COMPONENTS.indexOf(RenderRotation) + 1;
const MOTION = NETWORK_COMPONENTS.indexOf(Motion) + 1;
const MOTION_PARAMS = NETWORK_COMPONENTS.indexOf(MotionParams) + 1;
const WIRE_NAMES = new Map([
  [POSITION, "Position"],
  [ROTATION, "Rotation"],
  [MOTION, "Motion"],
  [MOTION_PARAMS, "MotionParams"],
]);
/** An asymmetric convex quadrilateral whose center of mass, (4/3, 7/9), is far from its origin. */
const QUADRILATERAL: Vec2[] = [
  { x: 0, y: 0 },
  { x: 3, y: 0 },
  { x: 3, y: 1 },
  { x: 0, y: 2 },
];
/** The phases a game may switch a body in: two before `POST_UPDATE` ends, two after it. */
const PHASES = [ON_UPDATE, POST_UPDATE, PRE_STORE, ON_STORE] as const;
/** The guard's phase, after `ON_STORE`: a system registered there after the module's runs last. */
const GUARD_PHASE = "phaser.PoseGuard";

let rig: Rig | undefined;

beforeAll(async () => {
  await preloadPhysics();
});

afterEach(() => {
  rig?.sim.dispose();
  rig = undefined;
});

interface Pose {
  x: number;
  y: number;
  angle: number;
}

/** What one frame the server sent carried for one entity, by wire component name. */
interface Carried {
  set: Map<string, Uint8Array>;
  removed: Set<string>;
}

interface SentFrame {
  fromFrame: number;
  toFrame: number;
  /** Per entity: what the frame set and removed. */
  entities: Map<number, Carried>;
}

/** A server with one client on a clean 20 ms link, and a log of every frame the server sent. */
class Rig {
  public readonly sim: ReplicationSim;
  public readonly client: SimClient;
  /** Every frame the server sent the client, in order. */
  public readonly sent: SentFrame[] = [];
  /** The physics pose of every body the test registered, by server frame, after the guard ran. */
  public readonly truth = new Map<number, Map<number, Pose>>();
  /** What the client entity held of the wire pose after every render frame: `Position`, `Motion`. */
  public readonly seen = new Map<number, Array<{ position: boolean; motion: boolean }>>();
  private readonly _watched = new Set<number>();
  private readonly _schedule = new Map<string, Map<number, Array<() => void>>>();

  public constructor(options: { deadReckoning?: boolean; blendMs?: number } = {}) {
    this.sim = new ReplicationSim({
      networkComponents: NETWORK_COMPONENTS,
      seed: 7,
      tickHz: HZ,
      link: symmetric({ oneWayMs: 20 }),
      serverOptions: options.deadReckoning === false ? undefined : { keepAliveFrames: 1 },
    });
    const server = this.sim.server;
    server.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / HZ });
    if (options.deadReckoning === false) {
      server.module(PhaserServerModule);
    } else {
      server.module(DeadReckonedModule, {});
    }
    this.client = this.sim.addClient({ interpolators: phaserInterpolators() });
    if (options.deadReckoning !== false) {
      this.client.world.module(ClientDeadReckonedModule, { blendMs: options.blendMs ?? 100 });
    }
    this._tapFrames();
    for (const phase of [...PHASES, GUARD_PHASE]) {
      this._schedule.set(phase, new Map());
      server
        .system(`test.schedule.${phase}`)
        .phase(phase)
        .run(() => this._runScheduled(phase));
    }
    server
      .system("test.truth")
      .phase(GUARD_PHASE)
      .run(() => this._recordTruth());
    this.client.world
      .system("test.seen")
      .phase(ON_STORE)
      .run(() => this._recordSeen());
  }

  public get server(): ServerWorld {
    return this.sim.server;
  }

  /** Track `entity`: its physics pose per frame on the server, what the client holds of it. */
  public watch(entity: Entity): void {
    this._watched.add(entity.eid);
    this.seen.set(entity.eid, []);
  }

  /** Run `action` inside a system of `phase`, when the server is at `frame`. */
  public at(phase: string, frame: number, action: () => void): void {
    const frames = this._schedule.get(phase)!;
    frames.set(frame, [...(frames.get(frame) ?? []), action]);
  }

  /** What the first frame that reached `toFrame` carried for `eid`. */
  public carried(toFrame: number, eid: number): Carried | undefined {
    return this.sent.find((frame) => frame.toFrame === toFrame)?.entities.get(eid);
  }

  /** The first frame, from any, that set `wire` on `eid`: its decoded payload. */
  public firstSet<T extends object>(
    eid: number,
    wire: string,
    Class: new () => T
  ): { toFrame: number; value: T } | undefined {
    for (const frame of this.sent) {
      const payload = frame.entities.get(eid)?.set.get(wire);
      if (payload !== undefined) {
        return { toFrame: frame.toFrame, value: new Decoder(payload).read(Class) };
      }
    }
    return undefined;
  }

  /** The physics pose of `eid` at server frame `frame`, as the guard left it. */
  public truthAt(frame: number, eid: number): Pose {
    const pose = this.truth.get(frame)?.get(eid);
    if (pose === undefined) {
      throw new Error(`no physics pose recorded for entity ${eid} at frame ${frame}`);
    }
    return pose;
  }

  /** The physics pose of `eid` at the fractional server frame `frame`, interpolated as a client does. */
  public truthAtRender(eid: number, frame: number): Pose {
    const whole = Math.floor(frame);
    const from = this.truthAt(whole, eid);
    const to = this.truthAt(whole + 1, eid);
    const fraction = frame - whole;
    return {
      x: from.x + (to.x - from.x) * fraction,
      y: from.y + (to.y - from.y) * fraction,
      angle: from.angle + (to.angle - from.angle) * fraction,
    };
  }

  private _tapFrames(): void {
    const harness = this.client.down.tap;
    this.client.down.tap = (data) => {
      harness?.(data);
      const diff = new Decoder(data).read(Server2Client).diff;
      if (diff === undefined) {
        return;
      }
      const entities = new Map<number, Carried>();
      const carriedOf = (eid: number): Carried => {
        let carried = entities.get(eid);
        if (carried === undefined) {
          carried = { set: new Map(), removed: new Set() };
          entities.set(eid, carried);
        }
        return carried;
      };
      for (const encoded of diff.snapshots) {
        const snapshot = new Decoder(encoded.bytes).read(ComponentSnapshot);
        const name = WIRE_NAMES.get(snapshot.wireType);
        if (name !== undefined) {
          carriedOf(snapshot.eid).set.set(name, snapshot.payload);
        }
      }
      for (const [eid, wireType] of diff.removed) {
        const name = WIRE_NAMES.get(wireType);
        if (name !== undefined) {
          carriedOf(eid).removed.add(name);
        }
      }
      this.sent.push({ fromFrame: diff.fromFrame, toFrame: diff.toFrame, entities });
    };
  }

  private _runScheduled(phase: string): void {
    const actions = this._schedule.get(phase)!.get(this.sim.server.frame);
    actions?.forEach((action) => action());
  }

  private _recordTruth(): void {
    const frame = this.sim.server.frame;
    for (const eid of this._watched) {
      const entity = this.sim.server.getEntity(eid);
      const position = entity?.get(PhysicsPosition);
      const rotation = entity?.get(PhysicsRotation);
      if (position === undefined || rotation === undefined) {
        continue;
      }
      let poses = this.truth.get(frame);
      if (poses === undefined) {
        poses = new Map();
        this.truth.set(frame, poses);
      }
      poses.set(eid, { x: position.x, y: position.y, angle: rotation.angle });
    }
  }

  private _recordSeen(): void {
    for (const eid of this._watched) {
      const entity = this.client.world.getEntity(eid);
      if (entity !== undefined) {
        this.seen
          .get(eid)!
          .push({ position: entity.has(RenderPosition), motion: entity.has(Motion) });
      }
    }
  }
}

interface BodyOptions {
  x?: number;
  y?: number;
  angle?: number;
  vx?: number;
  vy?: number;
  w?: number;
  damping?: { linear: number; angular: number };
  polygon?: Vec2[];
  /** A streamed body carries a render pose (at the default, which is not its physics pose). */
  streamed?: boolean;
}

/** A networked dynamic disc (or polygon) with a physics pose, dead reckoned unless `streamed`. */
function spawnBody(world: World, options: BodyOptions = {}): Entity {
  const body = world
    .entity()
    .add(Networked)
    .set(Body, { type: BodyType.Dynamic })
    .set(PhysicsPosition, { x: options.x ?? 0, y: options.y ?? 0 })
    .set(PhysicsRotation, { angle: options.angle ?? 0 })
    .set(LinearVelocity, { x: options.vx ?? 0, y: options.vy ?? 0 })
    .set(AngularVelocity, { value: options.w ?? 0 });
  if (options.streamed === true) {
    body.add(RenderPosition).add(RenderRotation);
  } else {
    body.add(DeadReckoned);
  }
  if (options.damping !== undefined) {
    body.set(Damping, options.damping);
  }
  const shape = world.entity().childOf(body);
  if (options.polygon === undefined) {
    shape.set(Circle, { radius: 0.5 });
  } else {
    shape.set(Polygon, { vertices: options.polygon });
  }
  shape.set(Material, { restitution: 0 });
  return body;
}

function names(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** `pose` as the wire carries it, every value an f32. */
function f32(pose: Pose): Pose {
  return { x: Math.fround(pose.x), y: Math.fround(pose.y), angle: Math.fround(pose.angle) };
}

describe("switching a body between a streamed pose and dead reckoning", () => {
  describe.each(PHASES)("in %s", (phase) => {
    it("sends Motion and the removal of the render pose in one diff when a streamed body becomes dead reckoned", () => {
      rig = new Rig();
      const body = spawnBody(rig.server, {
        x: 2,
        y: 1,
        angle: 0.3,
        vx: 0.4,
        vy: 0.3,
        w: 0.5,
        streamed: true,
      });
      rig.watch(body);
      const switchFrame = 40;
      rig.at(phase, switchFrame, () => body.add(DeadReckoned));

      rig.sim.run(3000);

      const carried = rig.carried(switchFrame, body.eid)!;
      expect(names(carried.set.keys())).toEqual(["Motion"]);
      expect(names(carried.removed)).toEqual(["Position", "Rotation"]);
      const baseline = new Decoder(carried.set.get("Motion")!).read(Motion);
      expect(baseline.frame).toBe(switchFrame);
      expect({ x: baseline.x, y: baseline.y, angle: baseline.angle }).toEqual(
        f32(rig.truthAt(switchFrame, body.eid))
      );
      // The render pose was streamed until the frame before, and never again.
      const streamedBefore = rig.firstSet(body.eid, "Position", RenderPosition)!;
      expect(streamedBefore.toFrame).toBeLessThan(switchFrame);
      expect(
        rig.sent
          .filter((frame) => frame.toFrame > switchFrame)
          .every((frame) => {
            return !frame.entities.get(body.eid)?.set.has("Position");
          })
      ).toBe(true);
      expect(body.has(RenderPosition)).toBe(false);
      expect(body.has(Motion)).toBe(true);
      expect(rig.client.stats.errors).toEqual([]);
    });

    it("sends the render pose and the removal of Motion in one diff when a dead-reckoned body becomes streamed", () => {
      rig = new Rig();
      const body = spawnBody(rig.server, { x: 2, y: 1, angle: 0.3, vx: 0.4, vy: 0.3, w: 0.5 });
      rig.watch(body);
      const switchFrame = 40;
      rig.at(phase, switchFrame, () => body.remove(DeadReckoned));

      rig.sim.run(3000);

      const carried = rig.carried(switchFrame, body.eid)!;
      expect(names(carried.set.keys())).toEqual(["Position", "Rotation"]);
      expect(names(carried.removed)).toEqual(["Motion"]);
      const truth = f32(rig.truthAt(switchFrame, body.eid));
      const position = new Decoder(carried.set.get("Position")!).read(RenderPosition);
      const rotation = new Decoder(carried.set.get("Rotation")!).read(RenderRotation);
      expect({ x: position.x, y: position.y, angle: rotation.angle }).toEqual(truth);
      expect(body.has(Motion)).toBe(false);
      expect(body.has(MotionParams)).toBe(false);
      expect(body.has(RenderPosition)).toBe(true);
      expect(rig.client.stats.errors).toEqual([]);
    });
  });

  it("keeps a pose on the client in every frame, in both directions", () => {
    rig = new Rig();
    const body = spawnBody(rig.server, { vx: 0.4, vy: 0.3, w: 0.5, streamed: true });
    rig.watch(body);
    rig.at(ON_UPDATE, 40, () => body.add(DeadReckoned));
    rig.at(ON_STORE, 80, () => body.remove(DeadReckoned));
    rig.at(PRE_STORE, 120, () => body.add(DeadReckoned));
    // From the moment the client holds the body, its render pose is never removed or added again:
    // not even within one frame, where an end-of-frame sample would not see it.
    const churn: string[] = [];
    rig.sim.run(500);
    for (const [Class, name] of [
      [RenderPosition, "Position"],
      [RenderRotation, "Rotation"],
    ] as const) {
      rig.client.world
        .component(Class)
        .on("add", (entity) => entity.eid === body.eid && churn.push(`add ${name}`))
        .on("remove", (entity) => entity.eid === body.eid && churn.push(`remove ${name}`));
    }

    rig.sim.run(5500);

    expect(churn).toEqual([]);
    const seen = rig.seen.get(body.eid)!;
    expect(seen.length).toBeGreaterThan(300);
    // From the first render frame the entity exists, it has a render pose; never a gap.
    expect(seen.every((frame) => frame.position)).toBe(true);
    // And the three paths all happened.
    expect(seen.some((frame) => frame.motion)).toBe(true);
    expect(seen.some((frame, i) => !frame.motion && i > seen.findIndex((f) => f.motion))).toBe(
      true
    );
    expect(rig.client.stats.errors).toEqual([]);
    expect(rig.client.stats.disconnects).toEqual([]);
  });

  it("keeps a pose on the wire in every frame: no diff leaves an entity with neither Position nor Motion", () => {
    rig = new Rig();
    const body = spawnBody(rig.server, { vx: 0.4, w: 0.5, streamed: true });
    rig.watch(body);
    PHASES.forEach((phase, i) => {
      rig!.at(phase, 30 + 20 * i, () => body.add(DeadReckoned));
      rig!.at(phase, 40 + 20 * i, () => body.remove(DeadReckoned));
    });

    rig.sim.run(4000);

    // Replay what the server sent as the client applies it: snapshots, then removals.
    const wire = new Set<string>();
    let frames = 0;
    for (const frame of rig.sent) {
      const carried = frame.entities.get(body.eid);
      if (carried === undefined) {
        continue;
      }
      carried.set.forEach((_payload, name) => wire.add(name));
      carried.removed.forEach((name) => wire.delete(name));
      frames++;
      expect(wire.has("Position") || wire.has("Motion"), `frame ${frame.toFrame}`).toBe(true);
    }
    expect(frames).toBeGreaterThan(8);
  });

  it("switches back and forth any number of times", () => {
    rig = new Rig();
    const body = spawnBody(rig.server, { x: -3, vx: 0.4, vy: -0.2, w: 0.5, streamed: true });
    rig.watch(body);
    // Toggle every 7 frames, in a different phase each time, for ten seconds.
    for (let frame = 21, i = 0; frame < 300; frame += 7, i++) {
      const phase = PHASES[i % PHASES.length]!;
      const toDeadReckoned = i % 2 === 0;
      rig.at(phase, frame, () =>
        toDeadReckoned ? body.add(DeadReckoned) : body.remove(DeadReckoned)
      );
    }

    rig.sim.run(11_000);

    expect(rig.client.stats.errors).toEqual([]);
    expect(rig.client.stats.disconnects).toEqual([]);
    expect(rig.client.stats.resets).toHaveLength(1);
    expect(rig.seen.get(body.eid)!.every((frame) => frame.position)).toBe(true);
    // The body ends where the toggling left it, and the client agrees with the server.
    const clientBody = rig.client.world.entity(body.eid);
    expect(clientBody.has(Motion)).toBe(body.has(DeadReckoned));
    expect(rig.sim.diffFromServer(rig.client, [Motion, MotionParams, MotionClock])).toEqual([]);
    const shown = clientBody.get(RenderPosition)!;
    const expected = rig.truthAtRender(body.eid, rig.client.world.renderFrame);
    expect(Math.hypot(shown.x - expected.x, shown.y - expected.y)).toBeLessThan(0.02);
  });

  it("sends MotionParams again when a body with non-default constants goes back to dead reckoning", () => {
    rig = new Rig();
    const body = spawnBody(rig.server, {
      x: -4,
      vx: 0.6,
      vy: 0.2,
      w: 0.4,
      damping: { linear: 0.15, angular: 0.1 },
      polygon: QUADRILATERAL,
    });
    rig.watch(body);
    rig.at(ON_STORE, 40, () => body.remove(DeadReckoned));
    rig.at(PRE_STORE, 70, () => body.add(DeadReckoned));

    rig.sim.run(4000);

    // Spawn: constants ride with the first baseline. Leaving: they go with the Motion. Returning:
    // they ride with the new baseline, in the same diff.
    const spawn = rig.sent.find((frame) => frame.entities.get(body.eid)?.set.has("MotionParams"))!;
    expect(spawn.toFrame).toBeLessThan(10);
    expect(names(rig.carried(40, body.eid)!.removed)).toEqual(["Motion", "MotionParams"]);
    const back = rig.carried(70, body.eid)!;
    expect(names(back.set.keys())).toEqual(["Motion", "MotionParams"]);
    expect(names(back.removed)).toEqual(["Position", "Rotation"]);
    const params = new Decoder(back.set.get("MotionParams")!).read(MotionParams);
    expect(params.linearDamping).toBe(Math.fround(0.15));
    expect(params.localCenterX).toBeCloseTo(4 / 3, 6);
    expect(params.localCenterY).toBeCloseTo(7 / 9, 6);
    // The client holds them once more.
    const held = rig.client.world.entity(body.eid).get(MotionParams)!;
    expect(held.linearDamping).toBe(Math.fround(0.15));
    expect(rig.sim.diffFromServer(rig.client, [Motion, MotionParams, MotionClock])).toEqual([]);
  });

  it("survives a remove and an add of the tag in one flush, either way round", () => {
    rig = new Rig();
    const dead = spawnBody(rig.server, { vx: 0.4, w: 0.5 });
    const streamed = spawnBody(rig.server, { x: 5, vx: 0.4, w: 0.5, streamed: true });
    [dead, streamed].forEach((body) => rig!.watch(body));
    rig.at(ON_UPDATE, 30, () => {
      const world = rig!.server;
      world.defer(() => {
        dead.remove(DeadReckoned);
        dead.add(DeadReckoned);
        streamed.add(DeadReckoned);
        streamed.remove(DeadReckoned);
      });
    });

    rig.sim.run(2000);

    expect(rig.client.stats.errors).toEqual([]);
    expect(dead.has(DeadReckoned)).toBe(true);
    expect(dead.has(RenderPosition)).toBe(false);
    expect(dead.has(Motion)).toBe(true);
    expect(streamed.has(DeadReckoned)).toBe(false);
    expect(streamed.has(Motion)).toBe(false);
    expect(streamed.get(RenderPosition)).toMatchObject(streamed.get(PhysicsPosition)!);
    expect(rig.sim.diffFromServer(rig.client, [Motion, MotionParams, MotionClock])).toEqual([]);
  });
});

describe("the pose guard", () => {
  const SPAWN_FRAME = 20;
  const POSE = { x: 3, y: 4, angle: 0.5 };

  describe.each([PRE_STORE, ON_STORE])("for a body created in %s", (phase) => {
    it("replicates a streamed body at its physics pose, not at the default render pose", () => {
      rig = new Rig();
      let body: Entity | undefined;
      rig.at(phase, SPAWN_FRAME, () => {
        body = spawnBody(rig!.server, { ...POSE, streamed: true });
      });

      rig.sim.run(1500);

      const first = rig.firstSet(body!.eid, "Position", RenderPosition)!;
      expect(first.toFrame).toBe(SPAWN_FRAME);
      expect({ x: first.value.x, y: first.value.y }).toEqual({ x: POSE.x, y: POSE.y });
      const rotation = rig.firstSet(body!.eid, "Rotation", RenderRotation)!;
      expect(rotation.value.angle).toBeCloseTo(POSE.angle, 6);
      expect(rig.client.world.entity(body!.eid).get(RenderPosition)).toMatchObject({
        x: POSE.x,
        y: POSE.y,
      });
    });

    it("replicates a dead-reckoned body with a baseline at its physics pose, not the default Motion", () => {
      rig = new Rig();
      let body: Entity | undefined;
      rig.at(phase, SPAWN_FRAME, () => {
        body = spawnBody(rig!.server, POSE);
      });

      rig.sim.run(1500);

      const first = rig.firstSet(body!.eid, "Motion", Motion)!;
      expect(first.toFrame).toBe(SPAWN_FRAME);
      expect(first.value.frame).toBe(SPAWN_FRAME);
      expect({ x: first.value.x, y: first.value.y }).toEqual({ x: POSE.x, y: POSE.y });
      expect(first.value.angle).toBeCloseTo(POSE.angle, 6);
    });

    it("replicates a body that becomes dead reckoned there at its physics pose, in that frame", () => {
      rig = new Rig();
      const body = spawnBody(rig.server, { ...POSE, streamed: true });
      rig.at(phase, SPAWN_FRAME, () => body.add(DeadReckoned));
      rig.watch(body);

      rig.sim.run(1500);

      const baseline = rig.carried(SPAWN_FRAME, body.eid)!.set.get("Motion")!;
      const motion = new Decoder(baseline).read(Motion);
      expect(motion.frame).toBe(SPAWN_FRAME);
      expect({ x: motion.x, y: motion.y }).toEqual({ x: POSE.x, y: POSE.y });
    });
  });

  it("serves an entity an RPC creates between ticks", async () => {
    rig = new Rig();
    const spawned: Entity[] = [];
    rig.server.handleRpc(101, () => {
      spawned.push(spawnBody(rig!.server, { ...POSE, streamed: true }));
      spawned.push(spawnBody(rig!.server, POSE));
      return [];
    });
    rig.sim.run(500);

    // The call rides the client's next ack, and the handler runs between two ticks when it arrives.
    const call = rig.client.world.invoke(101, []);
    rig.sim.run(200);
    expect(spawned).toHaveLength(2);
    // The reply is a promise: let it queue before the world sends the next frame.
    await new Promise((resolve) => setImmediate(resolve));
    rig.sim.run(1500);
    await expect(call).resolves.toEqual([]);
    const [streamed, dead] = spawned as [Entity, Entity];
    const position = rig.firstSet(streamed.eid, "Position", RenderPosition)!;
    expect({ x: position.value.x, y: position.value.y }).toEqual({ x: POSE.x, y: POSE.y });
    const motion = rig.firstSet(dead.eid, "Motion", Motion)!;
    expect({ x: motion.value.x, y: motion.value.y }).toEqual({ x: POSE.x, y: POSE.y });
    expect(motion.value.frame).toBeGreaterThan(0);
    expect(rig.client.stats.errors).toEqual([]);
  });

  it("serves a streamed entity without dead reckoning installed", () => {
    rig = new Rig({ deadReckoning: false });
    let body: Entity | undefined;
    rig.at(ON_STORE, SPAWN_FRAME, () => {
      body = spawnBody(rig!.server, { ...POSE, streamed: true });
    });

    rig.sim.run(1500);

    const first = rig.firstSet(body!.eid, "Position", RenderPosition)!;
    expect({ x: first.value.x, y: first.value.y }).toEqual({ x: POSE.x, y: POSE.y });
  });

  it("adds nothing to a body that POST_UPDATE already synced", () => {
    rig = new Rig();
    const writes: number[] = [];
    const baselines: number[] = [];
    rig.server.component(RenderPosition).on("set", (entity) => {
      if (entity.has(PhysicsPosition) && entity.has(Networked)) {
        writes.push(rig!.server.frame);
      }
    });
    rig.server.component(Motion).on("set", () => baselines.push(rig!.server.frame));
    rig.at(ON_UPDATE, SPAWN_FRAME, () => {
      spawnBody(rig!.server, { ...POSE, streamed: true });
      spawnBody(rig!.server, POSE);
    });

    rig.sim.run(1000);

    // One write of the streamed body's pose and one baseline, in the frame it was created: the
    // sync systems did it in POST_UPDATE and the guard found nothing left to do.
    expect(writes.filter((frame) => frame === SPAWN_FRAME)).toHaveLength(1);
    expect(baselines.filter((frame) => frame === SPAWN_FRAME)).toHaveLength(1);
  });
});
