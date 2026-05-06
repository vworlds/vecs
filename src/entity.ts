import { Component } from "./component.js";
import type { World } from "./world.js";
import { CommandKind } from "./command.js";
import { ArrayMap, ReadonlyArrayMap } from "./util/array_map.js";
import { type Query } from "./query.js";
import { Events } from "./util/events.js";
import { Bitset } from "./util/bitset.js";

type EntityEvents = Events<{ destroy(): void }>;

/**
 * A game object: a unique numeric id with an arbitrary set of
 * {@link Component | components} attached.
 *
 * Never instantiate `Entity` directly. Use {@link World.entity} for an
 * auto-assigned id, or {@link World.getOrCreateEntity} when the id comes from
 * an external authority such as a game server:
 *
 * ```ts
 * const e = world.entity();
 * e.set(Position, { x: 100 });
 * ```
 *
 * Entities support a parent–child hierarchy. `parent` and `children` form a
 * bidirectional link maintained by {@link setParent}; the children set is
 * created lazily. Destroying a parent recursively destroys its children.
 *
 * ## Deferred semantics
 *
 * Inside a system body or `forEach` iteration the world is in **deferred
 * mode**: `add` / `set` / `modified` / `remove` / `destroy` / `setParent` only
 * enqueue commands. The data layer (the components map and `componentBitmask`)
 * is mutated when the world drains its queue. Concretely, while deferred:
 *
 * - `entity.get(C)` returns `undefined` after `entity.add(C)` (no instance yet).
 * - `entity.get(C)` returns the previous value after `entity.set(C, props)`.
 * - `entity.get(C)` still returns the component after `entity.remove(C)`.
 *
 * Outside deferred mode the same calls execute inline and mutations are
 * visible immediately.
 */
export class Entity {
  /** @internal Maps numeric component type id to component instance. */
  private _components = new ArrayMap<Component>();
  /** @internal Set of queries this entity currently belongs to. */
  private readonly _queries = new Set<Query>();

  /** @internal Empty children set used as the default `children` value. */
  private static readonly _emptyChildren: ReadonlySet<Entity> = new Set();

  /** @internal Parent reference; `undefined` for root entities. */
  private _parent: Entity | undefined;
  /** @internal Children set, allocated lazily on first child link. */
  private _children: Set<Entity> | undefined;

  /**
   * Bitmask of component type ids currently attached to this entity. Used by
   * the world for fast archetype matching against query predicates.
   */
  public readonly componentBitmask = new Bitset();

  /**
   * Free-form property bag. Modules can use it to associate arbitrary data with
   * an entity without registering a dedicated component.
   */
  public properties = new Map<string, any>();

  /** @internal Set to `true` after the world has fully torn down this entity. */
  public _destroyed: boolean = false;

  /** @internal Lazy event emitter, allocated on first {@link events} access. */
  declare public _events: EntityEvents;

  constructor(
    /** World that owns this entity. */
    public readonly world: World,
    /** Unique numeric entity id assigned at creation. */
    public readonly eid: number
  ) {}

  /**
   * Re-evaluate every world query for this entity, firing `_enter` / `_exit`
   * routing whenever membership flipped.
   */
  private _updateQueries(): void {
    this.world.queries.forEach((q) => {
      const belongs = q.belongs(this);
      const isIn = this._isInQuery(q);
      if (belongs !== isIn) {
        belongs ? q._enter(this) : q._exit(this);
      }
    });
  }

  /**
   * Construct a fresh component of `type`, apply `props`, store it on this
   * entity, fire the `onAdd` hook, and route query updates.
   *
   * If the component type belongs to an exclusivity group, any conflicting
   * component already on this entity is removed first.
   */
  private _new(type: number, props: Partial<Component> | undefined): Component {
    const meta = this.world.getComponentMeta(type);
    if (meta.exclusive) {
      for (const exclusiveType of meta.exclusive) {
        if (this._components.has(exclusiveType)) {
          this._remove(exclusiveType);
        }
      }
    }
    const c = new meta.Class(this, meta);
    if (props !== undefined) {
      Object.assign(c, props);
    }
    this._components.set(type, c);
    this.componentBitmask.add(type);
    meta._onAddHandler?.(c);
    this._updateQueries();
    return c;
  }

  /**
   * @internal Return `true` when this entity is currently tracked by `q`.
   */
  public _isInQuery(q: Query): boolean {
    return this._queries.has(q);
  }

  /**
   * @internal Look up a component instance by numeric type id.
   *
   * Faster than {@link get} because no class → type id resolution is needed.
   */
  public _get(type: number): Component | undefined {
    return this._components.get(type);
  }

  /**
   * @internal Reparent this entity in place, maintaining the bidirectional
   * link. Throws if `newParent` is a descendant of this entity.
   *
   * Called by the world either inline (outside deferred mode) or while
   * routing a queued `SetParent` command.
   */
  public _setParent(newParent: Entity | undefined): void {
    if (newParent !== undefined) {
      let ancestor: Entity | undefined = newParent;
      while (ancestor !== undefined) {
        if (ancestor === this) {
          throw new Error(
            `Circular parent reference: entity ${this.eid} is already an ancestor of entity ${newParent.eid}`
          );
        }
        ancestor = ancestor._parent;
      }
    }
    if (this._parent) {
      this._parent._children?.delete(this);
    }
    this._parent = newParent;
    if (newParent) {
      (newParent._children ??= new Set()).add(this);
    }
  }

  /**
   * @internal Apply a `Set` command: create the component if missing, assign
   * `props` if provided, fire `onSet`, and route modified events to every
   * query that watches the component type.
   */
  public _set(type: number, props: Partial<Component> | undefined): void {
    if (this._destroyed) {
      return;
    }
    const existing = this._components.get(type);
    const c = existing ?? this._new(type, props);
    if (props !== undefined) {
      if (existing) {
        Object.assign(c, props);
      }
      c.meta._onSetHandler?.(c);
      c._dirty = false;
      if (existing) {
        this._queries.forEach((q) => q._notifyModified(c));
      }
    }
  }

  /**
   * @internal Apply a `Modified` command: fire `onSet` and route modified
   * events to every query that watches the component type.
   */
  public _modified(type: number): void {
    if (this._destroyed) {
      return;
    }
    const c = this._components.get(type);
    if (!c) {
      return;
    }
    c.meta._onSetHandler?.(c);
    c._dirty = false;
    this._queries.forEach((q) => q._notifyModified(c));
  }

  /**
   * @internal Apply a `Remove` command: clear the type bit, route exits,
   * detach the component, and fire `onRemove`.
   */
  public _remove(type: number): void {
    if (this._destroyed) {
      return;
    }
    const c = this._components.get(type);
    if (!c) {
      return;
    }
    this.componentBitmask.delete(type);
    this._updateQueries();
    this._components.delete(type);
    c.meta._onRemoveHandler?.(c);
  }

  /**
   * @internal Apply a `Destroy` command: fire `_exit` on every query, then
   * `onRemove` on every component, emit the `destroy` event, and unlink from
   * the world and any parent.
   */
  public _destroy(): void {
    if (this._destroyed) {
      return;
    }

    const toExit: Query[] = [];
    this._queries.forEach((q) => {
      if (q.world) {
        toExit.push(q);
      }
    });
    toExit.forEach((q) => q._exit(this));

    this._components.forEach((c) => c.meta._onRemoveHandler?.(c));

    if (this._events) {
      this._events.emit("destroy");
      this._events.removeAllListeners("destroy");
    }

    this._destroyed = true;
    this.world._unregisterEntity(this);
    if (this._parent) {
      this._parent._children?.delete(this);
      this._parent = undefined;
    }
  }

  /**
   * @internal Forget query `q` without firing exit callbacks. Called by
   * {@link World} when a {@link Query.destroy} sweeps every entity.
   */
  public _purgeQuery(q: Query): void {
    this._queries.delete(q);
  }

  /**
   * @internal Record that this entity is now tracked by `q`. Called by
   * `Query._enter`.
   */
  public _addQueryMembership(q: Query): void {
    this._queries.add(q);
  }

  /**
   * @internal Record that this entity is no longer tracked by `q`. Called by
   * `Query._exit`.
   */
  public _removeQueryMembership(q: Query): void {
    this._queries.delete(q);
  }

  /** Parent entity in the scene hierarchy, or `undefined` for a root entity. */
  public get parent(): Entity | undefined {
    return this._parent;
  }

  /**
   * Read-only view of direct child entities. The backing set is created lazily
   * on the first child link; before that this getter returns a shared empty set.
   */
  public get children(): ReadonlySet<Entity> {
    return this._children ?? Entity._emptyChildren;
  }

  /**
   * Typed event emitter for entity-level lifecycle events. Currently only the
   * `"destroy"` event is emitted, just before the entity is fully torn down.
   *
   * The emitter is created lazily on first access.
   */
  public get events(): EntityEvents {
    if (!this._events) {
      this._events = new Events();
    }
    return this._events;
  }

  /** `true` when no components are currently attached to this entity. */
  public get empty(): boolean {
    return this._components.size == 0;
  }

  /**
   * Read-only view of all components currently attached to this entity, keyed
   * by numeric component type id.
   *
   * The mutating methods (`set`, `delete`, `clear`) are not exposed. Use
   * `entity.add`, `entity.set`, and `entity.remove` to change the component
   * set.
   *
   * ```ts
   * entity.components.forEach((c) => console.log(c.constructor.name));
   * ```
   */
  public get components(): ReadonlyArrayMap<Component> {
    return this._components;
  }

  /**
   * Reparent this entity. In deferred mode the change is queued; outside
   * deferred mode it executes inline.
   *
   * @param newParent - New parent, or `undefined` to make this a root entity.
   */
  public setParent(newParent: Entity | undefined): void {
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.SetParent, entity: this, parent: newParent });
    } else {
      this._setParent(newParent);
    }
  }

  /**
   * Mark `c` as having changed, queueing the corresponding `onSet` / `update`
   * notifications.
   *
   * Equivalent to `c.modified()` but returns the entity for chaining. Repeated
   * calls before the world routes the modified command are coalesced via the
   * component's dirty flag.
   *
   * @param c - Component instance whose data changed.
   * @returns This entity, for chaining.
   */
  public modified<C extends typeof Component>(c: InstanceType<C>): Entity {
    if (c._dirty) {
      return this;
    }
    c._dirty = true;
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Modified, entity: this, type: c.type });
    } else {
      this._modified(c.type);
    }
    return this;
  }

  /**
   * Attach a component to this entity if it is not already present.
   *
   * Idempotent. Does not fire `onSet` — use {@link set} when you want to apply
   * data and notify watchers.
   *
   * @param Class - Component class to instantiate.
   * @returns This entity, for chaining.
   */
  public add<C extends typeof Component>(Class: C): Entity;

  /**
   * Attach a component by numeric type id.
   *
   * @param type - Numeric component type id.
   * @returns This entity, for chaining.
   */
  public add(type: number): Entity;

  public add(typeOrClass: number | typeof Component): Entity {
    const type = this.world.getComponentType(typeOrClass);
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Set, entity: this, type, props: undefined });
    } else {
      this._set(type, undefined);
    }
    return this;
  }

  /**
   * Attach a component (creating it if necessary), copy `props` onto the
   * instance, and fire the `onSet` hook plus any `update` callbacks for the
   * component type.
   *
   * In deferred mode `props` are not applied until the queued `Set` command is
   * routed.
   *
   * @param Class - Component class to instantiate.
   * @param props - Properties to assign onto the component instance.
   * @returns This entity, for chaining.
   */
  public set<C extends typeof Component>(Class: C, props: Partial<InstanceType<C>>): Entity;

  /**
   * Attach a component by numeric type id and copy `props` onto it.
   *
   * @param type - Numeric component type id.
   * @param props - Properties to assign onto the component instance.
   * @returns This entity, for chaining.
   */
  public set(type: number, props: Partial<Component>): Entity;

  public set(typeOrClass: number | typeof Component, props: Partial<Component>): Entity {
    const type = this.world.getComponentType(typeOrClass);
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Set, entity: this, type, props });
    } else {
      this._set(type, props);
    }
    return this;
  }

  /**
   * Detach a component from this entity.
   *
   * In deferred mode the removal is queued; `get(C)` continues to return the
   * component until the queue drains. When applied, queries fire `exit`
   * callbacks first and the `onRemove` hook fires last.
   *
   * @param Class - Component class to detach.
   */
  public remove<C extends typeof Component>(Class: C): void;

  /**
   * Detach a component by numeric type id.
   *
   * @param type - Numeric component type id.
   */
  public remove(type: number): void;

  public remove(typeOrClass: number | typeof Component): void {
    const type = this.world.getComponentType(typeOrClass);
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Remove, entity: this, type });
    } else {
      this._remove(type);
    }
  }

  /**
   * Look up a component on this entity.
   *
   * @param typeOrClass - Component class or numeric type id.
   * @returns The component instance, or `undefined` when it is not attached.
   */
  public get<C extends typeof Component>(typeOrClass: number | C): InstanceType<C> | undefined {
    const type = this.world.getComponentType(typeOrClass);
    return this._get(type) as InstanceType<C> | undefined;
  }

  /**
   * Destroy this entity and recursively destroy its children.
   *
   * Each component fires its `onRemove` hook, the `"destroy"` event is emitted
   * just before teardown, and the entity is unregistered from the world.
   * After destruction the entity must not be used.
   */
  public destroy(): void {
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Destroy, entity: this });
    } else {
      this._destroy();
    }
    if (this._children) {
      this._children.forEach((child) => {
        child.destroy();
      });
      this._children.clear();
    }
  }

  /** Returns `"EntityN"` where N is the entity id. */
  public toString(): string {
    return `Entity${this.eid}`;
  }
}
