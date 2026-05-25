import type { Entity } from "../entity/index.js";
import { Pools } from "./world.pools.js";

export class Storage extends Pools {
  /** @internal Entity id -> entity. Owns every live entity. */
  protected _entities = new Map<number, Entity>();

  /** Read-only view of the live entities, keyed by entity id. */
  public get entities(): Omit<Map<number, Entity>, "set" | "delete" | "clear"> {
    return this._entities as any;
  }

  /** @internal Remove an entity from the world's entity map (called by `Entity._destroy`). */
  public _unregisterEntity(entity: Entity): void {
    this._entities.delete(entity.eid);
    this._poolFor(entity.eid).free(entity.eid);
  }
}
