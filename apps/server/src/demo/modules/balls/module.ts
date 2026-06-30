import { Module } from "@vworlds/vecs";
import { Position as RenderPosition } from "@vworlds/vecs-phaser";
import { Networked } from "@vworlds/vecs-server";
import {
  BALL_RADIUS,
  GRID_CELL_COUNT,
  MAX_BALLS,
  WORLD_MAX_X,
  WORLD_MAX_Y,
  WORLD_MIN_X,
  WORLD_MIN_Y,
} from "../../config.js";
import { randomFloat } from "../../math.js";
import { LocalOffsetComponents } from "../local-offsets/components.js";
import {
  InCell,
  InterestGridState,
  SpatialInterestComponents,
} from "../spatial-interest/components.js";
import { getGridCellIndex, randomPointInCell } from "../spatial-interest/grid.js";
import { Ball, BallComponents } from "./components.js";
import { spawnBall } from "./factories.js";

export class BallsModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(BallComponents);
    world.module(LocalOffsetComponents);
    world.module(SpatialInterestComponents);

    const ballsByCell = world
      .query("BallsByCell")
      .with(Networked, Ball, RenderPosition)
      .groupBy([RenderPosition], (_entity, [position]: [RenderPosition]) =>
        getGridCellIndex(position)
      );

    const occupancyByCell = world
      .query("OccupancyByCell")
      .with(Networked, RenderPosition)
      .groupBy(InCell);

    world
      .system("SpawnBalls")
      .interval(2)
      .run(() => {
        if (ballsByCell.count < MAX_BALLS) {
          const grid = world.get(InterestGridState);
          if (grid === undefined || grid.cellEntities.length === 0) {
            spawnBall(world, randomPointInArena());
            return;
          }

          let bestIndex = 0;
          let bestCount = Infinity;
          for (let index = 0; index < GRID_CELL_COUNT; index++) {
            const count = occupancyByCell.group(grid.cellEntities[index])?.count ?? 0;
            if (count < bestCount) {
              bestCount = count;
              bestIndex = index;
            }
          }
          spawnBall(world, randomPointInCell(bestIndex, BALL_RADIUS));
        }
      });

    spawnBall(world, { x: -3.7, y: 1.5 });
  }
}

function randomPointInArena(): { x: number; y: number } {
  return {
    x: randomFloat(WORLD_MIN_X + BALL_RADIUS, WORLD_MAX_X - BALL_RADIUS),
    y: randomFloat(WORLD_MIN_Y + BALL_RADIUS, WORLD_MAX_Y - BALL_RADIUS),
  };
}
