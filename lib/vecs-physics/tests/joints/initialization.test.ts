import { type Entity, World } from "@vworlds/vecs";
import { afterEach, describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Circle,
  Damping,
  DistanceJoint,
  Force,
  JointBodyA,
  JointBodyB,
  LinearVelocity,
  Material,
  PhysicsModule,
  Position,
  Sensor,
} from "../../src/index.js";

const DT_MS = 1000 / 30;
const worlds: World[] = [];

afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.dispose();
  }
});

describe("rigid distance joint initialization (Box2D 3.2)", () => {
  it("holds the anchor distance within 1 cm while pulled straight and turned", () => {
    const { world, ship, trailer, step } = convoy(true);
    connect(world, ship, trailer);

    const start = { ...ship.get(Position)! };
    for (let tick = 1; tick <= 300; tick++) {
      // Five seconds of straight pull, then a turning pull for five seconds.
      const angle = tick <= 150 ? 0 : (tick - 150) * 0.02;
      ship.set(Force, { x: 2 * Math.cos(angle), y: 2 * Math.sin(angle) });
      step();
      expect(Math.abs(separation(ship, trailer) - 1)).toBeLessThan(0.01);
    }

    const end = ship.get(Position)!;
    expect(end.x - start.x).toBeGreaterThan(1);
    expect(end.y - start.y).toBeGreaterThan(1);
  });

  it("swings after far-from-rest creation and resetting only one body's velocity", () => {
    const { world, ship, trailer, step } = convoy(false);
    connect(world, ship, trailer);
    step();

    // The post-solve speed clamp leaves residual motion even though both started at rest.
    expect(speed(ship)).toBeGreaterThan(10);
    expect(speed(trailer)).toBeGreaterThan(10);
    teleport(ship, trailer, false);
    step();

    const a = ship.get(Position)!;
    const b = trailer.get(Position)!;
    // The short x projection is a swing, not compression of the distance constraint.
    expect(a.x - b.x).toBeLessThan(0.95);
    expect(Math.abs(a.y - b.y)).toBeGreaterThan(0.2);
    expect(Math.abs(separation(ship, trailer) - 1)).toBeLessThan(0.03);
    for (let tick = 0; tick < 9; tick++) {
      step();
      expect(Math.abs(separation(ship, trailer) - 1)).toBeLessThan(0.05);
    }
  });

  it.each(["reset both velocities", "create at rest"] as const)(
    "%s keeps the whole teleported assembly stationary at 1 m",
    (remedy) => {
      const { world, ship, trailer, step } = convoy(remedy === "create at rest");
      connect(world, ship, trailer);
      step();
      if (remedy === "reset both velocities") {
        expect(speed(trailer)).toBeGreaterThan(10);
      }

      teleport(ship, trailer, remedy === "reset both velocities");
      for (let tick = 0; tick < 62; tick++) {
        step();
        expect(Math.abs(separation(ship, trailer) - 1)).toBeLessThan(0.001);
        expect(speed(ship)).toBeLessThan(0.001);
        expect(speed(trailer)).toBeLessThan(0.001);
        expect(Math.hypot(ship.get(Position)!.x, ship.get(Position)!.y - 12)).toBeLessThan(0.001);
        expect(
          Math.hypot(trailer.get(Position)!.x + 1, trailer.get(Position)!.y - 12)
        ).toBeLessThan(0.001);
      }
    }
  );

  it("raising the existing speed limit avoids residual motion from this large correction", () => {
    const { world, ship, trailer, step } = convoy(false, 4000);
    connect(world, ship, trailer);
    step();
    expect(speed(ship)).toBeLessThan(0.001);
    expect(speed(trailer)).toBeLessThan(0.001);

    teleport(ship, trailer, false);
    for (let tick = 0; tick < 10; tick++) {
      step();
      expect(Math.abs(separation(ship, trailer) - 1)).toBeLessThan(0.001);
      expect(speed(ship)).toBeLessThan(0.001);
      expect(speed(trailer)).toBeLessThan(0.001);
    }
  });
});

function convoy(atRest: boolean, maximumLinearSpeed = 400) {
  const world = new World();
  worlds.push(world);
  world.module(PhysicsModule, {
    gravity: { x: 0, y: 0 },
    fixedTimeStep: 1 / 30,
    subSteps: 4,
    enableSleep: false,
    maximumLinearSpeed,
  });
  const ship = world
    .entity()
    .set(Body, { type: BodyType.Dynamic })
    .set(Position, { x: -2.048, y: 0 })
    .add(LinearVelocity)
    .set(Damping, { linear: 1.2 });
  world
    .entity()
    .childOf(ship)
    .set(Circle, { radius: 0.12 })
    .set(Material, { density: 1 / (Math.PI * 0.12 ** 2) });
  // Sensor density contributes to the ship mass, as in the reported convoy scene.
  world.entity().childOf(ship).set(Circle, { radius: 0.13 }).add(Sensor);
  const trailer = world
    .entity()
    .set(Body, { type: BodyType.Dynamic })
    .set(Position, atRest ? { x: -3.048, y: 0 } : { x: 25.6, y: 12 })
    .add(LinearVelocity);
  world.entity().childOf(trailer).set(Circle, { radius: 0.1 });
  let clock = 0;
  return {
    world,
    ship,
    trailer,
    step: () => {
      clock += DT_MS;
      world.progress(clock, DT_MS);
    },
  };
}

function connect(world: World, a: Entity, b: Entity): void {
  // Missing JointFrame means origin anchors: body separation is anchor separation.
  world.entity().add(JointBodyA, a).add(JointBodyB, b).set(DistanceJoint, { length: 1 });
}

function teleport(ship: Entity, trailer: Entity, resetBoth: boolean): void {
  ship.set(Position, { x: 0, y: 12 }).set(LinearVelocity, { x: 0, y: 0 });
  trailer.set(Position, { x: -1, y: 12 });
  if (resetBoth) {
    trailer.set(LinearVelocity, { x: 0, y: 0 });
  }
}

function separation(a: Entity, b: Entity): number {
  const pa = a.get(Position)!;
  const pb = b.get(Position)!;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

function speed(body: Entity): number {
  const velocity = body.get(LinearVelocity)!;
  return Math.hypot(velocity.x, velocity.y);
}
