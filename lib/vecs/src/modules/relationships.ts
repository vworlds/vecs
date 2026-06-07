import { CleanupPolicy } from "../component_meta.js";
import { type EID, type Entity } from "../entity/index.js";
import { Module } from "../module.js";
import { ChildOf, Traversable } from "./relationship_types.js";

export { ChildOf, SilenceSource, Traversable } from "./relationship_types.js";

/**
 * Built-in world module that registers the `ChildOf` relationship and
 * maintains depth tracking for traversable relationships.
 *
 * Registered automatically by every {@link World}. It sets `ChildOf`'s
 * `onDeleteTarget` cleanup policy to {@link CleanupPolicy.Delete}, so
 * destroying a parent recursively destroys the children that target it through
 * `ChildOf` (custom relationships default to `Remove`).
 *
 * When a relationship component entity has `Traversable` attached, the module
 * installs `onAdd`, `onSet`, and `onRemove` hooks on that relationship so that
 * every entity's depth is updated when the relationship is added, retargeted,
 * or removed.
 *
 * Depth is computed by walking `entity.parent(relEid)` to the root. When an
 * entity's depth changes, every descendant is recursively recomputed.
 */
export class RelationshipsModule extends Module {
  public init(): void {
    const world = this.world;
    const childOf = world.component(ChildOf);
    const traversable = world.component(Traversable);

    childOf.meta.onDeleteTarget = CleanupPolicy.Delete;

    traversable.onAdd((rel, traversable): void => {
      const relEid = rel.eid;

      rel
        .onAdd((entity: Entity) => {
          this._cascadeUpdate(entity, relEid, traversable);
        })
        .onSet((entity: Entity) => {
          this._cascadeUpdate(entity, relEid, traversable);
        })
        .onRemove((entity: Entity) => {
          traversable.depths.delete(entity);

          for (const child of entity._childrenByEid(relEid) ?? []) {
            this._cascadeUpdate(child, relEid, traversable);
          }
        });

      world.entities.forEach((entity) => {
        if (entity.has(relEid)) {
          this._cascadeUpdate(entity, relEid, traversable);
        }
      });
    });

    childOf.add(Traversable);
  }

  private _cascadeUpdate(
    entity: Entity,
    relEid: EID,
    traversable: Traversable,
    visited = new Set<Entity>()
  ): void {
    if (visited.has(entity)) {
      return;
    }

    visited.add(entity);

    if (entity.has(relEid)) {
      traversable.depths.set(entity, this._depthOf(entity, relEid, traversable, new Set()));
    } else {
      traversable.depths.delete(entity);
    }

    for (const child of entity._childrenByEid(relEid) ?? []) {
      this._cascadeUpdate(child, relEid, traversable, visited);
    }
  }

  private _depthOf(
    entity: Entity,
    relEid: EID,
    traversable: Traversable,
    visited: Set<Entity>
  ): number {
    if (!entity.has(relEid) || visited.has(entity)) {
      return 0;
    }

    visited.add(entity);

    const parent = entity.parent(relEid);
    if (!parent) {
      return 0;
    }

    const parentDepth = traversable.depths.get(parent);
    if (parentDepth !== undefined && !visited.has(parent)) {
      return parentDepth + 1;
    }

    return this._depthOf(parent, relEid, traversable, visited) + 1;
  }
}
