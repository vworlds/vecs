import { CommandKind, type EdgeCommand } from "../command.js";
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

  /**
   * @internal Mark one queued edge command applied. Called by the world just
   * before it executes the command, so hooks fired by the command see it as
   * committed rather than pending.
   */
  public _consumePendingEdge(cmd: EdgeCommand): void {
    const pending = this._pendingEdges;
    if (pending?.commands[pending.head] !== cmd) {
      return;
    }
    pending.commands[pending.head] = undefined;
    if (++pending.head === pending.size) {
      pending.head = pending.size = 0;
    }
  }

  /** @internal Queue an edge command and record it for pending-aware reads. */
  protected _enqueueEdge(this: Entity, cmd: EdgeCommand): void {
    this.world._enqueue(cmd);
    const pending = (this._pendingEdges ??= { commands: [], head: 0, size: 0 });
    pending.commands[pending.size++] = cmd;
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
    this.world._notifyComponentChanged(meta.eid, this);
    this._routeModified(meta.eid, relationship);
  }

  /** Replay the queued edge commands over the committed `targets` snapshot. */
  private _pendingTargets(meta: ComponentMeta, targets: Entity[]): readonly Entity[] {
    if (this._destroyed) {
      return [];
    }
    const pending = this._pendingEdges;
    if (pending) {
      for (let i = pending.head; i < pending.size; i++) {
        const cmd = pending.commands[i]!;
        if (cmd.meta !== meta) {
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
    }
    return targets.some((target) => target._destroyed)
      ? targets.filter((target) => !target._destroyed)
      : targets;
  }

  /** Answer from the newest queued edge command that decides `target`, else `committed`. */
  private _hasPendingTarget(meta: ComponentMeta, target: Entity, committed: boolean): boolean {
    if (this._destroyed || target._destroyed) {
      return false;
    }
    const pending = this._pendingEdges;
    if (!pending) {
      return committed;
    }
    for (let i = pending.size - 1; i >= pending.head; i--) {
      const cmd = pending.commands[i]!;
      if (cmd.meta !== meta) {
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
}
