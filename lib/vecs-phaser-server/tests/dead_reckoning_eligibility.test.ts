import { ON_STORE } from "@vworlds/vecs";
import { Motion, phaserMotionComponents, phaserNetworkComponents } from "@vworlds/vecs-phaser";
import {
  Body,
  AngularVelocity,
  BodyType,
  Circle,
  LinearVelocity,
  PhysicsModule,
  Position,
  preloadPhysics,
  Rotation,
  Sleep,
} from "@vworlds/vecs-physics";
import { ServerWorld } from "@vworlds/vecs-server";
import { beforeAll, describe, expect, it } from "vitest";

import { DeadReckoned, DeadReckonedModule } from "../src/index.js";

beforeAll(preloadPhysics);

function scene(maxBaselineAge = 30) {
  const world = new ServerWorld({
    networkComponents: [...phaserNetworkComponents, ...phaserMotionComponents],
    keepAliveFrames: 1,
  });
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, fixedTimeStep: 1 / 30 });
  world.module(DeadReckonedModule, { maxBaselineAge });
  const writes: number[] = [];
  world.component(Motion).on("set", (_entity, motion) => writes.push(motion.frame));
  let now = 0;
  const step = (count = 1) => {
    for (let i = 0; i < count; i++) {
      world.progress((now += 1000 / 30), 1000 / 30);
    }
  };
  const moving = () => {
    const entity = world
      .entity()
      .set(Body, { type: BodyType.Dynamic })
      .set(Position, { x: 0, y: 0 })
      .set(LinearVelocity, { x: 1, y: 0 })
      .set(Sleep, { enabled: false })
      .add(DeadReckoned);
    world.entity().childOf(entity).set(Circle, { radius: 0.5 });
    return entity;
  };
  return { world, step, writes, moving };
}

describe("dead-reckoning eligibility", () => {
  it("preserves baseline write order when an earlier resting entity becomes eligible again", () => {
    const { world, step, moving } = scene();
    try {
      const first = world.entity().set(Position, { x: 0, y: 10 }).add(DeadReckoned);
      const second = moving();
      step(3);
      const order: number[] = [];
      world.component(Motion).on("set", (entity) => order.push(entity.eid));
      first.set(Rotation, { angle: 1 });
      second.set(Position, { x: 10, y: 0 });
      step();
      expect(order).toEqual([first.eid, second.eid]);
    } finally {
      world.dispose();
    }
  });

  it("holds resting baselines across idle frames and handles both application-written poses", () => {
    const { world, step, writes } = scene();
    try {
      const entity = world.entity().set(Position, { x: 2, y: 3 }).add(DeadReckoned);
      step();
      const initial = world.frame - 1;
      step(10);
      expect(writes).toEqual([initial]);
      entity.set(Position, { x: 2.005, y: 3 });
      step();
      expect(writes).toEqual([initial]);
      step(10);
      entity.set(Position, { x: 4, y: 5 });
      entity.set(Rotation, { angle: 0.5 });
      step();
      expect(writes).toEqual([initial, world.frame - 1]);
      expect(entity.get(Motion)).toMatchObject({ x: 4, y: 5, angle: 0.5, rest: true });
      entity.getMut(Rotation, (rotation) => (rotation.angle = 1));
      step();
      expect(entity.get(Motion)).toMatchObject({ angle: 1, frame: world.frame - 1 });
    } finally {
      world.dispose();
    }
  });

  it("writes the rest baseline when a moving body falls asleep without a pose write", () => {
    const { world, step, writes, moving } = scene();
    try {
      const entity = moving();
      step(3);
      const before = { ...entity.get(Position)! };
      const count = writes.length;
      entity.set(Sleep, { enabled: true, awake: false });
      step();
      expect(entity.get(Position)).toEqual(before);
      expect(writes).toHaveLength(count + 1);
      expect(entity.get(Motion)).toMatchObject({ rest: true, frame: world.frame - 1 });
      step(5);
      expect(writes).toHaveLength(count + 1);
    } finally {
      world.dispose();
    }
  });

  it("handles a rotation-only physics write when a resting body starts spinning in place", () => {
    const { world, step, moving } = scene();
    try {
      const entity = moving();
      entity.set(LinearVelocity, { x: 0, y: 0 });
      step();
      expect(entity.get(Motion)).toMatchObject({ rest: true });
      const position = { ...entity.get(Position)! };
      entity.set(AngularVelocity, { value: 1 });
      step();
      expect(entity.get(Position)).toEqual(position);
      expect(entity.get(Motion)).toMatchObject({ rest: false, w: 1, frame: world.frame - 1 });
    } finally {
      world.dispose();
    }
  });

  it("retains moving eligibility for late guard baselines and age refreshes", () => {
    const { world, step, moving } = scene(3 / 30);
    try {
      let entity: ReturnType<typeof moving> | undefined;
      world
        .system("late body")
        .phase(ON_STORE)
        .run(() => {
          entity ??= moving();
        });
      step();
      expect(entity!.get(Motion)).toMatchObject({ frame: world.frame - 1, rest: true });
      step();
      const frame = world.frame - 1;
      expect(entity!.get(Motion)).toMatchObject({ frame, rest: false });
      step(3);
      expect(entity!.get(Motion)).toMatchObject({ frame: frame + 3, rest: false });
    } finally {
      world.dispose();
    }
  });

  it("catches up a retained moving prediction on query re-entry and survives transient exits", () => {
    const { world, step, moving } = scene(4 / 30);
    try {
      const entity = moving();
      step();
      entity.remove(Rotation);
      step(6);
      entity.set(Rotation, { angle: 0 });
      step();
      expect(entity.get(Motion)).toMatchObject({ frame: world.frame - 1, rest: false });
      entity.remove(Position);
      entity.set(Position, { x: 10, y: 0 });
      entity.remove(DeadReckoned);
      entity.add(DeadReckoned);
      step();
      expect(entity.get(Motion)).toMatchObject({ frame: world.frame - 1, rest: false });
      entity.destroy();
      step();
      expect(entity.destroyed).toBe(true);
    } finally {
      world.dispose();
    }
  });
});
