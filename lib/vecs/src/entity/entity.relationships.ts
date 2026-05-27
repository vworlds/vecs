import { CleanupPolicy, type ComponentMeta, type ComponentRef } from "../component_meta.js";
import { Relationship } from "../relationship.js";
import { ArrayMap } from "../util/array_map.js";
import { DenseSet } from "../util/dense_set.js";
import type { Entity } from "./entity.js";
import { Queries } from "./entity.queries.js";

export class Relationships extends Queries {
  /** Return this entity's target through relationship `ref`, if present. */
  public parent(ref: ComponentRef): Entity | undefined {
    return (this._components.get(this.world.entity(ref).eid) as Relationship | undefined)?.target;
  }

  /** Return entities targeting this one through relationship `ref`. */
  public children(ref: ComponentRef): ReadonlySet<Entity> {
    return this._incoming?.get(this.world.entity(ref).eid) ?? Relationships._emptyIncoming;
  }

  /** @internal Return entities targeting this one through resolved relationship eid. */
  public _childrenByEid(relEid: number): ReadonlySet<Entity> | undefined {
    return this._incoming?.get(relEid);
  }

  /** @internal */
  protected _addIncoming(target: Entity | undefined, relEid: number): void {
    if (!target || target._destroyed) {
      return;
    }
    let sources = target._incoming?.get(relEid);
    if (!sources) {
      sources = new DenseSet<Entity>();
      (target._incoming ??= new ArrayMap()).set(relEid, sources);
    }
    sources.add(this as unknown as Entity);
  }

  /** @internal */
  protected _cleanupIncoming(): void {
    this._incoming?.forEach((sources, relEid) => {
      const relEntity = this.world.getEntity(relEid);
      if (!relEntity) {
        return;
      }
      const policy = relEntity.ownMeta.onDeleteTarget;
      for (const source of [...sources]) {
        if (policy === CleanupPolicy.Delete) {
          // If source is also an in-use component entity with onDelete Throw,
          // this exotic cascade can still throw; revisit with the relationship rework.
          source.destroy();
        } else {
          source.remove(relEid);
        }
      }
    });
    this._incoming = undefined;
  }

  /** @internal */
  protected _removeIncoming(target: Entity | undefined, relEid: number): void {
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
  protected _updateIncoming(
    meta: ComponentMeta,
    oldTarget: Entity | undefined,
    newTarget: Entity | undefined
  ): void {
    if (!meta.isRelationship || oldTarget === newTarget) {
      return;
    }
    this._removeIncoming(oldTarget, meta.eid);
    this._addIncoming(newTarget, meta.eid);
  }
}
