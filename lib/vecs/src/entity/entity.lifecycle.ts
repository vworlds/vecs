import { CleanupPolicy } from "../component_meta.js";
import type { ComponentMeta } from "../component_meta.js";
import { Relationship } from "../component_meta.js";
import { CommandKind } from "../command.js";
import { Components } from "./entity.components.js";
import type { Entity } from "./entity.js";

/**
 * @internal Discriminant for {@link DeletionOp} tuples. `const enum` so the
 * values are inlined at compile time and no enum object is emitted.
 */
const enum DeletionOpKind {
  Destroy,
  Remove,
}

/**
 * @internal One buffered cleanup action scheduled by `_cleanupIncoming`.
 *
 * `Entity._destroy` walks an entity's incoming relationships and, instead of
 * destroying or removing the source entities inline (which perturbs the very
 * map being iterated, see issue #155), pushes one of these ops onto the
 * world's deletion scope. The outermost `_destroy` call drains the scope
 * after its own teardown completes.
 *
 * Tuples rather than objects: the op is internal, short-lived, and allocated
 * only during a destroy cascade — tuple allocation is cheaper than object
 * allocation and the discriminant is a `const enum` value inlined to a
 * number at compile time.
 */
type DeletionOp = [DeletionOpKind.Destroy, Entity] | [DeletionOpKind.Remove, Entity, ComponentMeta];

export class Lifecycle extends Components {
  /**
   * @internal Apply a `Destroy` command: fire `_exit` on every query, then
   * `onRemove` on every component, unregister from the world, and apply
   * incoming relationship cleanup policies.
   */
  public _destroy(): void {
    if (this._destroyed) {
      return;
    }
    // The outermost _destroy in a cascade owns the deletion scope. Recursive
    // _destroy calls (triggered by _applyOnDelete below, or by the scope flush)
    // find the field already set and append to it, deferring their own incoming
    // cleanup to the outer flush. This keeps _cleanupIncoming's read-only scan
    // free of mid-iteration mutation, see issue #155.
    const ownsDeletionScope = !this.world._deletionScope;
    if (ownsDeletionScope) {
      this.world._deletionScope = [];
    }
    try {
      const entityMeta = this._meta;
      // Mark destroyed up front so a carrier cleanup that re-enters this entity's
      // `_destroy` (possible with exotic relationship topologies under Delete)
      // hits the guard above instead of tearing down twice.
      this._destroyed = true;
      if (entityMeta) {
        const selfCarry = this._components.has(entityMeta.eid) ? 1 : 0;
        if (entityMeta.usageCount > selfCarry) {
          if (entityMeta.onDelete === CleanupPolicy.Throw) {
            // The public `destroy()` already throws when an in-use component is
            // destroyed; reaching here means usage grew between that check and
            // this deferred apply. Abort instead of throwing so a mid-drain
            // `_processCommandQueue` is not left half-applied, and revive the
            // entity since nothing has been torn down yet.
            this._destroyed = false;
            return;
          }
          this._applyOnDelete(entityMeta, selfCarry);
        }
      }

      const entity = this as unknown as Entity;
      this.world._notifyEntityDestroyed(entity);

      this._components.forEach((c, ceid) => {
        const componentMeta = this.world.entity(ceid).meta;
        if (componentMeta.isRelationship) {
          this._removeIncoming((c as Relationship).target, ceid);
        }
        this.componentBitmask.deleteBit(componentMeta.bitPtr);
        this.world._notifyComponentRemoved(ceid, entity);
        componentMeta._decrementUsage();
        const removeHandlers = componentMeta._onRemoveHandlers;
        if (removeHandlers) {
          removeHandlers.forEach((handler) => handler(entity, c));
        }
      });
      this._dirtyComponentBitmask.clear();
      this._queries.clear();

      this._components.clear();

      if (entityMeta && entityMeta.usageCount === 0 && entityMeta.Class !== Object) {
        this.world._classRegistry.delete(entityMeta.Class);
      }

      this.world._unregisterEntity(entity);
      this._cleanupIncoming();
    } finally {
      if (ownsDeletionScope) {
        try {
          this._flushDeletionScope();
        } finally {
          this.world._deletionScope = undefined;
        }
      }
    }
  }

  /**
   * Destroy this entity.
   *
   * Each component fires its `onRemove` hook, the entity is unregistered from
   * the world, and incoming relationship cleanup policies are applied. After
   * destruction the entity must not be used.
   */
  public destroy(): void {
    const entityMeta = this._meta;
    if (
      entityMeta &&
      entityMeta.onDelete === CleanupPolicy.Throw &&
      entityMeta.usageCount > (this._components.has(entityMeta.eid) ? 1 : 0)
    ) {
      throw new Error(`Cannot destroy entity ${this.eid}; component eid is still in use`);
    }
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Destroy, entity: this as unknown as Entity });
    } else {
      this._destroy();
    }
  }

  // Collect carriers first, then act: the scan must not mutate `world.entities`
  // while iterating, and `_destroy` idempotency makes overlapping Delete
  // cascades safe. Carriers are cleaned via the internal `_remove`/`_destroy`
  // (not the deferred-aware public methods) so `usageCount` drops synchronously
  // and the `usageCount === 0` classRegistry cleanup in `_destroy` stays correct.
  // Edge: if a Delete carrier is itself an in-use component key with
  // `onDelete = Throw`, its `_destroy` safe-aborts and it survives still holding
  // this now-destroyed component eid. This is the same exotic policy-interaction
  // class flagged in `_cleanupIncoming`; left for the relationship/query rework.
  private _applyOnDelete(entityMeta: ComponentMeta, selfCarry: number): void {
    const ceid = entityMeta.eid;
    const carriers: Lifecycle[] = [];
    let remaining = entityMeta.usageCount - selfCarry;
    this.world.entities.forEach((e) => {
      if (remaining > 0 && e !== (this as unknown as Entity) && e._get(ceid) !== undefined) {
        carriers.push(e);
        remaining--;
      }
    });
    const shouldDelete = entityMeta.onDelete === CleanupPolicy.Delete;
    for (const carrier of carriers) {
      if (shouldDelete) {
        carrier._destroy();
      } else {
        carrier._remove(entityMeta);
      }
    }
  }

  /**
   * Walk this entity's incoming relationships and buffer cleanup ops onto the
   * world's deletion scope instead of acting inline.
   *
   * Acting inline (source.destroy() / source.remove()) re-enters
   * `_removeIncoming` on this entity, which deletes from the iterated map
   * mid-scan; `IterableArrayMap.delete` swaps the last entry into the vacated
   * slot, so the outer `forEach` skips it. Buffering the work onto the scope
   * keeps this scan pure; the outermost `_destroy` drains the scope via
   * `_flushDeletionScope` after all scans in the cascade complete.
   * See issue #155.
   */
  private _cleanupIncoming(): void {
    if (!this._incoming) {
      return;
    }
    const incoming = this._incoming;
    this._incoming = undefined;
    const scope = this.world._deletionScope as DeletionOp[];
    incoming.forEach((sources, relEid) => {
      const relEntity = this.world.getEntity(relEid);
      if (!relEntity) {
        return;
      }
      const policy = relEntity.meta.onDeleteTarget;
      for (const source of sources) {
        // `sources` is iterated read-only here; re-entrant _removeIncoming
        // mutates it during the scope flush (after this scan completes), not
        // during this forEach, so no snapshot is needed.
        const sourceEntity = source as unknown as Entity;
        if (policy === CleanupPolicy.Delete) {
          // If source is also an in-use component entity with onDelete Throw,
          // this exotic cascade can still throw; revisit with the relationship rework.
          scope.push([DeletionOpKind.Destroy, sourceEntity]);
        } else {
          scope.push([DeletionOpKind.Remove, sourceEntity, relEntity.meta]);
        }
      }
    });
  }

  /**
   * Drain the deletion scope to empty.
   *
   * Called by the outermost `Entity._destroy` after its own teardown. Each pass
   * detaches the current scope so recursive destroys triggered by the ops
   * buffer into a fresh scope, which the `while` loop drains in the next
   * iteration. Exits when a full pass appended nothing new.
   */
  private _flushDeletionScope(): void {
    while (this.world._deletionScope && this.world._deletionScope.length > 0) {
      const ops = this.world._deletionScope as DeletionOp[];
      this.world._deletionScope = undefined;
      for (const op of ops) {
        if (op[0] === DeletionOpKind.Destroy) {
          op[1]._destroy();
        } else {
          op[1]._remove(op[2]);
        }
      }
    }
  }
}
