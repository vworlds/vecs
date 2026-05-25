import { PartialClass } from "../util/partial.js";
import { Entity } from "./entity.js";

export class Identity {
  public name = "";
}

export class IdentityModule extends Entity {
  public init(): void {
    this.world.component(Identity);
  }
}

interface IdentityMixin extends Pick<Entity, "get" | "set"> {}

class IdentityMixin {
  public get name(): string | undefined {
    return this.get(Identity)?.name;
  }

  public set name(n: string) {
    this.set(Identity, { name: n });
  }
}

declare module "./entity.js" {
  interface Entity extends IdentityMixin {}
}

PartialClass.addMixin(Entity, IdentityMixin);
