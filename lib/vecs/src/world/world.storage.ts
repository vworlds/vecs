import type { Entity } from "../entity/index.js";
import { ArrayMap, IterableArrayMap, type ReadonlyIterableArrayMap } from "../util/array_map.js";
import { Pools } from "./world.pools.js";

export class Storage extends Pools {
  /**
   * @internal Entity id -> entity. Owns every live entity.
   *
   * Backed by an {@link IterableArrayMap} rather than a `Map`: entity ids are dense
   * pooled integers, so array indexing beats hashing on the lookups that run
   * per component during teardown (`world.entity(componentEid)` in
   * `Entity._destroy`) and on every `world.entity(eid)` resolution.
   */
  protected _entities = new IterableArrayMap<Entity>();

  /** @internal Entity id -> entity queued for deferred creation, not query-visible yet. */
  protected _deferredEntities = new ArrayMap<Entity>();

  /** Read-only view of the live entities, keyed by entity id. */
  public get entities(): ReadonlyIterableArrayMap<Entity> {
    return this._entities;
  }

  /**
   * Return the runtime class name and live entity count (including infrastructure)
   * for JSON and assertion/snapshot formatting, without traversing entity data.
   * This diagnostic summary is not a persistence format.
   */
  public toJSON(): { world: string; entities: number } {
    return { world: this.constructor.name, entities: this.entities.size };
  }

  /** @internal Remove an entity from the world's entity map (called by `Entity._destroy`). */
  public _unregisterEntity(entity: Entity): void {
    this._entities.delete(entity.eid);
    this._deferredEntities.delete(entity.eid);
    this._poolFor(entity.eid).free(entity.eid);
  }
}
