import { type Entity } from "../entity/index.js";
import { Module } from "../module.js";

/**
 * Marker component used to tag a component class as a singleton.
 *
 * Attach it to a component entity to make that component class a singleton: at
 * most one entity in the world may hold the component at any time. Attempting
 * to add the component to a second entity throws.
 *
 * ```ts
 * world.component(Gravity).add(Singleton); // Gravity is now a singleton
 * ```
 *
 * The constraint itself is enforced by {@link SingletonModule}.
 */
export class Singleton {}

/**
 * Built-in world module that enforces the singleton constraint.
 *
 * Registered automatically by every {@link World}. When a component entity has
 * the `Singleton` component attached, the module installs an `onAdd` hook on
 * that component class so that adding it to more than one entity throws.
 */
export class SingletonModule extends Module {
  public init(): void {
    this.world.component(Singleton).on("add", (target: Entity): void => {
      const targetMeta = target.meta;
      if (targetMeta.usageCount !== 0) {
        throw new Error(
          `Cannot make component ${targetMeta.Class.name} singleton; ${targetMeta.usageCount} instance(s) already exist`
        );
      }

      targetMeta.on("add", (entity) => {
        if (entity !== target || targetMeta.usageCount !== 1) {
          throw new Error(
            `Cannot add singleton component ${targetMeta.Class.name} to entity ${entity.eid}; singleton instance is entity ${target.eid}`
          );
        }
      });
      target.add(target);
    });
  }
}
