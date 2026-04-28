import { Component, ComponentMeta } from "./component.js";
import type { World } from "./world.js";
import { ArrayMap } from "./util/array_map.js";
import { type Query } from "./query.js";
import { Events } from "./util/events.js";
import { Bitset } from "./util/bitset.js";

type EntityEvents = Events<{ destroy(): void }>;

/**
 * A game object — a unique identifier with an arbitrary set of
 * {@link Component | components} attached to it.
 *
 * You never construct an `Entity` directly. Use {@link World.createEntity} for
 * locally-owned entities or {@link World.getOrCreateEntity} when the id is
 * assigned by an external authority (e.g. the server):
 *
 * ```ts
 * const e = world.createEntity();
 * const pos = e.add(Position);
 * pos.x = 100;
 * pos.modified();
 * ```
 *
 * Entities support a parent–child hierarchy. When a parent is destroyed its
 * children are destroyed recursively. The `children` set is created lazily.
 */
export class Entity {
  private components = new ArrayMap<Component>(); //maps component types to Components
  private deletedComponents = new ArrayMap<Component>(); //maps deleted component types to Components

  /**
   * Bitmask representing the set of component types currently attached to this
   * entity. Used by the world to efficiently match entities against query
   * predicates.
   */
  public readonly componentBitmask = new Bitset();
  private readonly queries = new Set<Query>();
  private readonly newQueries: Query[] = [];

  /**
   * A free-form property bag that modules can use to associate arbitrary data
   * with an entity without registering a component.
   */
  public properties = new Map<string, any>();
  public declare _events: EntityEvents;

  /** Parent entity in the scene hierarchy, or `undefined` if root. */
  public parent: Entity | undefined;
  /** @internal */
  public _children: Set<Entity> | undefined;
  public _archetypeChanged: boolean = false;
  private destroyed = false;

  constructor(
    /** The {@link World} that owns this entity. */
    public readonly world: World,
    /** Unique numeric entity id assigned at creation time. */
    public readonly eid: number
  ) {}

  /**
   * The set of direct child entities in the scene hierarchy.
   *
   * The set is created lazily on first access. Mutate it only through
   * {@link Entity.destroy} or by setting {@link Entity.parent} on a child —
   * both will keep the parent–child links consistent.
   */
  public get children(): Set<Entity> {
    if (!this._children) this._children = new Set<Entity>();
    return this._children;
  }

  private getComponentInstance(
    meta: ComponentMeta,
  ) {
    const c = new meta.Class(this, meta);
    const hook = meta._onAddHandler;
    if (hook) hook(c);
    return c;
  }

  /**
   * Add a component of type `Class` to this entity and return the instance.
   *
   * If the component is already present the existing instance is returned and
   * no callback is fired. Pass `markAsModified = false` to suppress the
   * initial `onSet` / `update` notification (useful when bulk-loading
   * network snapshots before systems are running).
   *
   * @param Class - The component class to instantiate.
   * @param markAsModified - Whether to immediately queue an `update`
   *   notification. Defaults to `true`.
   * @returns The new (or existing) component instance, typed as
   *   `InstanceType<Class>`.
   */
  public add<C extends typeof Component>(
    Class: C,
    markAsModified?: boolean
  ): InstanceType<C>;
  /**
   * Add a component by its numeric type id.
   *
   * @param type - Numeric component type id (as returned by
   *   {@link World.getComponentType}).
   * @param markAsModified - Whether to queue an update notification.
   */
  public add(type: number, markAsModified?: boolean): Component;
  public add(
    typeOrClass: number | typeof Component,
    markAsModified: boolean = true
  ) {
    const type = this.world.getComponentType(typeOrClass);

    let c = this.components.get(type);
    if (c) {
      return c;
    }

    const meta = this.world.getComponentMeta(typeOrClass);
    if (meta.exclusive) {
      for (const exclusiveType of meta.exclusive) {
        if (this.components.has(exclusiveType)) {
          this.remove(exclusiveType);
        }
      }
    }

    c = this.getComponentInstance(meta);

    this.components.set(type, c);
    this.componentBitmask.add(type);
    this.world._notifyComponentAdded(this, c);
    if (markAsModified) this.world._queueUpdatedComponent(c);

    return c;
  }

  /**
   * Add a component of type `Class` (if not already present) and assign the
   * provided properties onto the instance, then return it.
   *
   * @param Class - The component class to instantiate.
   * @param props - Optional properties to assign onto the component instance.
   * @returns The new (or existing) component instance with the given properties applied.
   */
  public set<C extends typeof Component>(
    Class: C,
    props: Partial<InstanceType<C>>
  ): InstanceType<C>;
  /**
   * Add a component by its numeric type id and assign the provided properties.
   *
   * @param type - Numeric component type id.
   * @param props - Optional properties to assign onto the component instance.
   */
  public set(type: number, props: Partial<Component>): Component;
  public set(
    typeOrClass: number | typeof Component,
    props: Partial<Component>
  ): Component {
    const c = this.add(typeOrClass as any, false);
    this.world._queueUpdatedComponent(c)
    return Object.assign(c, props);
  }

  /**
   * Remove the component of the given class from this entity.
   *
   * The `onRemove` hook and any `exit` callbacks on matching systems are
   * called when archetype changes are flushed at the end of the next system
   * run. Does nothing if the component is not present.
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
    const c = this.components.get(type);
    if (c) {
      this.components.delete(type);
      this.deletedComponents.set(type, c);
      this.componentBitmask.delete(type);
      this.world._notifyComponentRemoved(this, c);
    }
  }

  /** @internal Called by queries to deliver update notifications. */
  public _notifyModified(component: Component) {
    this.queries.forEach((q) => {
      q.notifyModified(component);
    });
  }

  /**
   * Retrieve the component of type `Class`, or `undefined` if not present.
   *
   * @param typeOrClass - Component class or numeric type id.
   * @param get_deleted - If `true`, also search components that were removed
   *   in the current frame but not yet garbage-collected. Useful inside
   *   `exit` callbacks to read final component values.
   * @returns The component instance or `undefined`.
   */
  public get<C extends typeof Component>(
    typeOrClass: number | C,
    get_deleted: boolean = false
  ): InstanceType<C> | undefined {
    const type = this.world.getComponentType(typeOrClass);

    const c = this.components.get(type);
    if (!c && get_deleted) {
      return this.deletedComponents.get(type) as InstanceType<C> | undefined;
    }
    return c as InstanceType<C> | undefined;
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

  /** @internal */
  public _hasQuery(q: Query) {
    return this.queries.has(q);
  }

  /** @internal Removes a query from this entity's tracking sets without firing any callbacks. */
  public _purgeQuery(q: Query): void {
    this.queries.delete(q);
    const idx = this.newQueries.indexOf(q);
    if (idx !== -1) this.newQueries.splice(idx, 1);
  }

  /** @internal */
  public _addQuery(q: Query) {
    if (!this.queries.has(q)) {
      this.newQueries.push(q);
      q._enter(this);
    }
  }

  /** @internal */
  public _removeQuery(q: Query) {
    if (this.queries.delete(q)) {
      q._exit(this);
    }
  }

  /** @internal */
  public _updateQueries() {
    this.newQueries.forEach((q) => {
      this.queries.add(q);
    });
    this.newQueries.length = 0;
  }

  /** `true` when the entity has no components attached. */
  public get empty() {
    return this.components.size == 0;
  }

  /** @internal */
  public _destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.queries.forEach((q) => {
      q._exit(this);
    });
    this.queries.clear();

    if (this._events) {
      this._events.emit("destroy");
      this._events.removeAllListeners("destroy");
    }
  }

  /**
   * Destroy this entity and recursively destroy all of its children.
   *
   * All components are removed (triggering `onRemove` hooks and `exit`
   * callbacks), the entity is unregistered from the world, and the `"destroy"`
   * event is emitted. The entity must not be used after calling this method.
   */
  public destroy() {
    this.world._notifyEntityDestroyed(this);
    this.children.forEach((child) => {
      child.destroy();
    });
    this.children.clear();
    if (this.parent) {
      this.parent.children.delete(this);
      this.world.archetypeChanged(this.parent);
      this.parent = undefined;
    }
  }

  /** @internal */
  public clearDeletedComponents() {
    this.deletedComponents.clear();
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
