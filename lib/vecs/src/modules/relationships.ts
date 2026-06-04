import { CleanupPolicy, Relationship } from "../component_meta.js";
import { type Entity } from "../entity/index.js";
import { Module } from "../module.js";

/** Built-in parent-child relationship. */
export class ChildOf extends Relationship {}

/**
 * Built-in relationship marking a feedback **silence domain** for a query
 * or system.
 *
 * When a query carries a `SilenceSource` pointing at a query entity, it
 * ignores `update` notifications whose originating entity (the system
 * that wrote the component) is a member of that query. Configure it through
 * {@link Query.ignoreSource}.
 */
export class SilenceSource extends Relationship {}

/**
 * Marker component used to tag a relationship component as traversable.
 *
 * Attach to a relationship-component entity (e.g. `ChildOf`) to enable
 * automatic depth tracking: every entity carrying the tagged relationship
 * gets a depth entry whose value is the number of hops to the nearest root
 * (zero for roots).
 *
 * ```ts
 * world.component(ChildOf).add(Traversable);
 * ```
 *
 * The depth map is maintained reactively by {@link RelationshipsModule}.
 */
export class Traversable {
  /** Entity → depth (hops to root, 0-based). */
  depths = new Map<Entity, number>();
}

/**
 * Built-in world module that registers the `ChildOf` relationship and
 * maintains depth tracking for traversable relationships.
 *
 * Registered automatically by every {@link World}. When a relationship
 * component entity has `Traversable` attached, the module installs `onAdd`,
 * `onSet`, and `onRemove` hooks on that relationship so that every entity's
 * depth is updated when the relationship is added, retargeted, or removed.
 *
 * Depth is computed by walking `entity.parent(relEid)` to the root. When an
 * entity's depth changes, every descendant is recursively recomputed.
 */
export class RelationshipsModule extends Module {
  public init(): void {
    const world = this.world;

    world.component(ChildOf).ownMeta.onDeleteTarget = CleanupPolicy.Delete;
    world.component(Traversable);

    world.component(Traversable).onAdd((target: Entity, traversable: Traversable): void => {
      const relMeta = target.ownMeta!;
      const relEid = relMeta.eid;

      relMeta
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
        if (entity.componentBitmask.has(relEid)) {
          this._cascadeUpdate(entity, relEid, traversable);
        }
      });
    });
  }

  private _cascadeUpdate(
    entity: Entity,
    relEid: number,
    traversable: Traversable,
    visited = new Set<Entity>()
  ): void {
    if (visited.has(entity)) {
      return;
    }

    visited.add(entity);

    if (entity.componentBitmask.has(relEid)) {
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
    relEid: number,
    traversable: Traversable,
    visited: Set<Entity>
  ): number {
    if (!entity.componentBitmask.has(relEid) || visited.has(entity)) {
      return 0;
    }

    visited.add(entity);

    const parent = entity._parent(relEid);
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
