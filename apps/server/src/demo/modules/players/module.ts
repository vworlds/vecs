import { Module, type Entity } from "@vworlds/vecs";
import {
  FillStyle,
  Position as RenderPosition,
  Rectangle,
  Size,
  Text,
  TextAlign,
} from "@vworlds/vecs-phaser";
import { NetworkClient, Networked, NetworkInput } from "@vworlds/vecs-server";
import {
  PLAYER_HALF_SIZE,
  PLAYER_SIZE,
  PLAYER_STEP,
  SCORE_OFFSET_Y,
  WORLD_MAX_X,
  WORLD_MAX_Y,
  WORLD_MIN_X,
  WORLD_MIN_Y,
} from "../../config.js";
import { clamp, updateRenderPosition } from "../../math.js";
import { SpatialInterestComponents, ViewAll } from "../spatial-interest/components.js";
import { Player, PlayerComponents } from "./components.js";
import { normalizeInput } from "./input.js";

export class PlayersModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PlayerComponents);
    world.module(SpatialInterestComponents);

    let playerSpawnIndex = 0;

    world
      .system("SpawnPlayers")
      .with(Networked, NetworkClient)
      .enter((entity) => {
        const spawn = nextPlayerSpawnPoint(playerSpawnIndex++);
        const scoreText = createScoreText(world, entity, spawn);
        entity
          .set(RenderPosition, spawn)
          .add(Rectangle)
          .set(Size, { width: PLAYER_SIZE, height: PLAYER_SIZE })
          .set(FillStyle, { color: 0x66ccff, alpha: 1 })
          .set(Player, { scoreText })
          .add(ViewAll);
      });

    world
      .system("MovePlayers")
      .with(Networked, NetworkClient, NetworkInput, Player, RenderPosition)
      .each([NetworkInput, Player, RenderPosition], (entity, [networkInput, player, position]) => {
        const input = normalizeInput(networkInput.input);
        syncViewAll(entity, input.viewAll === true);

        const x = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        const y = (input.up ? 1 : 0) - (input.down ? 1 : 0);
        const nextX = clamp(
          position.x + x * PLAYER_STEP,
          WORLD_MIN_X + PLAYER_HALF_SIZE,
          WORLD_MAX_X - PLAYER_HALF_SIZE
        );
        const nextY = clamp(
          position.y + y * PLAYER_STEP,
          WORLD_MIN_Y + PLAYER_HALF_SIZE,
          WORLD_MAX_Y - PLAYER_HALF_SIZE
        );

        updateRenderPosition(entity, position, nextX, nextY);
        syncScoreText(player, position);
      });
  }
}

export function syncScoreText(player: Player, playerPosition: RenderPosition): void {
  const scoreTextEntity = player.scoreText;
  if (scoreTextEntity === undefined) {
    return;
  }

  const textPosition = scoreTextEntity.get(RenderPosition);
  if (textPosition !== undefined) {
    const next = scoreTextPosition(playerPosition);
    updateRenderPosition(scoreTextEntity, textPosition, next.x, next.y);
  }

  const text = scoreTextEntity.get(Text);
  const score = String(player.score);
  if (text !== undefined && text.value !== score) {
    scoreTextEntity.set(Text, { value: score });
  }
}

function nextPlayerSpawnPoint(playerIndex: number): { x: number; y: number } {
  return {
    x: clamp(
      WORLD_MIN_X + PLAYER_HALF_SIZE + 0.5 + (playerIndex % 8) * 0.7,
      WORLD_MIN_X + PLAYER_HALF_SIZE,
      WORLD_MAX_X - PLAYER_HALF_SIZE
    ),
    y: clamp(
      WORLD_MAX_Y - PLAYER_HALF_SIZE - 0.5 - Math.floor(playerIndex / 8) * 0.45,
      WORLD_MIN_Y + PLAYER_HALF_SIZE,
      WORLD_MAX_Y - PLAYER_HALF_SIZE
    ),
  };
}

function createScoreText(
  world: { entity(): Entity },
  playerEntity: Entity,
  playerPosition: { x: number; y: number }
): Entity {
  return world
    .entity()
    .childOf(playerEntity)
    .add(Networked)
    .set(RenderPosition, scoreTextPosition(playerPosition))
    .set(Text, {
      value: "0",
      fontFamily: "monospace",
      fontSize: 18,
      color: 0xffffff,
      align: TextAlign.Center,
    });
}

function scoreTextPosition(playerPosition: { x: number; y: number }): { x: number; y: number } {
  return { x: playerPosition.x, y: playerPosition.y + SCORE_OFFSET_Y };
}

function syncViewAll(entity: Entity, enabled: boolean): void {
  const hasViewAll = entity.get(ViewAll) !== undefined;
  if (enabled === hasViewAll) {
    return;
  }
  if (enabled) {
    entity.add(ViewAll);
  } else {
    entity.remove(ViewAll);
  }
}
