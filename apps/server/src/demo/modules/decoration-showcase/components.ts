import { Module } from "@vworlds/vecs";

export class RotatingDecoration {
  public speed = 0.025;
}

export class DecorationShowcaseComponents extends Module {
  public init(): void {
    this.world.component(RotatingDecoration);
  }
}
