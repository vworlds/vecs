import { Module } from "../module.js";

export class Identity {
  public name = "";
}

export class IdentityModule extends Module {
  public init(): void {
    this.world.component(Identity);
  }
}
