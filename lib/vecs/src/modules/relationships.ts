import { CleanupPolicy } from "../component_meta.js";
import { Trait } from "../component_def.js";
import { type EID, type Entity } from "../entity/index.js";
import { Module } from "../module.js";
import {
  ChildOf,
  Delete,
  DependsOn,
  Exclusive,
  OnDelete,
  OnDeleteTarget,
  OneOf,
  OwnedTarget,
  Remove,
  SilenceSource,
  Throw,
  Traversable,
  With,
} from "./relationship_types.js";

export {
  ChildOf,
  Delete,
  DependsOn,
  Exclusive,
  OnDelete,
  OnDeleteTarget,
  OneOf,
  OwnedTarget,
  Remove,
  SilenceSource,
  Throw,
  Traversable,
  With,
} from "./relationship_types.js";

/**
 * Built-in world module that registers the `ChildOf` relationship and
 * maintains ownership and depth tracking policies for relationship traits.
 * Declares `Exclusive`, `Traversable`, `OwnedTarget`, `With`, `OneOf`,
 * `OnDelete`, and `OnDeleteTarget` with the {@link Trait} marker.
 *
 * Registered automatically by every {@link World}. It gives `ChildOf` the
 * `(OnDeleteTarget, Delete)` cleanup policy, so destroying a parent
 * recursively destroys the children that target it through `ChildOf` (custom
 * relationships default to `Remove`).
 *
 * `OnDelete` and `OnDeleteTarget` are exclusive cleanup-policy traits
 * restricted with `OneOf` to the policy values `Throw`, `Remove`, and
 * `Delete`, which are `ChildOf` children of `OnDelete`; `OnDeleteTarget`
 * rejects `Throw`. Adding a policy edge stores it on the component entity's
 * meta, where `Entity.destroy` reads it, and removing the edge restores the
 * default.
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
 * `OneOf` constrains the targets of a relationship to direct `ChildOf`
 * children of a specified parent entity. Attach during setup as
 * `relationship.add(OneOf, parent)`; the module installs a per-edge policy that
 * rejects targets whose `ChildOf` parent is not the declared parent. `OneOf`
 * is irrevocable once attached.
 *
 * `OwnedTarget` and `Traversable` are irrevocable once attached: both
 * `entity.remove(Trait)` and `entity.attach(newInstance)` throw, and the world
 * must be discarded after the throw. Teardown bypasses these guards —
 * `Entity._destroy` fires only the application `remove` handlers, not the
 * trait ones — so `clearAllEntities` can still tear down worlds with these
 * traits configured.
 *
 * The trait handlers live in internal per-event slots that run before the
 * application's handlers of the same event. `World.dispose` clears their
 * `remove` / `targetRemove` slots before tearing down infrastructure.
 *
 * Depth is computed by walking `entity.target(relEid)` to the root. When an
 * entity's depth changes, every descendant is recursively recomputed.
 */
export class RelationshipsModule extends Module {
  public init(): void {
    const world = this.world;
    const childOf = world.component(ChildOf);
    const dependsOn = world.component(DependsOn);
    const exclusive = world.component(Exclusive).add(Trait);
    const ownedTarget = world.component(OwnedTarget).add(Trait);
    const silenceSource = world.component(SilenceSource);
    const traversableTrait = world.component(Traversable).add(Trait);
    const withTrait = world.component(With).add(Trait);
    const oneOfTrait = world.component(OneOf).add(Trait);

    exclusive.meta.on(
      "add",
      (relationship): void => {
        if (!relationship.meta.isRelationship) {
          throw new Error("Exclusive can only be added to a Relationship component");
        }
        if (relationship.meta.usageCount > 0) {
          throw new Error("Exclusive cannot be added or removed while the relationship is in use");
        }
        relationship.meta.relationshipExclusive = true;
      },
      { trait: true }
    );
    exclusive.meta.on(
      "remove",
      (relationship): void => {
        if (relationship.has(OwnedTarget) || relationship.has(Traversable)) {
          throw new Error(
            "Exclusive cannot be removed while a dependent relationship trait exists"
          );
        }
        if (relationship.meta.usageCount > 0) {
          throw new Error("Exclusive cannot be added or removed while the relationship is in use");
        }
        relationship.meta.relationshipExclusive = false;
      },
      { trait: true }
    );

    ownedTarget.meta.on(
      "add",
      (rel): void => {
        if (!rel.meta.isRelationship) {
          throw new Error("OwnedTarget can only be added to a Relationship component");
        }
        if (rel === childOf) {
          throw new Error("OwnedTarget cannot be added to ChildOf");
        }
        if (!rel.has(Exclusive)) {
          throw new Error("OwnedTarget requires Exclusive");
        }
        rel.meta.on("targetAdd", (source, _relationship, target) => target.add(ChildOf, source), {
          trait: true,
        });
        rel.meta.on("targetRemove", (_source, _relationship, target) => target.destroy(), {
          trait: true,
        });
      },
      { trait: true }
    );
    ownedTarget.meta.on(
      "remove",
      (): void => {
        throw new Error("OwnedTarget cannot be removed once added");
      },
      { trait: true }
    );

    traversableTrait.meta.on(
      "add",
      (rel, component): void => {
        if (!rel.meta.isRelationship) {
          throw new Error("Traversable can only be added to a Relationship component");
        }
        if (!rel.has(Exclusive)) {
          throw new Error("Traversable requires Exclusive");
        }
        const traversable = component as Traversable;
        const relEid = rel.eid;
        rel.meta.on(
          "targetAdd",
          (entity) => {
            this._cascadeUpdate(entity, relEid, traversable);
          },
          { trait: true }
        );
        rel.meta.on(
          "targetRemove",
          (entity) => {
            traversable.depths.delete(entity);
            for (const child of entity._childrenByEid(relEid) ?? []) {
              this._cascadeUpdate(child, relEid, traversable);
            }
          },
          { trait: true }
        );

        world.entities.forEach((entity) => {
          if (entity.has(relEid)) {
            this._cascadeUpdate(entity, relEid, traversable);
          }
        });
      },
      { trait: true }
    );
    traversableTrait.meta.on(
      "remove",
      (): void => {
        throw new Error("Traversable cannot be removed once added");
      },
      { trait: true }
    );

    withTrait.meta.on(
      "targetAdd",
      (xEntity, _withRelationship, yEntity): void => {
        const xMeta = xEntity.meta;
        const yMeta = yEntity.meta;
        if (xMeta.isRelationship !== yMeta.isRelationship) {
          throw new Error(
            "With: the component and its target must both be relationships or both be plain components"
          );
        }
        if (xMeta.usageCount > 0) {
          throw new Error("With cannot be added while the target component is in use");
        }
        if (xMeta.isRelationship) {
          xMeta.on("targetAdd", (source, _rel, target) => source.add(yEntity, target), {
            trait: true,
          });
        } else {
          xMeta.on("add", (entity) => entity.add(yEntity), { trait: true });
        }
      },
      { trait: true }
    );
    this._forbidPairTraitRemoval(withTrait, "With");

    oneOfTrait.meta.on(
      "targetAdd",
      (rel, _oneOf, parent): void => {
        if (!rel.meta.isRelationship) {
          throw new Error("OneOf can only be added to a Relationship component");
        }
        if (rel.meta.usageCount > 0) {
          throw new Error("OneOf cannot be added while the relationship is in use");
        }
        rel.meta.on(
          "targetAdd",
          (_source, _relationship, target) => {
            if (target.parent !== parent) {
              throw new Error(`OneOf: target ${target.eid} is not a child of entity ${parent.eid}`);
            }
          },
          { trait: true }
        );
      },
      { trait: true }
    );
    this._forbidPairTraitRemoval(oneOfTrait, "OneOf");

    childOf.add(Exclusive).add(Traversable);
    dependsOn.add(Exclusive).add(Traversable);
    silenceSource.add(Exclusive);

    this._registerCleanupPolicies();
    childOf.add(OnDeleteTarget, Delete);
  }

  /**
   * Declare the `OnDelete` and `OnDeleteTarget` traits and their policy
   * values, and install the handlers that copy each edge's policy onto the
   * carrier's meta. The meta field keeps `Entity.destroy`'s cleanup read a
   * plain field read.
   */
  private _registerCleanupPolicies(): void {
    const world = this.world;
    const onDeleteTrait = world.component(OnDelete).add(Trait);
    const onDeleteTargetTrait = world.component(OnDeleteTarget).add(Trait);
    const policies = new Map<Entity, CleanupPolicy>([
      [world.component(Throw).childOf(onDeleteTrait), CleanupPolicy.Throw],
      [world.component(Remove).childOf(onDeleteTrait), CleanupPolicy.Remove],
      [world.component(Delete).childOf(onDeleteTrait), CleanupPolicy.Delete],
    ]);
    const throwPolicy = world.component(Throw);

    onDeleteTrait.add(Exclusive).add(OneOf, onDeleteTrait);
    onDeleteTargetTrait.add(Exclusive).add(OneOf, onDeleteTrait);

    onDeleteTrait.meta.on(
      "targetAdd",
      (component, _onDelete, policy): void => {
        component.meta._onDelete = policies.get(policy)!;
      },
      { trait: true }
    );
    onDeleteTrait.meta.on(
      "targetRemove",
      (component): void => {
        component.meta._onDelete = CleanupPolicy.Throw;
      },
      { trait: true }
    );
    onDeleteTargetTrait.meta.on(
      "targetAdd",
      (rel, _onDeleteTarget, policy): void => {
        if (!rel.meta.isRelationship) {
          throw new Error("OnDeleteTarget can only be added to a Relationship component");
        }
        if (policy === throwPolicy) {
          throw new Error("OnDeleteTarget accepts Remove or Delete, not Throw");
        }
        rel.meta._onDeleteTarget = policies.get(policy)!;
      },
      { trait: true }
    );
    onDeleteTargetTrait.meta.on(
      "targetRemove",
      (rel): void => {
        rel.meta._onDeleteTarget = CleanupPolicy.Remove;
      },
      { trait: true }
    );
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

  /**
   * Make a pair-form trait irrevocable: removing an edge of `trait` throws
   * once attached.
   *
   * Teardown fires `targetRemove` from two paths: `_detachRelationship`
   * on the trait carrier (after `carrier._destroyed = true`) and the cleanup
   * cascade when the pair target is destroyed (buffered via `_cleanupIncoming`
   * → `_removeTarget`, where the carrier is still alive but the target is
   * already gone). Skip the irrevocability guard in either case; see the
   * teardown contract in the class JSDoc.
   */
  private _forbidPairTraitRemoval(trait: Entity, name: string): void {
    trait.meta.on(
      "targetRemove",
      (carrier, _trait, target): void => {
        if (carrier.destroyed || target.destroyed) {
          return;
        }
        throw new Error(`${name} cannot be removed once added`);
      },
      { trait: true }
    );
  }
}
