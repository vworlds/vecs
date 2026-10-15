import { Module } from "@vworlds/vecs";
import { field } from "@vworlds/vecs-mcp/schema";

export class Electron {
  /** Current orbital angle. */
  @field({ type: "number", unit: "rad", description: "Current orbital angle" })
  public angle = 0;
  public radius = 0;
  /** Orbital angular speed. */
  @field({
    type: "number",
    unit: "rad/tick",
    min: -1,
    max: 1,
    description: "Orbital angular speed",
  })
  public speed = 0.12;
}

export class LocalOffsetComponents extends Module {
  public init(): void {
    this.world.component(Electron);
  }
}
