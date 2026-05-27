import { Entity } from "./entity.js";
import { Identity } from "./entity.identity.js";

export class IdentityModule extends Entity {
  public init(): void {
    this.world.component(Identity);
  }
}
