import { Identity } from "../entity/index.js";
import { Module } from "../module.js";

export class IdentityModule extends Module {
  public init(): void {
    this.world.component(Identity);
  }
}
