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
type DeletionOp =
  [DeletionOpKind.Destroy, Entity] | [DeletionOpKind.Remove, Entity, ComponentMeta, Entity];

export class Lifecycle extends Components {
  /**
   * @internal Apply a `Destroy` command: fire `_exit` on every query, then
   * `onRemove` on every component, unregister from the world, and apply
   * incoming relationship cleanup policies.
   */
  public _destroy(this: Entity): void {
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
      let selfCarry = 0;
      if (entityMeta) {
        selfCarry = this._components.has(entityMeta.eid) ? 1 : 0;
        if (entityMeta.usageCount > selfCarry && entityMeta.onDelete === CleanupPolicy.Throw) {
          throw new Error(`Cannot destroy entity ${this.eid}; component eid is still in use`);
        }
      }

      // Mark destroyed before applying cleanup so a carrier cascade that
      // re-enters this entity cannot tear it down twice.
      this._destroyed = true;
      if (entityMeta && entityMeta.usageCount > selfCarry) {
        this._applyOnDelete(entityMeta, selfCarry);
      }

      this.world._notifyEntityDestroyed(this);

      this._components.forEachSafe((c, ceid) => {
        const componentMeta = this.world.entity(ceid).meta;
        if (componentMeta.isRelationship) {
          this._detachRelationship(componentMeta, c as Relationship);
          return;
        }
        this.componentBitmask.deleteBit(componentMeta.bitPtr);
        this.world._notifyComponentRemoved(ceid, this);
        if (!this._inheritedComponentBitmask?.hasBit(componentMeta.bitPtr)) {
          componentMeta._detachCarrier(this);
          componentMeta._onRemove?.(this, c);
        }
        this._propagateInheritance(componentMeta, false);
      });
      this._dirtyComponentBitmask.clear();
      this._inheritedComponentBitmask = undefined;
      this._inheritedComponentSources = undefined;
      this._inheritanceBlockedBitmask = undefined;
      this._pendingInheritedOverrides = undefined;
      this._queries.clear();

      this._components.clear();

      if (entityMeta && entityMeta.usageCount === 0 && entityMeta.Class !== Object) {
        this.world._classRegistry.delete(entityMeta.Class);
      }

      this.world._unregisterEntity(this);
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
   *
   * A synchronous throw (a `Throw`-policy component entity still in use)
   * happens before any mutation, so the world stays usable. A throw during
   * deferred application or a cleanup cascade propagates out of `progress()` /
   * `flush()` and leaves the world partial — treat it as a programming error.
   */
  public destroy(this: Entity): void {
    const entityMeta = this._meta;
    if (
      entityMeta &&
      entityMeta.onDelete === CleanupPolicy.Throw &&
      entityMeta.usageCount > (this._components.has(entityMeta.eid) ? 1 : 0)
    ) {
      throw new Error(`Cannot destroy entity ${this.eid}; component eid is still in use`);
    }
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Destroy, entity: this });
    } else {
      this._destroy();
    }
  }

  private _applyOnDelete(this: Entity, entityMeta: ComponentMeta, selfCarry: number): void {
    const carriers = entityMeta._carriers;
    if (!carriers || carriers.size <= selfCarry) {
      return;
    }
    const shouldDelete = entityMeta.onDelete === CleanupPolicy.Delete;
    // forEachSafe tolerates deletion of the current carrier mid-loop: each
    // `_destroy`/`_remove` below detaches only its own carrier from this meta
    // (via `_detachCarrier`), and any further cascade is buffered onto the
    // world's deletion scope and drained after this scan completes — so no
    // other slot of `carriers` is mutated while we are iterating it.
    carriers.forEachSafe((carrier) => {
      if (carrier === this) {
        return;
      }
      if (shouldDelete) {
        carrier._destroy();
      } else {
        carrier._remove(entityMeta);
      }
    });
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
  private _cleanupIncoming(this: Entity): void {
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
        if (policy === CleanupPolicy.Delete) {
          scope.push([DeletionOpKind.Destroy, source]);
        } else {
          scope.push([DeletionOpKind.Remove, source, relEntity.meta, this]);
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
          op[1]._removeTarget(op[2], op[3]);
        }
      }
    }
  }
}
