import { type System } from "./system.js";
import { type World } from "./world.js";

export class Phase {
  public systems: System[] = [];

  constructor(public readonly name: string, public world: World) {}
}

export interface IPhase {
  get name(): string;
  get world(): World;
}
