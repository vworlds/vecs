import { Module } from "@vworlds/vecs";
import { BALL_RADIUS } from "../../config.js";

export class Ball {
  public radius = BALL_RADIUS;
}

export class BallComponents extends Module {
  public init(): void {
    this.world.component(Ball);
  }
}
