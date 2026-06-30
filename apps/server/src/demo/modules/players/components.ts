import { Module, type Entity } from "@vworlds/vecs";

export class Player {
  public score = 0;
  public scoreText?: Entity;
}

export class PlayerComponents extends Module {
  public init(): void {
    this.world.component(Player);
  }
}
