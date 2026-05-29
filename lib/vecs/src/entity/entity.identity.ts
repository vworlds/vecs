import { Lifecycle } from "./entity.lifecycle.js";

export class Identity {
  public name = "";
}

export class IdentityEntity extends Lifecycle {
  public get name(): string | undefined {
    return this.get(Identity)?.name;
  }

  public set name(n: string) {
    this.set(Identity, { name: n });
  }
}
