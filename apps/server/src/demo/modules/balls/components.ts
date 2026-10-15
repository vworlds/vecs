import { Module } from "@vworlds/vecs";
import { field } from "@vworlds/vecs-mcp/schema";
import { BALL_RADIUS } from "../../config.js";

export class Ball {
  /** Visual/physics spawn radius, in metres. */
  @field({ type: "number", unit: "m", min: 0.01, max: 5, description: "Ball radius at spawn" })
  public radius = BALL_RADIUS;
}

export class BallComponents extends Module {
  public init(): void {
    this.world.component(Ball);
  }
}
