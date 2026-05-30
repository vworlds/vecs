import type { Entity } from "../entity/index.js";
import { ArrayMap, type ReadonlyArrayMap } from "../util/array_map.js";
import { Pools } from "./world.pools.js";

export class Storage extends Pools {
  /**
   * @internal Entity id -> entity. Owns every live entity.
   *
   * Backed by an {@link ArrayMap} rather than a `Map`: entity ids are dense
   * pooled integers, so array indexing beats hashing on the lookups that run
   * per component during teardown (`world.entity(componentEid)` in
   * `Entity._destroy`) and on every `world.entity(eid)` resolution.
   */
  protected _entities = new ArrayMap<Entity>();

  /** Read-only view of the live entities, keyed by entity id. */
  public get entities(): ReadonlyArrayMap<Entity> {
    return this._entities;
  }

  /** @internal Remove an entity from the world's entity map (called by `Entity._destroy`). */
  public _unregisterEntity(entity: Entity): void {
    this._entities.delete(entity.eid);
    this._poolFor(entity.eid).free(entity.eid);
  }
}
