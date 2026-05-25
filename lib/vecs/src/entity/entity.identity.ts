import { Entity } from "./entity.js";

export class Identity {
  public name = "";
}

export class IdentityModule extends Entity {
  public init(): void {
    this.world.component(Identity);
  }
}

declare module "./entity.js" {
  interface Entity {
    get name(): string | undefined;
    set name(n: string);
  }
}

Object.defineProperty(Entity.prototype, "name", {
  get(this: Entity): string | undefined {
    return this.get(Identity)?.name;
  },
  set(this: Entity, n: string): void {
    this.set(Identity, { name: n });
  },
});
