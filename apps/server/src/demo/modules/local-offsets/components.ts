import { Module, type, range, unit, description } from "@vworlds/vecs";

export class Electron {
  /** Current orbital angle. */
  @type("f64")
  @unit("rad")
  @description("Current orbital angle")
  public angle = 0;
  @type("f64") public radius = 0;
  /** Orbital angular speed. */
  @type("f64")
  @range(-1, 1)
  @unit("rad/tick")
  @description("Orbital angular speed")
  public speed = 0.12;
}

export class LocalOffsetComponents extends Module {
  public init(): void {
    this.world.component(Electron);
  }
}
