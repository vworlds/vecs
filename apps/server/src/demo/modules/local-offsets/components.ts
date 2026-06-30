import { Module } from "@vworlds/vecs";

export class Electron {
  public angle = 0;
  public radius = 0;
  public speed = 0.12;
}

export class Offset {
  public x = 0;
  public y = 0;
}

export class LocalOffsetComponents extends Module {
  public init(): void {
    this.world.component(Electron);
    this.world.component(Offset);
  }
}
