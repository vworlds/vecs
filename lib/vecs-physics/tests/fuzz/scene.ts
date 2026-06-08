import { type Entity, World } from "@vworlds/vecs";

import {
  AngularImpulse,
  AngularVelocity,
  Body,
  BodyType,
  Box,
  Capsule,
  Chain,
  Circle,
  CollisionFilter,
  Force,
  Impulse,
  KinematicTargetPosition,
  LinearVelocity,
  Material,
  Polygon,
  Position,
  Rotation,
  Segment,
  Sensor,
  Torque,
  PhysicsModule,
  type Vec2,
} from "../../src/index.js";
import { Rng } from "./rng.js";

export type FuzzScene = {
  bodies: Entity[];
  driveStep(step: number): void;
  world: World;
};

const BODY_TYPES = [BodyType.Dynamic, BodyType.Kinematic, BodyType.Static] as const;
const CATEGORIES = [1, 2, 4, 8, 16, 32, 64, 128] as const;
const DT = 1 / 60;

export function buildFuzzScene(seed: number): FuzzScene {
  const rng = new Rng(seed);
  const impulseRng = new Rng(seed ^ 0x9e3779b9);
  const world = new World();
  world.module(PhysicsModule, {
    debug: true,
    enableSleep: true,
    fixedTimeStep: DT,
    gravity: { x: 0, y: -10 },
    subSteps: 2,
  });

  const bodies: Entity[] = [];
  const drivenBodies: Entity[] = [];
  const impulseBodies: Entity[] = [];

  addStaticBoundaries(world, bodies);
  addCoverageBodies(world, rng, bodies, drivenBodies, impulseBodies);

  const randomBodyCount = rng.int(8, 12);
  for (let i = 0; i < randomBodyCount; i++) {
    const bodyType = rng.choice(BODY_TYPES);
    const body = createBody(world, rng, bodyType);
    addRandomShape(world, rng, body, bodyType, i);
    bodies.push(body);

    if (bodyType === BodyType.Kinematic && rng.bool(0.7)) {
      addKinematicDriver(rng, body);
      drivenBodies.push(body);
    }
    if (bodyType === BodyType.Dynamic) {
      if (rng.bool(0.65)) {
        body.set(Force, { x: rng.signed(8), y: rng.range(-2, 12), wake: true });
      }
      if (rng.bool(0.45)) {
        body.set(Torque, { value: rng.signed(4), wake: true });
      }
      if (rng.bool(0.75)) {
        impulseBodies.push(body);
      }
    }
  }

  return {
    bodies,
    driveStep(step: number): void {
      for (const body of impulseBodies) {
        body.set(Impulse, {
          x: impulseRng.signed(0.45),
          y: impulseRng.range(-0.05, 0.55),
          wake: true,
        });
        body.set(AngularImpulse, { value: impulseRng.signed(0.25), wake: true });
      }

      if (step % 45 === 0) {
        for (const body of drivenBodies) {
          const position = body.get(Position)!;
          body.set(KinematicTargetPosition, {
            x: position.x + impulseRng.signed(1.5),
            y: impulseRng.range(0.5, 5),
            tolerance: 0.01,
            wake: true,
          });
        }
      }
    },
    world,
  };
}

function addCoverageBodies(
  world: World,
  rng: Rng,
  bodies: Entity[],
  drivenBodies: Entity[],
  impulseBodies: Entity[]
): void {
  const box = createBody(world, rng, BodyType.Dynamic, -5, 4);
  addShape(world, rng, box, BodyType.Dynamic, "box", false);
  box.set(Force, { x: 3, y: 2, wake: true }).set(Torque, { value: 0.6, wake: true });
  bodies.push(box);
  impulseBodies.push(box);

  const circle = createBody(world, rng, BodyType.Dynamic, -2, 5);
  addShape(world, rng, circle, BodyType.Dynamic, "circle", false);
  bodies.push(circle);
  impulseBodies.push(circle);

  const capsule = createBody(world, rng, BodyType.Dynamic, 1, 6);
  addShape(world, rng, capsule, BodyType.Dynamic, "capsule", false);
  bodies.push(capsule);

  const polygon = createBody(world, rng, BodyType.Dynamic, 4, 5);
  addShape(world, rng, polygon, BodyType.Dynamic, "polygon", false);
  bodies.push(polygon);

  const segment = createBody(world, rng, BodyType.Static, 0, 1.5);
  addShape(world, rng, segment, BodyType.Static, "segment", false);
  bodies.push(segment);

  const chain = createBody(world, rng, BodyType.Static, 0, -1);
  addShape(world, rng, chain, BodyType.Static, "chain", false);
  bodies.push(chain);

  const sensor = createBody(world, rng, BodyType.Static, 3, 2.5);
  addShape(world, rng, sensor, BodyType.Static, "circle", true);
  bodies.push(sensor);

  const kinematic = createBody(world, rng, BodyType.Kinematic, -3, 2.5);
  addShape(world, rng, kinematic, BodyType.Kinematic, "box", false);
  addKinematicDriver(rng, kinematic);
  bodies.push(kinematic);
  drivenBodies.push(kinematic);
}

function addKinematicDriver(rng: Rng, body: Entity): void {
  const position = body.get(Position)!;
  body.set(KinematicTargetPosition, {
    x: position.x + rng.signed(2),
    y: position.y + rng.signed(1),
    tolerance: 0.01,
    wake: true,
  });
}

function addRandomShape(
  world: World,
  rng: Rng,
  body: Entity,
  bodyType: BodyType,
  index: number
): void {
  const geometries = bodyType === BodyType.Dynamic ? DYNAMIC_GEOMETRIES : ALL_GEOMETRIES;
  const geometry = rng.choice(geometries);
  const sensor = bodyType !== BodyType.Dynamic && (index % 5 === 0 || rng.bool(0.15));
  addShape(world, rng, body, bodyType, geometry, sensor);
}

const ALL_GEOMETRIES = ["box", "circle", "capsule", "polygon", "segment", "chain"] as const;
const DYNAMIC_GEOMETRIES = ["box", "circle", "capsule", "polygon"] as const;
type GeometryKind = (typeof ALL_GEOMETRIES)[number];

function addShape(
  world: World,
  rng: Rng,
  body: Entity,
  bodyType: BodyType,
  geometry: GeometryKind,
  sensor: boolean
): Entity {
  const shape = world
    .entity()
    .childOf(body)
    .set(Material, randomMaterial(rng, bodyType))
    .set(CollisionFilter, randomFilter(rng));

  if (sensor) {
    shape.add(Sensor);
  }

  switch (geometry) {
    case "box":
      shape.set(Box, { hx: rng.range(0.2, 1.25), hy: rng.range(0.2, 1.25) });
      break;
    case "circle":
      shape.set(Circle, { radius: rng.range(0.15, 0.9) });
      break;
    case "capsule": {
      const angle = rng.range(0, Math.PI);
      const halfLength = rng.range(0.35, 1.25);
      const dx = Math.cos(angle) * halfLength;
      const dy = Math.sin(angle) * halfLength;
      shape.set(Capsule, {
        radius: rng.range(0.08, 0.35),
        x1: -dx,
        x2: dx,
        y1: -dy,
        y2: dy,
      });
      break;
    }
    case "segment": {
      const angle = rng.range(-0.8, 0.8);
      const halfLength = rng.range(0.75, 2.5);
      const dx = Math.cos(angle) * halfLength;
      const dy = Math.sin(angle) * halfLength;
      shape.set(Segment, { x1: -dx, x2: dx, y1: -dy, y2: dy });
      break;
    }
    case "polygon":
      shape.set(Polygon, { radius: rng.range(0, 0.05), vertices: randomConvexPolygon(rng) });
      break;
    case "chain":
      shape.set(Chain, { loop: false, points: randomChain(rng) });
      break;
  }

  return shape;
}

function addStaticBoundaries(world: World, bodies: Entity[]): void {
  const ground = world.entity().set(Body, { type: BodyType.Static }).set(Position, { x: 0, y: -3 });
  world.entity().childOf(ground).set(Box, { hx: 12, hy: 0.5 });
  bodies.push(ground);

  const leftWall = world
    .entity()
    .set(Body, { type: BodyType.Static })
    .set(Position, { x: -8, y: 2 });
  world.entity().childOf(leftWall).set(Segment, { x1: 0, x2: 0, y1: -5, y2: 5 });
  bodies.push(leftWall);

  const rightWall = world
    .entity()
    .set(Body, { type: BodyType.Static })
    .set(Position, { x: 8, y: 2 });
  world.entity().childOf(rightWall).set(Segment, { x1: 0, x2: 0, y1: -5, y2: 5 });
  bodies.push(rightWall);
}

function createBody(
  world: World,
  rng: Rng,
  type: BodyType,
  x = rng.range(-6, 6),
  y = rng.range(0, 8)
): Entity {
  const dynamic = type === BodyType.Dynamic;
  return world
    .entity()
    .set(Body, { allowFastRotation: rng.bool(0.1), bullet: dynamic && rng.bool(0.2), type })
    .set(Position, { x, y })
    .set(Rotation, { angle: rng.signed(Math.PI) })
    .set(LinearVelocity, { x: dynamic ? rng.signed(2) : 0, y: dynamic ? rng.signed(1) : 0 })
    .set(AngularVelocity, { value: dynamic ? rng.signed(1) : 0 });
}

function randomChain(rng: Rng): Vec2[] {
  const points: Vec2[] = [];
  const count = rng.int(4, 6);
  for (let i = 0; i < count; i++) {
    points.push({ x: -2 + i * rng.range(0.8, 1.1), y: rng.signed(0.5) });
  }
  return points;
}

function randomConvexPolygon(rng: Rng): Vec2[] {
  const vertices: Vec2[] = [];
  const count = rng.int(3, 6);
  const rotation = rng.range(0, Math.PI * 2);
  const radiusX = rng.range(0.35, 1.1);
  const radiusY = rng.range(0.35, 1.1);
  for (let i = 0; i < count; i++) {
    const angle = rotation + (i / count) * Math.PI * 2;
    vertices.push({ x: Math.cos(angle) * radiusX, y: Math.sin(angle) * radiusY });
  }
  return vertices;
}

function randomFilter(rng: Rng): Partial<CollisionFilter> {
  const categoryBits = rng.choice(CATEGORIES);
  let maskBits = 0;
  for (const category of CATEGORIES) {
    if (rng.bool(0.65)) {
      maskBits |= category;
    }
  }
  return {
    categoryBits,
    groupIndex: rng.bool(0.9) ? 0 : rng.choice([-1, 1]),
    maskBits: maskBits === 0 ? 0xffffffff : maskBits,
  };
}

function randomMaterial(rng: Rng, bodyType: BodyType): Partial<Material> {
  return {
    density: bodyType === BodyType.Dynamic ? rng.range(0.2, 4) : rng.range(0, 1),
    friction: rng.range(0, 1.2),
    restitution: rng.range(0, 0.8),
    rollingResistance: rng.range(0, 0.05),
    tangentSpeed: rng.signed(0.5),
    userMaterialId: rng.int(0, 8),
  };
}
