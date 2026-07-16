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
  protected _addIncoming(target: Entity | undefined, relEid: EID): void {
    if (!target || target._destroyed) {
      return;
    }
    let sources = target._incoming?.get(relEid);
    if (!sources) {
      sources = new DenseSet<Entity>();
      (target._incoming ??= new IterableArrayMap()).set(relEid, sources);
    }
    sources.add(this as unknown as Entity);
  }

  /** @internal */
  protected _removeIncoming(target: Entity | undefined, relEid: EID): void {
    const sources = target?._incoming?.get(relEid);
    if (!sources) {
      return;
    }
    sources.delete(this as unknown as Entity);
    if (sources.size === 0) {
      target!._incoming!.delete(relEid);
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
