import { Module } from "@vworlds/vecs";
import {
  Image,
  Position as RenderPosition,
  Rotation as RenderRotation,
  Tint,
} from "@vworlds/vecs-phaser";
import {
  AngularVelocity as PhysicsAngularVelocity,
  Body,
  BodyType,
  Box,
  LinearVelocity as PhysicsVelocity,
  Material,
  Position as PhysicsPosition,
  Rotation as PhysicsRotation,
} from "@vworlds/vecs-physics";
import { Networked } from "@vworlds/vecs-server";
import { PIXELS_PER_METER, WORLD_MAX_X, WORLD_MAX_Y, WORLD_MIN_X } from "../../config.js";
import { randomFloat, randomInt, randomSignedFloat } from "../../math.js";
import { DemoAssets } from "../assets/components.js";

export class BrickShowcaseModule extends Module {
  public init(): void {
    const assets = this.world.get(DemoAssets);
    if (assets === undefined) {
      return;
    }

    const world = this.world;
    const bricks = assets.bricks;

    const staticFrames = [0, 2, 4, 5];
    const rowY = WORLD_MAX_Y - 0.8;
    const brickSpacing = 0.8;
    const startX = -((staticFrames.length - 1) * brickSpacing) / 2;
    for (let i = 0; i < staticFrames.length; i++) {
      world
        .entity()
        .add(Networked)
        .set(Image, { texture: bricks.id, frame: staticFrames[i] })
        .set(RenderPosition, { x: startX + i * brickSpacing, y: rowY });
    }

    const size = bricks.sizeInMeters(PIXELS_PER_METER);
    const dynamicBrickCount = 6;
    for (let i = 0; i < dynamicBrickCount; i++) {
      const frame = randomInt(0, bricks.tileCount - 1);
      const angle = randomFloat(0, Math.PI * 2);
      const start = {
        x: randomFloat(WORLD_MIN_X + size.w, WORLD_MAX_X - size.w),
        y: WORLD_MAX_Y - 1.4 - i * 0.45,
      };
      const body = world
        .entity()
        .add(Networked)
        .set(Image, { texture: bricks.id, frame })
        .set(RenderPosition, start)
        .set(RenderRotation, { angle })
        .set(Tint, { value: randomBrickTint() } as Partial<Tint>)
        .set(PhysicsPosition, start)
        .set(PhysicsRotation, { angle })
        .set(PhysicsAngularVelocity, { value: randomSignedFloat(3, 9) })
        .set(PhysicsVelocity, {
          x: randomSignedFloat(0.8, 2.4),
          y: randomSignedFloat(0.4, 1.4),
        })
        .set(Body, { type: BodyType.Dynamic });
      world
        .entity()
        .childOf(body)
        .set(Box, { hx: size.w / 2, hy: size.h / 2 })
        .set(Material, { friction: 0.4, restitution: 0.85 });
    }
  }
}

function randomBrickTint(): number {
  const palette = [0xffcc88, 0x88ddff, 0xff88cc, 0xaaff88, 0xddaaff, 0xffaa66];
  return palette[randomInt(0, palette.length - 1)]!;
}
