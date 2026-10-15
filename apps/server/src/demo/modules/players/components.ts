import { Module, type Entity } from "@vworlds/vecs";
import { field } from "@vworlds/vecs-mcp/schema";

export class Player {
  /** Number of collected balls. */
  @field({
    type: "integer",
    min: 0,
    description: "Collected balls",
    validate: (value) => ((value as number) > 1000000 ? "score exceeds demo limit" : undefined),
  })
  public score = 0;
  /** Entity displaying the current score. */
  @field({ type: "entity", optional: true, readOnly: true, description: "Score label entity" })
  public scoreText?: Entity;
}

export class PlayerComponents extends Module {
  public init(): void {
    this.world.component(Player);
  }
}
