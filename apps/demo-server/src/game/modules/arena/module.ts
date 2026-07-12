import { Module } from "@vworlds/vecs";
import {
  Depth,
  FillStyle,
  Image,
  Position as RenderPosition,
  Rectangle,
  Size,
} from "@vworlds/vecs-phaser";
import {
  Body,
  BodyType,
  Box,
  Chain,
  Material,
  Position as PhysicsPosition,
} from "@vworlds/vecs-physics";
import { Networked } from "@vworlds/vecs-server";
import { ARENA_HALF_HEIGHT, ARENA_HALF_WIDTH, FRAME_WALL } from "../../config.js";
import { GameAssets } from "../assets/module.js";

const WALL_THICKNESS = 0.4;
const OBSTACLE_SIZE = 0.9;

/**
 * The static battlefield: one looped Chain collider along the arena border
 * (with lively restitution so shells bounce), four border Rectangles for the
 * visuals, and a handful of brick obstacles — each an Image showing the wall
 * tile with a matching static Box collider.
 *
 * Obstacle placement is a fixed symmetric layout (Combat-style), not random:
 * a teaching demo should be deterministic.
 */
export class ArenaModule extends Module {
  public init(): void {
    const world = this.world;
    const w = ARENA_HALF_WIDTH;
    const h = ARENA_HALF_HEIGHT;

    // Border collider: a single static body with a looped chain.
    const border = world.entity().set(Body, { type: BodyType.Static });
    world
      .entity()
      .childOf(border)
      .set(Chain, {
        loop: true,
        points: [
          { x: -w, y: -h },
          { x: w, y: -h },
          { x: w, y: h },
          { x: -w, y: h },
        ],
      })
      .set(Material, { friction: 0.2, restitution: 0.9 });

    // Border visuals: four thin rectangles hugging the chain.
    const wallStyle = { alpha: 1, color: 0x3a3c44 };
    const horizontal = { height: WALL_THICKNESS, width: w * 2 + WALL_THICKNESS * 2 };
    const vertical = { height: h * 2, width: WALL_THICKNESS };
    const walls: { x: number; y: number; size: { width: number; height: number } }[] = [
      { size: horizontal, x: 0, y: h + WALL_THICKNESS / 2 },
      { size: horizontal, x: 0, y: -h - WALL_THICKNESS / 2 },
      { size: vertical, x: w + WALL_THICKNESS / 2, y: 0 },
      { size: vertical, x: -w - WALL_THICKNESS / 2, y: 0 },
    ];
    for (const wall of walls) {
      world
        .entity()
        .add(Networked)
        .add(Rectangle)
        .set(RenderPosition, { x: wall.x, y: wall.y })
        .set(Size, wall.size)
        .set(FillStyle, wallStyle)
        .set(Depth, { value: 5 });
    }

    // Brick obstacles: symmetric cover blocks.
    const positions = [
      { x: -6, y: 2.5 },
      { x: -6, y: -2.5 },
      { x: 6, y: 2.5 },
      { x: 6, y: -2.5 },
      { x: 0, y: 4 },
      { x: 0, y: -4 },
      { x: -2.5, y: 0 },
      { x: 2.5, y: 0 },
    ];
    const arenaTiles = world.get(GameAssets)!.arena;
    for (const point of positions) {
      const obstacle = world
        .entity()
        .add(Networked)
        .set(RenderPosition, point)
        .set(PhysicsPosition, point)
        .set(Image, { frame: FRAME_WALL, texture: arenaTiles.id })
        .set(Size, { height: OBSTACLE_SIZE, width: OBSTACLE_SIZE })
        .set(Body, { type: BodyType.Static })
        .set(Depth, { value: 4 });
      world
        .entity()
        .childOf(obstacle)
        .set(Box, { hx: OBSTACLE_SIZE / 2, hy: OBSTACLE_SIZE / 2 })
        .set(Material, { friction: 0.2, restitution: 0.9 });
    }
  }
}
