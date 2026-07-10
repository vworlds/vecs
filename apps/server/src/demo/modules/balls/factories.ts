import { type Entity, type World } from "@vworlds/vecs";
import {
  Container,
  Ellipse,
  FillStyle,
  Offset,
  Polygon,
  Position as RenderPosition,
  Rotation as RenderRotation,
  Size,
} from "@vworlds/vecs-phaser";
import {
  AngularVelocity as PhysicsAngularVelocity,
  Body,
  BodyType,
  Circle,
  LinearVelocity as PhysicsVelocity,
  Material,
  Position as PhysicsPosition,
  Rotation as PhysicsRotation,
} from "@vworlds/vecs-physics";
import { Networked } from "@vworlds/vecs-server";
import { BALL_RADIUS, ELECTRON_DISTANCE, ELECTRON_SIZE } from "../../config.js";
import { randomFloat, randomInt, randomSignedFloat } from "../../math.js";
import { Electron } from "../local-offsets/components.js";
import { Ball } from "./components.js";

export function spawnBall(world: World, point: { x: number; y: number }): void {
  const body = world
    .entity()
    .add(Networked)
    .add(Ball)
    .add(Container)
    .set(RenderPosition, point)
    .set(RenderRotation, { angle: 0 })
    .set(PhysicsPosition, point)
    .set(PhysicsRotation, { angle: 0 })
    .set(PhysicsAngularVelocity, { value: randomSignedFloat(2, 8) })
    .set(Body, { type: BodyType.Dynamic })
    .set(PhysicsVelocity, {
      x: randomSignedFloat(0.6, 1.5),
      y: randomSignedFloat(0.6, 1.2),
    });

  // Visual shape: a child of the ball Container at local (0,0).
  world
    .entity()
    .childOf(body)
    .add(Networked)
    .set(Polygon, { points: regularHexagonPoints(BALL_RADIUS) })
    .set(FillStyle, randomFillStyle())
    .set(Offset, { x: 0, y: 0 });

  // Collider: unchanged, a physics-only child.
  world
    .entity()
    .childOf(body)
    .set(Circle, { radius: BALL_RADIUS })
    .set(Material, { friction: 0.6, restitution: 0.7 });

  createElectron(world, body);
}

function createElectron(world: World, ball: Entity): Entity {
  const angle = randomFloat(0, Math.PI * 2);
  const radius = randomFloat(ELECTRON_DISTANCE * 0.85, ELECTRON_DISTANCE * 1.2);

  // Intermediate orbit Container: rotating this orbits the electron around
  // the ball centre. The electron is at a fixed Offset inside it.
  const orbit = world
    .entity()
    .childOf(ball)
    .add(Networked)
    .add(Container)
    .set(RenderRotation, { angle })
    .set(Electron, {
      angle,
      radius,
      speed: randomSignedFloat(0.08, 0.16),
    });

  return world
    .entity()
    .childOf(orbit)
    .add(Networked)
    .add(Ellipse)
    .set(Size, { width: ELECTRON_SIZE, height: ELECTRON_SIZE })
    .set(FillStyle, { color: 0x9bf6ff, alpha: 1 })
    .set(Offset, { x: radius, y: 0 });
}

function regularHexagonPoints(radius: number): number[] {
  return Array.from({ length: 6 }, (_value, i) => {
    const angle = (i * Math.PI) / 3;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  }).flat();
}

function randomFillStyle(): Partial<FillStyle> {
  const r = randomInt(80, 255);
  const g = randomInt(80, 255);
  const b = randomInt(80, 255);
  return {
    color: (r << 16) | (g << 8) | b,
  };
}
