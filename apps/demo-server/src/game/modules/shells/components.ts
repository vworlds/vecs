import { Module, type Entity } from "@vworlds/vecs";

/** A shell in flight. Lives on the shell body entity. */
export class Shell {
  /** The tank entity that fired it (credited with kills, immune briefly). */
  public shooter!: Entity;
}

/** Component registration for the shells feature. */
export class ShellComponents extends Module {
  public init(): void {
    this.world.component(Shell);
  }
}
