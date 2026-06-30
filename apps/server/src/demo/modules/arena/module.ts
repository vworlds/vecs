import { Module } from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Chain,
  Material,
  Position as PhysicsPosition,
} from "@vworlds/vecs-physics";
import { WORLD_MAX_X, WORLD_MAX_Y, WORLD_MIN_X, WORLD_MIN_Y } from "../../config.js";

export class ArenaModule extends Module {
  public init(): void {
    const walls = this.world.entity().set(PhysicsPosition, { x: 0, y: 0 }).set(Body, {
      type: BodyType.Static,
    });

    this.world
      .entity()
      .childOf(walls)
      .set(Chain, {
        points: [
          { x: WORLD_MAX_X, y: WORLD_MAX_Y },
          { x: WORLD_MAX_X, y: WORLD_MIN_Y },
          { x: WORLD_MIN_X, y: WORLD_MIN_Y },
          { x: WORLD_MIN_X, y: WORLD_MAX_Y },
        ],
        loop: true,
      })
      .set(Material, { density: 0, friction: 0.6, restitution: 0.7 });
  }
}
