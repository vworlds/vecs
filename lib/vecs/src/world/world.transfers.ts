// The `World` half of cross-world subtree transfer: `snapshotSubtree`,
// `restoreSubtree`, and `moveSubtree`. The capture, preflight, and restore
// mechanics live in `../snapshot/`.

import { type Entity } from "../entity/index.js";
import { _captureSubtree, _preflightRestore, _restoreSubtree } from "../snapshot/index.js";
import {
  type EntitySubtreeSnapshot,
  type MoveSubtreeResult,
  type RestoreSubtreeResult,
  type SubtreeSnapshotOptions,
} from "../snapshot/types.js";
import { Modules } from "./world.modules.js";
import { type World } from "./world.js";

export class Transfers extends Modules {
  /**
   * Capture one entity's subtree, or several roots as one atomic forest, into
   * detached records.
   *
   * Nothing in the source world changes: the forest is walked and every selected
   * component and edge is copied before this returns. Entity ids and
   * relationship edges are world-local, so the result carries *data* — its
   * component classes and payloads, plus internal edges keyed by snapshot key —
   * and never a live instance.
   *
   * Per component type, capture follows the type's `OnSnapshot` declaration, set
   * by the module that owns it: plain data clones its own enumerable fields
   * (`ClonePublic`), `DontSnapshot` types are left behind, and
   * `CustomSnapshot` types call the owner's `capture`. Relationship targets
   * inside the forest are stored as snapshot keys; targets outside it follow
   * the `externalTargets` policy.
   *
   * @param rootOrRoots - A single root entity, or an array of roots captured as
   *   one forest.
   * @param options - Traversal relationship, component and relationship
   *   allowlists, and the external-target policy.
   * @returns A snapshot bound to this world.
   * @throws If the world is deferred, a root is destroyed or is a
   *   component-definition entity, the traversal relationship is unregistered,
   *   the forest contains a cycle or a repeated member, a selected type is
   *   `DontSnapshot`, or an external target is found under the `"error"` policy.
   *
   * @example
   * ```ts
   * const snapshot = world.snapshotSubtree(ship, {
   *   components: [Position, LinearVelocity, Hull],
   *   relationships: [ChildOf, Carries],
   *   externalTargets: "error",
   * });
   * ```
   */
  public snapshotSubtree(
    this: World,
    rootOrRoots: Entity | readonly Entity[],
    options: SubtreeSnapshotOptions = {}
  ): EntitySubtreeSnapshot {
    this._assertNotDeferred("snapshotSubtree");
    return _captureSubtree(this, rootOrRoots, options);
  }

  /**
   * Recreate a captured snapshot inside `destination` with fresh entity ids.
   *
   * Every destination component is built by the canonical materializer, so
   * exclusivity, interface aliases, `add` hooks, and query entry fire exactly
   * as they would for an ordinary `set`. Source instances are never attached:
   * the snapshot holds data only.
   *
   * Edges are rebuilt through the public relationship API, in two passes — the
   * traversal relationship first, then everything else — so
   * hierarchy-sensitive policies see a complete tree. Internal targets are
   * remapped onto the freshly allocated ids; targets left behind at capture time
   * stay left behind.
   *
   * The source entities are untouched. Use {@link moveSubtree} to transfer
   * ownership as well.
   *
   * @param destination - World that receives the snapshot.
   * @param snapshot - A snapshot from {@link snapshotSubtree}.
   * @returns The destination entities, keyed by snapshot key and by source
   *   entity.
   * @throws If either world is deferred, a captured class is unregistered or
   *   excluded in `destination`, or materialization fails. A failure after
   *   creation destroys everything the attempt created.
   */
  public restoreSubtree(
    this: World,
    destination: World,
    snapshot: EntitySubtreeSnapshot
  ): RestoreSubtreeResult {
    this._assertNotDeferred("restoreSubtree");
    destination._assertNotDeferred("restoreSubtree");
    return _restoreSubtree(destination, snapshot);
  }

  /**
   * Move one entity's subtree, or several roots as one atomic forest, into
   * `destination`.
   *
   * Capture and preflight both complete before the source is touched, so a
   * snapshot that cannot be restored — an unregistered class, an excluded type —
   * leaves the source world exactly as it was. Only then are the source roots
   * destroyed, and the snapshot is restored into `destination`.
   *
   * If the destination restore fails, everything that restore created is
   * destroyed, the source snapshot is restored back into this world, and the
   * original error is rethrown. The rollback rebuilds equivalent state with
   * freshly allocated ids, so `Entity` references held before the move are stale
   * afterwards; `moveSubtree` does not report the replacement entities.
   *
   * Destroying a root applies its component `remove` hooks and its relationship
   * cleanup policies, which can reach outside the captured forest. Select
   * transferable data accordingly.
   *
   * @param rootOrRoots - A single root entity, or an array of roots moved as one
   *   atomic forest.
   * @param destination - World that receives the forest.
   * @param options - Traversal relationship, component and relationship
   *   allowlists, and the external-target policy.
   * @returns The destination entities, keyed by snapshot key and by source
   *   entity.
   * @throws If the transfer cannot complete. The source forest survives
   *   unchanged when preflight fails, and is restored when the destination
   *   restore fails.
   *
   * @example
   * ```ts
   * const result = world.moveSubtree([ship, ...escorts], nextSectorWorld, {
   *   components: [Position, LinearVelocity, Hull, Cargo],
   *   relationships: [ChildOf, Carries, TetheredTo],
   * });
   * ```
   */
  public moveSubtree(
    this: World,
    rootOrRoots: Entity | readonly Entity[],
    destination: World,
    options: SubtreeSnapshotOptions = {}
  ): MoveSubtreeResult {
    this._assertNotDeferred("moveSubtree");
    if (destination === this) {
      throw new Error("moveSubtree requires a destination world other than the source");
    }
    destination._assertNotDeferred("moveSubtree");

    const snapshot = _captureSubtree(this, rootOrRoots, options);
    _preflightRestore(destination, snapshot);

    for (const record of snapshot.entities) {
      if (!record.source.destroyed) {
        record.source.destroy();
      }
    }

    try {
      return _restoreSubtree(destination, snapshot);
    } catch (error) {
      this._rollback(snapshot);
      throw error;
    }
  }

  /** @internal Reject cross-world scheduling while a world is queueing mutations. */
  private _assertNotDeferred(this: World, operation: string): void {
    if (this.deferred) {
      throw new Error(
        `${operation} cannot run while the world is deferred; cross-world scheduling is the application's job`
      );
    }
  }

  /** @internal Best-effort restore of the source forest after a failed transfer. */
  private _rollback(this: World, snapshot: EntitySubtreeSnapshot): void {
    try {
      _restoreSubtree(this, snapshot);
    } catch {
      // The destination failure is the actionable error; a failed rollback is a
      // consequence of it and must not mask it.
    }
  }
}
