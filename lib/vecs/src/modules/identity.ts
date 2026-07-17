import { Identity, type Entity } from "../entity/index.js";
import { Module } from "../module.js";

/**
 * Built-in world module that maintains the name → entity index.
 *
 * Registers hooks on the `Identity` component so that whenever an entity's
 * `name` is set or cleared, `world._identityNameIndex` is updated accordingly.
 * This powers the string-overloads of {@link World.entity} and
 * {@link World.getEntity} that resolve entities by name.
 *
 * Registered automatically by every {@link World}; user code does not interact
 * with `IdentityModule` directly.
 */
export class IdentityModule extends Module {
  public init(): void {
    const index = this.world._identityNameIndex;
    const indexed = this.world._identityIndexedNames;
    const component = this.world.component(Identity);

    component.on("set", (entity: Entity, identity: Identity) => {
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

    component.on("remove", (entity: Entity) => {
      const prev = indexed.get(entity);

      if (prev !== undefined && index.get(prev) === entity) {
        index.delete(prev);
      }

      indexed.delete(entity);
    });
  }
}
