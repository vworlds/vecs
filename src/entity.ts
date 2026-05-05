import { Component } from "./component.js";
import type { World } from "./world.js";
import { CommandKind } from "./command.js";
import { ArrayMap } from "./util/array_map.js";
import { type Query } from "./query.js";
import { Events } from "./util/events.js";
import { Bitset } from "./util/bitset.js";

type EntityEvents = Events<{ destroy(): void }>;

/**
 * A game object — a unique identifier with an arbitrary set of
 * {@link Component | components} attached to it.
 *
 * You never construct an `Entity` directly. Use {@link World.entity} to create
 * one, or {@link World.getOrCreateEntity} when the id is assigned by an
 * external authority (e.g. the server):
 *
 * ```ts
 * const e = world.entity();
 * e.set(Position, { x: 100 });
 * ```
 *
 * Entities support a parent–child hierarchy. When a parent is destroyed its
 * children are destroyed recursively. The `children` set is created lazily.
 *
 * ## Deferred semantics
 *
 * Inside a system body or `forEach` iteration the world is in **deferred
 * mode**: `add` / `set` / `remove` / `destroy` only enqueue commands; the
 * data layer (`components` map, `componentBitmask`) is not mutated until the
 * world processes the queue. Concretely, inside deferred mode:
 *
 * - `entity.get(C)` returns `undefined` after `entity.add(C)` (no instance yet).
 * - `entity.get(C)` returns the previous value after `entity.set(C, props)`.
 * - `entity.get(C)` still returns the component after `entity.remove(C)`.
 *
 * Outside deferred mode (top-level user code) the same calls execute inline —
 * mutations are visible immediately.
 */
export class Entity {
  private components = new ArrayMap<Component>(); //maps component types to Components

  /**
   * Bitmask representing the set of component types currently attached to this
   * entity. Used by the world to efficiently match entities against query
   * predicates.
   */
  public readonly componentBitmask = new Bitset();
  private readonly queries = new Set<Query>();

  /**
   * A free-form property bag that modules can use to associate arbitrary data
   * with an entity without registering a component.
   */
  public properties = new Map<string, any>();
  declare public _events: EntityEvents;

  private _parent: Entity | undefined;
  private _children: Set<Entity> | undefined;
  /** @internal True once the world has fully processed this entity's destruction. */
  public _destroyed: boolean = false;

  private static readonly _emptyChildren: ReadonlySet<Entity> = new Set();

  constructor(
    /** The {@link World} that owns this entity. */
    public readonly world: World,
    /** Unique numeric entity id assigned at creation time. */
    public readonly eid: number
  ) {}

  /** Parent entity in the scene hierarchy, or `undefined` if this is a root entity. */
  public get parent(): Entity | undefined {
    return this._parent;
  }

  /** Read-only view of direct child entities. */
  public get children(): ReadonlySet<Entity> {
    return this._children ?? Entity._emptyChildren;
  }

  /**
   * Immediately reparent this entity. Maintains the bidirectional link,
   * removes it from the old parent's children, and adds it to the new
   * parent's children. Throws if the operation would create a cycle.
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
   * Reparent this entity. In deferred mode the change is queued; outside
   * deferred mode it executes immediately.
   */
  public setParent(newParent: Entity | undefined): void {
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.SetParent, entity: this, parent: newParent });
    } else {
      this._setParent(newParent);
    }
  }

  /**
   * Queue an `onSet` / `update` notification for the given component and
   * return the entity for chaining.
   *
   * Equivalent to `component.modified()`, but usable inside an entity method
   * chain (e.g. after `add` or `set`).
   *
   * @param c - The component instance whose data changed.
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
   * Add a component of type `Class` to this entity if it isn't already
   * present, and return the entity for chaining.
   *
   * Does nothing if the component is already attached. `add` does not fire
   * `onSet` — use {@link set} when you want to apply data and notify.
   *
   * @param Class - The component class to instantiate.
   * @returns This entity, for chaining.
   */
  public add<C extends typeof Component>(Class: C): Entity;
  /**
   * Add a component by its numeric type id.
   *
   * @param type - Numeric component type id (as returned by
   *   {@link World.getComponentType}).
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
   * Add a component of type `Class` (if not already present), assign the
   * provided properties onto the instance, and return the entity for chaining.
   *
   * In deferred mode the props are not applied until the world processes the
   * resulting `Set` command.
   *
   * @param Class - The component class to instantiate.
   * @param props - Properties to assign onto the component instance.
   * @returns This entity, for chaining.
   */
  public set<C extends typeof Component>(Class: C, props: Partial<InstanceType<C>>): Entity;
  /**
   * Add a component by its numeric type id, assign the provided properties,
   * and return the entity for chaining.
   *
   * @param type - Numeric component type id.
   * @param props - Properties to assign onto the component instance.
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
   * Remove the component of the given class from this entity.
   *
   * In deferred mode the removal is queued — `get(Class)` continues to return
   * the component until the queue is processed. Once processed, queries fire
   * exit callbacks first, then the `onRemove` hook fires.
   *
   * @param Class - The component class to remove.
   */
  public remove<C extends typeof Component>(Class: C): void;
  /**
   * Remove a component by its numeric type id.
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

  /** @internal Look up a component instance by type id. */
  public _get(type: number): Component | undefined {
    return this.components.get(type);
  }

  /**
   * Retrieve the component of type `Class`, or `undefined` if not present.
   *
   * @param typeOrClass - Component class or numeric type id.
   * @returns The component instance or `undefined`.
   */
  public get<C extends typeof Component>(typeOrClass: number | C): InstanceType<C> | undefined {
    const type = this.world.getComponentType(typeOrClass);
    return this._get(type) as InstanceType<C> | undefined;
  }

  /**
   * Typed event emitter for entity-level lifecycle events.
   *
   * Currently emits one event:
   * - `"destroy"` — fired just before the entity is fully torn down.
   *
   * The emitter is created lazily on first access.
   */
  public get events(): EntityEvents {
    if (!this._events) {
      this._events = new Events();
    }
    return this._events;
  }

  public isInQuery(q: Query) {
    return this.queries.has(q);
  }

  /** @internal Removes a query from this entity's tracking sets without firing any callbacks. */
  public _purgeQuery(q: Query): void {
    this.queries.delete(q);
  }

  /** @internal Add a query to the entity's tracked-query set. Called by Query._enter. */
  public _addQueryMembership(q: Query) {
    this.queries.add(q);
  }

  /** @internal Remove a query from the entity's tracked-query set. Called by Query._exit. */
  public _removeQueryMembership(q: Query) {
    this.queries.delete(q);
  }

  private _updateQueries(): void {
    this.world.queries.forEach((q) => {
      const belongs = q.belongs(this);
      const isIn = this.isInQuery(q);
      if (belongs !== isIn) {
        belongs ? q._enter(this) : q._exit(this);
      }
    });
  }

  private _new(type: number, props: Partial<Component> | undefined): Component {
    const meta = this.world.getComponentMeta(type);
    if (meta.exclusive) {
      for (const exclusiveType of meta.exclusive) {
        if (this.components.has(exclusiveType)) {
          this._remove(exclusiveType);
        }
      }
    }
    const c = new meta.Class(this, meta);
    if (props !== undefined) {
      Object.assign(c, props);
    }
    this.components.set(type, c);
    this.componentBitmask.add(type);
    meta._onAddHandler?.(c);
    this._updateQueries();
    return c;
  }

  /** @internal Execute a Set command — create if absent, apply props, fire hooks, route events. */
  public _set(type: number, props: Partial<Component> | undefined): void {
    if (this._destroyed) {
      return;
    }
    const existing = this.components.get(type);
    const c = existing ?? this._new(type, props);
    if (props !== undefined) {
      if (existing) {
        Object.assign(c, props);
      }
      c.meta._onSetHandler?.(c);
      c._dirty = false;
      if (existing) {
        this.queries.forEach((q) => q.notifyModified(c));
      }
    }
  }

  /** @internal Execute a Modified command — fire onSet and route update events. */
  public _modified(type: number): void {
    if (this._destroyed) {
      return;
    }
    const c = this.components.get(type);
    if (!c) {
      return;
    }
    c.meta._onSetHandler?.(c);
    c._dirty = false;
    this.queries.forEach((q) => q.notifyModified(c));
  }

  /** @internal Execute a Remove command — clear bitmask, route exits, remove component, fire onRemove. */
  public _remove(type: number): void {
    if (this._destroyed) {
      return;
    }
    const c = this.components.get(type);
    if (!c) {
      return;
    }
    this.componentBitmask.delete(type);
    this._updateQueries();
    this.components.delete(type);
    c.meta._onRemoveHandler?.(c);
  }

  /** @internal Execute a Destroy command — exit queries, fire onRemove, emit event, unregister. */
  public _destroy(): void {
    if (this._destroyed) {
      return;
    }

    // 1. Fire exit on every query the entity belongs to.
    const toExit: Query[] = [];
    this.queries.forEach((q) => {
      if (q.world) {
        toExit.push(q);
      }
    });
    toExit.forEach((q) => q._exit(this));

    // 2. Fire onRemove on every still-attached component.
    this.components.forEach((c) => c.meta._onRemoveHandler?.(c));

    // 3. Emit the destroy event.
    if (this._events) {
      this._events.emit("destroy");
      this._events.removeAllListeners("destroy");
    }

    // 4. Mark destroyed and unhook from world / parent.
    this._destroyed = true;
    this.world._unregisterEntity(this);
    if (this._parent) {
      this._parent._children?.delete(this);
      this._parent = undefined;
    }
  }

  /** `true` when the entity has no components attached. */
  public get empty() {
    return this.components.size == 0;
  }

  /**
   * Destroy this entity and recursively destroy all of its children.
   *
   * All components have their `onRemove` hooks fired, the entity is
   * unregistered from the world, and the `"destroy"` event is emitted. The
   * entity must not be used after the destroy completes.
   */
  public destroy() {
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

  /**
   * Iterate over every component currently attached to this entity.
   *
   * @param callback - Called with each component instance. Iteration order is
   *   not guaranteed.
   */
  public forEachComponent(callback: (c: Component) => void) {
    this.components.forEach(callback);
  }

  /** Returns `"EntityN"` where N is the entity id. */
  public toString(): string {
    return `Entity${this.eid}`;
  }
}
