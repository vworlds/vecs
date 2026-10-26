import { Module, type Entity, type, range, description } from "@vworlds/vecs";
import { field } from "@vworlds/vecs-mcp/schema";

export class Player {
  /** Number of collected balls. */
  @type("i32")
  @range(0, 1000000)
  @description("Collected balls")
  public score = 0;
  /** Entity displaying the current score. */
  @type("entity")
  @description("Score label entity")
  @field({ optional: true, readOnly: true })
  public scoreText?: Entity;

  /** Validate agent-edited scores, preserving the demo's custom limit message. */
  public static vecs_validate(player: Player): true | string {
    if (!Number.isInteger(player.score) || player.score < 0) {
      return "score must be a non-negative integer";
    }
    return player.score > 1000000 ? "score exceeds demo limit" : true;
  }
}

export class PlayerComponents extends Module {
  public init(): void {
    this.world.component(Player);
  }
}
