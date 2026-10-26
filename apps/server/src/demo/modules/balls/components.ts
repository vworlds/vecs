import { Module, type, range, unit, description } from "@vworlds/vecs";
import { BALL_RADIUS } from "../../config.js";

export class Ball {
  /** Visual/physics spawn radius, in metres. */
  @type("f64")
  @range(0.01, 5)
  @unit("m")
  @description("Ball radius at spawn")
  public radius = BALL_RADIUS;
}

export class BallComponents extends Module {
  public init(): void {
    this.world.component(Ball);
  }
}
