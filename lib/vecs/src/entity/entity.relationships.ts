import { Relationship, type ComponentMeta, type ComponentRef } from "../component_meta.js";
import { IterableArrayMap } from "../util/array_map.js";
import { DenseSet } from "../util/dense_set.js";
import type { EID, Entity } from "./entity.js";
import { Queries } from "./entity.queries.js";

export class Relationships extends Queries {
  /** Return this entity's target through relationship `ref`, if present. */
  public target(rel: ComponentRef): Entity | undefined {
    const relEid = typeof rel === "number" ? rel : this.world.entity(rel).eid;
    const relationship = this._components.get(relEid);
    return relationship instanceof Relationship ? relationship._target() : undefined;
  }

  /** Return a safe readonly snapshot of all targets through relationship `ref`. */
  public targets(rel: ComponentRef): readonly Entity[] {
    const relEid = typeof rel === "number" ? rel : this.world.entity(rel).eid;
    const relationship = this._components.get(relEid);
    return relationship instanceof Relationship ? relationship._targetArray() : [];
  }

  /** Return whether this entity targets `target` through relationship `ref`. */
  public hasTarget(rel: ComponentRef, target: Entity): boolean {
    const relEid = typeof rel === "number" ? rel : this.world.entity(rel).eid;
    const relationship = this._components.get(relEid);
    return relationship instanceof Relationship && relationship._hasTarget(target);
  }

  /** @internal Test targets by relationship eid without allocating a snapshot. */
  public _someTargetByEid(relEid: EID, predicate: (target: Entity) => boolean): boolean {
    const relationship = this._components.get(relEid);
    return relationship instanceof Relationship && relationship._someTarget(predicate);
  }

  /** Return entities targeting this one through relationship `ref`. */
  public children(ref: ComponentRef): ReadonlySet<Entity> {
    const meta =
      typeof ref === "number" ? this.world.getEntity(ref)?.meta : this.world.entity(ref).meta;
    return meta
      ? (this._childrenByMeta(meta) ?? Relationships._emptyIncoming)
      : Relationships._emptyIncoming;
  }

  /**
   * @internal Fast child set lookup by relationship eid — skips ref -> eid
   * resolution. Used by the `source` predicate and fan-out invoker.
   */
  public _childrenByEid(relEid: EID): ReadonlySet<Entity> | undefined {
    const meta = this.world.getEntity(relEid)?.meta;
    return meta ? this._childrenByMeta(meta) : undefined;
  }

  /** @internal Return sources indexed for one exact relationship generation. */
  public _childrenByMeta(meta: ComponentMeta): ReadonlySet<Entity> | undefined {
    return this._incoming?.get(meta.eid)?.get(meta);
  }

  /** @internal */
  protected _addIncoming(target: Entity | undefined, meta: ComponentMeta): void {
    if (!target || target._destroyed) {
      return;
    }
    let generations = target._incoming?.get(meta.eid);
    if (!generations) {
      generations = new Map();
      (target._incoming ??= new IterableArrayMap()).set(meta.eid, generations);
    }
    let sources = generations.get(meta);
    if (!sources) {
      sources = new DenseSet<Entity>();
      generations.set(meta, sources);
    }
    sources.add(this as unknown as Entity);
  }

  /** @internal */
  protected _removeIncoming(target: Entity | undefined, meta: ComponentMeta): void {
    const generations = target?._incoming?.get(meta.eid);
    const sources = generations?.get(meta);
    if (!sources) {
      return;
    }
    sources.delete(this as unknown as Entity);
    if (sources.size === 0) {
      generations!.delete(meta);
      if (generations!.size === 0) {
        target!._incoming!.delete(meta.eid);
      }
    }
  }

  /** @internal */
  protected _notifyRelationshipChanged(meta: ComponentMeta, relationship: Relationship): void {
    const entity = this as unknown as Entity;
    if (meta._isInitializing(entity)) {
      return;
    }
    this.world._notifyComponentChanged(meta.eid, entity);
    this._queries.forEach((query) => query._notifyModified(entity, meta.eid, relationship));
  }
}
