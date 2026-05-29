import { Identity, type Entity } from "../entity/index.js";
import { Module } from "../module.js";

export class IdentityModule extends Module {
  public init(): void {
    const index = this.world._identityNameIndex;
    const indexed = this.world._identityIndexedNames;
    const component = this.world.component(Identity);

    component.onSet((entity: Entity, identity: Identity) => {
      const prev = indexed.get(entity);

      if (prev !== undefined && index.get(prev) === entity) {
        index.delete(prev);
      }

      if (identity.name) {
        index.set(identity.name, entity);
        indexed.set(entity, identity.name);
      } else {
        indexed.delete(entity);
      }
    });

    component.onRemove((entity: Entity) => {
      const prev = indexed.get(entity);

      if (prev !== undefined && index.get(prev) === entity) {
        index.delete(prev);
      }

      indexed.delete(entity);
    });
  }
}
