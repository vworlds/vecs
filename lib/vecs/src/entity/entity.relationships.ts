import { CommandKind, type Command } from "../command.js";
import { Relationship, type ComponentMeta, type ComponentRef } from "../component_meta.js";
import { IterableArrayMap } from "../util/array_map.js";
import { DenseSet } from "../util/dense_set.js";
import type { EID, Entity } from "./entity.js";
import { Queries } from "./entity.queries.js";

/** Options for {@link Relationships.targets} and {@link Relationships.hasTarget}. */
export interface TargetReadOptions {
  /**
   * Also count the edge commands queued for this entity and relationship in the
   * current deferred scope: queued adds are included, queued removals (one edge
   * or the whole relationship) are excluded, and an `Exclusive` relationship
   * reports only its queued replacement. Targets already destroyed are never
   * reported, and a destroyed entity reports none. Outside deferred mode nothing
   * is queued, so the result equals the committed read. Defaults to `false`:
   * committed edges only.
   *
   * The read scans the world's not-yet-applied commands, so it costs time
   * proportional to the commands queued in the current scope; writes pay
   * nothing for it. Use it for occasional reads, not per-entity hot loops.
   */
  pending?: boolean;
}

export class Relationships extends Queries {
  /** Return this entity's target through relationship `ref`, if present. */
  public target(rel: ComponentRef): Entity | undefined {
    const relEid = typeof rel === "number" ? rel : this.world.entity(rel).eid;
    return (this._components.get(relEid) as Relationship | undefined)?._target();
  }

  /**
   * Return a safe readonly snapshot of all targets through relationship `ref`.
   *
   * By default only committed edges are reported: inside a deferred scope an
   * edge queued by `add(ref, target)` is not visible until the queue drains.
   * Pass `{ pending: true }` to include the queued edge commands; see
   * {@link TargetReadOptions}.
   */
  public targets(rel: ComponentRef, options?: TargetReadOptions): readonly Entity[] {
    const relEid = typeof rel === "number" ? rel : this.world.entity(rel).eid;
    const committed =
      (this._components.get(relEid) as Relationship | undefined)?._targetArray() ?? [];
    if (!options?.pending) {
      return committed;
    }
    return this._pendingTargets(this.world.entity(relEid).meta, committed);
  }

  /**
   * Return whether this entity targets `target` through relationship `ref`.
   *
   * By default only committed edges are tested. Pass `{ pending: true }` to
   * answer from the committed edge plus the edge commands queued in the
   * current deferred scope; see {@link TargetReadOptions}.
   */
  public hasTarget(rel: ComponentRef, target: Entity, options?: TargetReadOptions): boolean {
    const relEid = typeof rel === "number" ? rel : this.world.entity(rel).eid;
    const committed =
      (this._components.get(relEid) as Relationship | undefined)?._hasTarget(target) ?? false;
    if (!options?.pending) {
      return committed;
    }
    return this._hasPendingTarget(this.world.entity(relEid).meta, target, committed);
  }

  /** @internal Test targets by relationship eid without allocating a snapshot. */
  public _someTargetByEid(relEid: EID, predicate: (target: Entity) => boolean): boolean {
    return (
      (this._components.get(relEid) as Relationship | undefined)?._someTarget(predicate) ?? false
    );
  }

  /** Return entities targeting this one through relationship `ref`. */
  public children(ref: ComponentRef): ReadonlySet<Entity> {
    const relEid = typeof ref === "number" ? ref : this.world.entity(ref).eid;
    return this._incoming?.get(relEid) ?? Relationships._emptyIncoming;
  }

  /**
   * @internal Fast child set lookup by relationship eid — skips ref -> eid
   * resolution. Used by the `source` predicate and fan-out invoker.
   */
  public _childrenByEid(relEid: EID): ReadonlySet<Entity> | undefined {
    return this._incoming?.get(relEid);
  }

  /** @internal */
  protected _addIncoming(this: Entity, target: Entity | undefined, relEid: EID): void {
    if (!target || target._destroyed) {
      return;
    }
    let sources = target._incoming?.get(relEid);
    if (!sources) {
      sources = new DenseSet<Entity>();
      (target._incoming ??= new IterableArrayMap()).set(relEid, sources);
    }
    sources.add(this);
  }

  /** @internal */
  protected _removeIncoming(this: Entity, target: Entity | undefined, relEid: EID): void {
    const sources = target?._incoming?.get(relEid);
    if (!sources) {
      return;
    }
    sources.delete(this);
    if (sources.size === 0) {
      target!._incoming!.delete(relEid);
    }
  }

  /** @internal */
  protected _notifyRelationshipChanged(
    this: Entity,
    meta: ComponentMeta,
    relationship: Relationship
  ): void {
    if (this.world.deferred) {
      // Edge commands already validated the relationship. Dirty pairs need no
      // data-write bookkeeping or producer lookup on subsequent edge changes.
      if (this._dirtyComponentBitmask.hasBit(meta.bitPtr)) {
        return;
      }
      this._dirtyComponentBitmask.addBit(meta.bitPtr);
      this.world._enqueueRelationshipUpdate(this, meta, this.world._routingSource);
      return;
    }
    this.world._notifyComponentChanged(meta.eid, this);
    this._routeModified(meta.eid, relationship);
  }

  /** Replay this entity's not-yet-applied edge commands over the committed `targets` snapshot. */
  private _pendingTargets(meta: ComponentMeta, targets: Entity[]): readonly Entity[] {
    if (this._destroyed) {
      return [];
    }
    const queue = this.world._queuedCommands;
    for (let i = this.world._queuedCommandStart; i < queue.length; i++) {
      const cmd = queue[i]!;
      if (!this._isEdgeCommandFor(cmd, meta)) {
        continue;
      }
      if (cmd.kind === CommandKind.Remove) {
        targets.length = 0;
      } else if (cmd.kind === CommandKind.RemoveTarget) {
        const index = targets.indexOf(cmd.target);
        if (index !== -1) {
          targets.splice(index, 1);
        }
      } else if (!cmd.target._destroyed && !targets.includes(cmd.target)) {
        if (meta.relationshipExclusive) {
          targets.length = 0;
        }
        targets.push(cmd.target);
      }
    }
    return targets.some((target) => target._destroyed)
      ? targets.filter((target) => !target._destroyed)
      : targets;
  }

  /** Answer from the newest not-yet-applied edge command that decides `target`, else `committed`. */
  private _hasPendingTarget(meta: ComponentMeta, target: Entity, committed: boolean): boolean {
    if (this._destroyed || target._destroyed) {
      return false;
    }
    const queue = this.world._queuedCommands;
    for (let i = queue.length - 1; i >= this.world._queuedCommandStart; i--) {
      const cmd = queue[i]!;
      if (!this._isEdgeCommandFor(cmd, meta)) {
        continue;
      }
      if (cmd.kind === CommandKind.Remove) {
        return false;
      }
      if (cmd.target === target) {
        return cmd.kind === CommandKind.AddTarget;
      }
      if (
        cmd.kind === CommandKind.AddTarget &&
        meta.relationshipExclusive &&
        !cmd.target._destroyed
      ) {
        return false;
      }
    }
    return committed;
  }

  /** Whether `cmd` adds or removes an edge of `meta`, or removes `meta`, on this entity. */
  private _isEdgeCommandFor(
    cmd: Command,
    meta: ComponentMeta
  ): cmd is Extract<
    Command,
    { kind: CommandKind.AddTarget | CommandKind.RemoveTarget | CommandKind.Remove }
  > {
    return (
      (cmd.kind === CommandKind.AddTarget ||
        cmd.kind === CommandKind.RemoveTarget ||
        cmd.kind === CommandKind.Remove) &&
      cmd.entity === (this as unknown) &&
      cmd.meta === meta
    );
  }
}
