import { Module } from "@vworlds/vecs";
import { Position as RenderPosition } from "@vworlds/vecs-phaser";
import { NetworkClient, Networked } from "@vworlds/vecs-server";
import { PLAYER_HALF_SIZE } from "../../config.js";
import { clamp } from "../../math.js";
import { Ball, BallComponents } from "../balls/components.js";
import { Player, PlayerComponents } from "../players/components.js";
import { syncScoreText } from "../players/module.js";
import { forEachNearbyCell, getGridCellIndex } from "../spatial-interest/grid.js";

export class PlayerBallCollectionModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(BallComponents);
    world.module(PlayerComponents);

    const ballsByCell = world
      .query("CollectableBallsByCell")
      .with(Networked, Ball, RenderPosition)
      .groupBy([RenderPosition], (_entity, [position]: [RenderPosition]) =>
        getGridCellIndex(position)
      );

    world
      .system("CollectBalls")
      .with(Networked, NetworkClient, Player, RenderPosition)
      .each([Player, RenderPosition], (_entity, [player, position]) => {
        forEachNearbyCell(position, (cellIndex) => {
          ballsByCell
            .group(cellIndex)
            ?.forEach([RenderPosition, Ball], (ballEntity, [ballPosition, ball]) => {
              if (!overlaps(position, ballPosition, ball.radius)) {
                return;
              }

              player.score += 1;
              ballEntity.destroy();
            });
        });

        syncScoreText(player, position);
      });
  }
}

function overlaps(
  playerPosition: RenderPosition,
  ballPosition: RenderPosition,
  ballRadius: number
): boolean {
  const closestX = clamp(
    ballPosition.x,
    playerPosition.x - PLAYER_HALF_SIZE,
    playerPosition.x + PLAYER_HALF_SIZE
  );
  const closestY = clamp(
    ballPosition.y,
    playerPosition.y - PLAYER_HALF_SIZE,
    playerPosition.y + PLAYER_HALF_SIZE
  );
  return Math.hypot(ballPosition.x - closestX, ballPosition.y - closestY) <= ballRadius;
}
