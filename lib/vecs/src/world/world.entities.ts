import { CommandKind } from "../command.js";
import { type ComponentRef } from "../component.js";
import { Entity, Identity, type EID, type EntityClass } from "../entity/index.js";
import { Deferred } from "./world.deferred.js";
import type { World } from "./world.js";
import { carriersFirst } from "./destroy-order.js";
import { ChildOf } from "../modules/relationship_types.js";

const RESERVED_EID = 0;

export class Entities extends Deferred {
  /** @internal Parent applied only to entities created in the current scope. */
  protected _scope: Entity | undefined = undefined;

  /**
   * Return the entity with id `eid`, creating it if it does not yet exist.
   *
   * In deferred mode, a newly created entity remains hidden from collections
   * and queries until flush, but numeric lookups (`getEntity(eid)`,
   * `entity(eid)`) and repeated `getOrCreateEntity(eid)` calls in the same
   * deferred scope return that same pending entity.
   */
  public getOrCreateEntity(this: World, eid: EID, onCreateCallback?: (e: Entity) => void): Entity {
    if (eid === RESERVED_EID) {
      throw new Error(`Entity eid ${eid} is reserved`);
    }
    let e = this._entities.get(eid);
    if (!e && this.deferred) {
      e = this._deferredEntities.get(eid);
    }
    if (!e) {
      this._reserveEid(eid);
      e = new Entity(this, eid);
      if (this.deferred) {
        // Mirror `_entity`: in deferred mode the entity is not registered or
        // made visible to queries until the queue drains. The reservation above
        // still happens eagerly so the id cannot be handed out again meanwhile.
        this._deferredEntities.set(eid, e);
        this._enqueue({ kind: CommandKind.CreateEntity, entity: e, onCreate: onCreateCallback });
      } else {
        this._entities.set(eid, e);
        const parent = this._scope;
        if (parent !== undefined) {
          e.childOf(parent);
        }
        this._notifyEntityCreated(e);
        onCreateCallback?.(e);
      }
    }
    return e;
  }

  /**
   * Look up an entity by component ref or identity name.
   *
   * A foreign `Entity` (one whose `world` is not this world) throws: passing an
   * entity from another world is a programming error, not a miss. An `Entity`
   * whose world matches but whose eid is unknown (e.g. after destruction)
   * returns `undefined`.
   */
  public getEntity(this: World, ref: ComponentRef | string): Entity | undefined {
    if (typeof ref === "string") {
      return this._identityNameIndex.get(ref);
    }
    if (typeof ref === "function") {
      return this._classRegistry.get(ref);
    }
    if (typeof ref === "number") {
      if (ref === RESERVED_EID) {
        throw new Error(`Entity eid ${ref} is reserved`);
      }
      const entity = this._entities.get(ref);
      return entity ?? (this.deferred ? this._deferredEntities.get(ref) : undefined);
    }
    if (ref.world !== this) {
      throw new Error("Entity belongs to a different World");
    }
    return this._entities.get(ref.eid) === ref
      ? ref
      : this.deferred
        ? this._deferredEntities.get(ref.eid)
        : undefined;
  }

  /** Create a new entity with an auto-assigned id. */
  public entity(this: World): Entity;
  /** Look up an existing entity by identity name, creating it if absent. */
  public entity(this: World, ref: string): Entity;
  /**
   * Look up an existing entity by component ref.
   *
   * A foreign `Entity` ref throws (see {@link getEntity}).
   */
  public entity(this: World, ref: ComponentRef): Entity;
  public entity(this: World, ref?: ComponentRef | string): Entity {
    if (ref === undefined) {
      return this._entity(Entity);
    }
    if (typeof ref === "string") {
      let entity = this._identityNameIndex.get(ref);
      if (entity) {
        return entity;
      }
      entity = this._entity(Entity);
      entity.set(Identity, { name: ref });
      return entity;
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

  /**
   * Destroy every tracked entity, ordering both carriers and ChildOf children
   * before their keys/parents. Retains ordinary cleanup policies; throws when
   * dependency cycles prevent safe destruction (unlike dispose's final pass).
   */
  public clearAllEntities(): void {
    const pending = new Set(this._entities.values());
    while (pending.size > 0) {
      let destroyed = 0;
      for (const entity of carriersFirst([...pending], this._classRegistry.get(ChildOf)?.eid)) {
        entity.destroy();
        pending.delete(entity);
        destroyed++;
      }
      if (destroyed === 0) {
        throw new Error(
          "Cannot clear entities because component or ChildOf dependencies cannot be ordered"
        );
      }
    }
    this.flush();
  }

  /**
   * Parent entities created synchronously in `fn`'s body to `parent` through ChildOf.
   * Includes components, modules, queries, systems and ordinary entities. Existing
   * lookups are not reparented; an explicit childOf call replaces the scope parent.
   * Nested scopes restore their caller in finally, even when fn throws.
   * Entities created by deferred callbacks inside the body are not parented:
   * query.forEach, enter backfill during query build, or an explicit world.defer.
   * These are run-time data; the same callback outside the scope would not parent
   * them either. For example, health bars created per existing ship by an enter
   * or forEach callback remain roots, unlike definitions created directly in init.
   * Throws while deferred: call outside progress() and defer, not during a command
   * drain. Schedule lazy module loading after progress() returns.
   * The parent must be a live entity of this world. This is a synchronous scope,
   * not an async context; it does not change deferral or catch callback errors.
   */
  public scope(this: World, parent: Entity, fn: () => void): void {
    if (this.deferred) {
      throw new Error("Call world.scope() outside progress() and defer");
    }
    this.entity(parent);
    if (parent.destroyed) {
      throw new Error("scope parent must be alive");
    }
    const previous = this._scope;
    this._scope = parent;
    try {
      fn();
    } finally {
      this._scope = previous;
    }
  }

  /** @internal Create an entity with an id from the entity pool. */
  protected _entity<T extends Entity>(this: World, Constructor: EntityClass<T>): T {
    const eid = this._entityPool.alloc();
    const e = new Constructor(this, eid);
    if (this.deferred) {
      this._deferredEntities.set(eid, e);
      this._enqueue({ kind: CommandKind.CreateEntity, entity: e });
    } else {
      this._entities.set(eid, e);
      const parent = this._scope;
      if (parent !== undefined) {
        e.childOf(parent);
      }
      this._notifyEntityCreated(e);
    }
    return e;
  }
}
