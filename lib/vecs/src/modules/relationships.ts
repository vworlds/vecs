import { CleanupPolicy } from "../component_meta.js";
import { type EID, type Entity } from "../entity/index.js";
import { Module } from "../module.js";
import {
  ChildOf,
  DependsOn,
  Exclusive,
  OwnedTarget,
  SilenceSource,
  Traversable,
} from "./relationship_types.js";

export {
  ChildOf,
  DependsOn,
  Exclusive,
  OwnedTarget,
  SilenceSource,
  Traversable,
} from "./relationship_types.js";

/**
 * Built-in world module that registers the `ChildOf` relationship and
 * maintains ownership and depth tracking policies for relationship traits.
 *
 * Registered automatically by every {@link World}. It sets `ChildOf`'s
 * `onDeleteTarget` cleanup policy to {@link CleanupPolicy.Delete}, so
 * destroying a parent recursively destroys the children that target it through
 * `ChildOf` (custom relationships default to `Remove`).
 *
 * `Traversable` requires `Exclusive`. The module wraps target-edge hooks on a
 * traversable relationship so every entity's depth is updated when its edge is
 * added, replaced, or removed.
 *
 * When a relationship component entity has `OwnedTarget` attached, the module
 * wraps its target-edge hooks so every explicitly added target becomes a
 * `ChildOf` child of its source and is destroyed when displaced or removed.
 * `OwnedTarget` requires `Exclusive` and never creates a target implicitly.
 *
 * `OwnedTarget` and `Traversable` are irrevocable once attached: both
 * `entity.remove(Trait)` and `entity.attach(newInstance)` throw, and the world
 * must be discarded after the throw. Teardown bypasses these guards —
 * `Entity._destroy` does not fire `_onPolicyRemove` — so `clearAllEntities`
 * can still tear down worlds with these traits configured.
 *
 * Depth is computed by walking `entity.target(relEid)` to the root. When an
 * entity's depth changes, every descendant is recursively recomputed.
 */
export class RelationshipsModule extends Module {
  public init(): void {
    const world = this.world;
    const childOf = world.component(ChildOf);
    const dependsOn = world.component(DependsOn);
    const exclusive = world.component(Exclusive);
    const ownedTarget = world.component(OwnedTarget);
    const silenceSource = world.component(SilenceSource);
    const traversableTrait = world.component(Traversable);

    childOf.meta.onDeleteTarget = CleanupPolicy.Delete;
    exclusive.meta.on("policyAdd", (relationship): void => {
      if (!relationship.meta.isRelationship) {
        throw new Error("Exclusive can only be added to a Relationship component");
      }
      if (relationship.meta.usageCount > 0) {
        throw new Error("Exclusive cannot be added or removed while the relationship is in use");
      }
      relationship.meta.relationshipExclusive = true;
    });
    exclusive.meta.on("policyRemove", (relationship): void => {
      if (relationship.has(OwnedTarget) || relationship.has(Traversable)) {
        throw new Error("Exclusive cannot be removed while a dependent relationship trait exists");
      }
      if (relationship.meta.usageCount > 0) {
        throw new Error("Exclusive cannot be added or removed while the relationship is in use");
      }
      relationship.meta.relationshipExclusive = false;
    });

    ownedTarget.meta.on("policyAdd", (rel): void => {
      if (!rel.meta.isRelationship) {
        throw new Error("OwnedTarget can only be added to a Relationship component");
      }
      if (rel === childOf) {
        throw new Error("OwnedTarget cannot be added to ChildOf");
      }
      if (!rel.has(Exclusive)) {
        throw new Error("OwnedTarget requires Exclusive");
      }
      rel.meta.on("targetPolicyAdd", (source, _relationship, target) =>
        target.add(ChildOf, source)
      );
      rel.meta.on("targetPolicyRemove", (_source, _relationship, target) => target.destroy());
    });
    ownedTarget.meta.on("policyRemove", (): void => {
      throw new Error("OwnedTarget cannot be removed once added");
    });

    traversableTrait.meta.on("policyAdd", (rel, component): void => {
      if (!rel.meta.isRelationship) {
        throw new Error("Traversable can only be added to a Relationship component");
      }
      if (!rel.has(Exclusive)) {
        throw new Error("Traversable requires Exclusive");
      }
      const traversable = component as Traversable;
      const relEid = rel.eid;
      rel.meta.on("targetPolicyAdd", (entity) => {
        this._cascadeUpdate(entity, relEid, traversable);
      });
      rel.meta.on("targetPolicyRemove", (entity) => {
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
    traversableTrait.meta.on("policyRemove", (): void => {
      throw new Error("Traversable cannot be removed once added");
    });

    childOf.add(Exclusive).add(Traversable);
    dependsOn.add(Exclusive).add(Traversable);
    silenceSource.add(Exclusive);
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

    const parent = entity.target(relEid);
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
