import { CleanupPolicy } from "../component_meta.js";
import type { ComponentMeta } from "../component_meta.js";
import { Relationship } from "../relationship.js";
import type { Query } from "../query.js";
import { CommandKind } from "../command.js";
import { Components } from "./entity.components.js";
import type { Entity } from "./entity.js";

export class Lifecycle extends Components {
  /**
   * @internal Apply a `Destroy` command: fire `_exit` on every query, then
   * `onRemove` on every component, emit the `destroy` event, unregister from
   * the world, and apply incoming relationship cleanup policies.
   */
  public _destroy(): void {
    if (this._destroyed) {
      return;
    }
    const ownMeta = this._ownMeta;
    // Mark destroyed up front so a carrier cleanup that re-enters this entity's
    // `_destroy` (possible with exotic relationship topologies under Delete)
    // hits the guard above instead of tearing down twice.
    this._destroyed = true;
    if (ownMeta) {
      const selfCarry = this._components.has(ownMeta.eid) ? 1 : 0;
      if (ownMeta.usageCount > selfCarry) {
        if (ownMeta.onDelete === CleanupPolicy.Throw) {
          // The public `destroy()` already throws when an in-use component is
          // destroyed; reaching here means usage grew between that check and
          // this deferred apply. Abort instead of throwing so a mid-drain
          // `_processCommandQueue` is not left half-applied, and revive the
          // entity since nothing has been torn down yet.
          this._destroyed = false;
          return;
        }
        this._applyOnDelete(ownMeta, selfCarry);
      }
    }

    const toExit: Query[] = [];
    this._queries.forEach((q) => {
      if (q.world) {
        toExit.push(q);
      }
    });
    const entity = this as unknown as Entity;
    toExit.forEach((q) => q._exit(entity));

    this._components.forEach((c, eid) => {
      const meta = this.world.entity(eid).ownMeta;
      if (meta.isRelationship) {
        this._removeIncoming((c as Relationship).target, eid);
      }
      meta._decrementUsage();
      const removeHandlers = meta._onRemoveHandlers;
      if (removeHandlers) {
        removeHandlers.forEach((handler) => handler(entity, c));
      }
    });
    this._dirtyComponentBitmask.clear();

    if (this._events) {
      this._events.emit("destroy");
      this._events.removeAllListeners("destroy");
    }

    if (ownMeta && ownMeta.usageCount === 0 && ownMeta.Class !== Object) {
      this.world._classRegistry.delete(ownMeta.Class);
    }

    this.world._unregisterEntity(entity);
    this._cleanupIncoming();
  }

  /**
   * Destroy this entity.
   *
   * Each component fires its `onRemove` hook, the `"destroy"` event is emitted
   * just before teardown, and the entity is unregistered from the world.
   * After destruction the entity must not be used.
   */
  public destroy(): void {
    const ownMeta = this._ownMeta;
    if (
      ownMeta &&
      ownMeta.onDelete === CleanupPolicy.Throw &&
      ownMeta.usageCount > (this._components.has(ownMeta.eid) ? 1 : 0)
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
  private _applyOnDelete(ownMeta: ComponentMeta, selfCarry: number): void {
    const ceid = ownMeta.eid;
    const carriers: Lifecycle[] = [];
    let remaining = ownMeta.usageCount - selfCarry;
    this.world.entities.forEach((e) => {
      if (remaining > 0 && e !== (this as unknown as Entity) && e._get(ceid) !== undefined) {
        carriers.push(e);
        remaining--;
      }
    });
    const shouldDelete = ownMeta.onDelete === CleanupPolicy.Delete;
    for (const carrier of carriers) {
      if (shouldDelete) {
        carrier._destroy();
      } else {
        carrier._remove(ownMeta);
      }
    }
  }
}
