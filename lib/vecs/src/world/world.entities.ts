import { CommandKind } from "../command.js";
import { type ComponentRef } from "../component.js";
import { Entity, type EntityClass } from "../entity/index.js";
import { Deferred } from "./world.deferred.js";
import type { World } from "./world.js";

const RESERVED_EID = 0;

export class Entities extends Deferred {
  /** Return the entity with id `eid`, creating it if it does not yet exist. */
  public getOrCreateEntity(
    this: World,
    eid: number,
    onCreateCallback?: (e: Entity) => void
  ): Entity {
    if (eid === RESERVED_EID) {
      throw new Error(`Entity eid ${eid} is reserved`);
    }
    let e = this._entities.get(eid);
    if (!e) {
      this._reserveEid(eid);
      e = new Entity(this, eid);
      this._entities.set(eid, e);
      this._placeNewEntity(e);
      if (onCreateCallback) {
        onCreateCallback(e);
      }
    }
    return e;
  }

  /** Look up an entity by component ref. */
  public getEntity(this: World, ref: ComponentRef): Entity | undefined {
    if (typeof ref === "function") {
      return this._classRegistry.get(ref);
    }
    if (typeof ref === "number") {
      if (ref === RESERVED_EID) {
        throw new Error(`Entity eid ${ref} is reserved`);
      }
      return this._entities.get(ref);
    }
    return ref.world === this && this._entities.get(ref.eid) === ref ? ref : undefined;
  }

  /** Create a new entity with an auto-assigned id. */
  public entity(this: World): Entity;
  /** Look up an existing entity by component ref. */
  public entity(this: World, ref: ComponentRef): Entity;
  public entity(this: World, ref?: ComponentRef): Entity {
    if (ref === undefined) {
      return this._entity(Entity);
    }
    const entity = this.getEntity(ref);
    if (entity) {
      return entity;
    }
    if (typeof ref === "function") {
      throw new Error(`unregistered component entity for component class '${ref.name}'`);
    }
    if (typeof ref === "number") {
      throw new Error(`No entity with eid ${ref}`);
    }
    throw new Error(`No entity with eid ${ref.eid}`);
  }

  /** Destroy every entity currently tracked by the world. */
  public clearAllEntities(): void {
    const pending = new Set(this._entities.values());
    while (pending.size > 0) {
      let destroyed = 0;
      for (const entity of [...pending]) {
        const instanceCount = entity.instanceCount();
        if (instanceCount > (entity._get(entity.eid) ? 1 : 0)) {
          continue;
        }
        entity.destroy();
        pending.delete(entity);
        destroyed++;
      }
      if (destroyed === 0) {
        throw new Error("Cannot clear entities because component eids are still in use");
      }
    }
    this.flush();
  }

  /** @internal Create an entity with an id from the entity pool. */
  protected _entity<T extends Entity>(this: World, Constructor: EntityClass<T>): T {
    const eid = this._entityPool.alloc();
    const e = new Constructor(this, eid);
    if (this.deferred) {
      this._enqueue({ kind: CommandKind.CreateEntity, entity: e });
    } else {
      this._entities.set(eid, e);
      this._placeNewEntity(e);
    }
    return e;
  }
}
