import {
  ComponentMeta,
  type ComponentInstance,
  type ComponentClass,
  type ComponentRef,
  type ComponentType,
} from "../component_meta.js";
import type { World } from "../world/index.js";
import { CommandKind } from "../command.js";
import { ArrayMap, ReadonlyArrayMap } from "../util/array_map.js";
import { type Query } from "../query.js";
import { Events } from "../util/events.js";
import { Bitset } from "../util/bitset.js";
import { PartialClass } from "../util/partial.js";

type EntityEvents = Events<{ destroy(): void }>;

export type EntityClass<T extends Entity = Entity> = new (
  world: World,
  eid: number,
  ownComponentClass?: ComponentType
) => T;

/**
 * A game object: a unique numeric id with an arbitrary set of
 * {@link ComponentInstance | components} attached.
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
 * Entities support a parent-child hierarchy. `parent` and `children` form a
 * bidirectional link maintained by {@link setParent}; the children set is
 * created lazily. Destroying a parent recursively destroys its children.
 *
 * ## Deferred semantics
 *
 * Inside a system body or `forEach` iteration the world is in **deferred
 * mode**: `add` / `attach` / `set` / `modified` / `remove` / `destroy` /
 * `setParent` only enqueue commands. The data layer (the components map and
 * `componentBitmask`) is mutated when the world drains its queue. Concretely,
 * while deferred:
 *
 * - `entity.get(C)` / `entity.getMut(C)` returns `undefined` after `entity.add(C)` (no instance yet).
 * - `entity.get(C)` / `entity.getMut(C)` returns `undefined` after `entity.attach(instance)` if C was absent.
 * - `entity.get(C)` / `entity.getMut(C)` returns the previous value after `entity.set(C, props)`.
 * - `entity.get(C)` / `entity.getMut(C)` still returns the component after `entity.remove(C)`.
 *
 * Outside deferred mode the same calls execute inline and mutations are
 * visible immediately.
 */
export class Entity extends PartialClass {
  /** @internal Metadata for this entity when the entity itself is used as a component key. */
  protected _ownMeta: ComponentMeta | undefined;

  /** @internal Maps component eid to component instance. */
  private _components = new ArrayMap<ComponentInstance>();
  /** @internal Component eids with pending modified delivery. */
  private readonly _dirtyComponentBitmask = new Bitset();
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
    public readonly eid: number,
    ownComponentClass?: ComponentType
  ) {
    super();
    if (ownComponentClass !== undefined) {
      this._ownMeta = new ComponentMeta(ownComponentClass, eid);
    }
    this.initializePartials();
  }

  /** Fire every `onAdd` hook registered for `meta`. */
  private _runOnAddHandlers(meta: ComponentMeta, component: ComponentInstance): void {
    meta._onAddHandlers?.forEach((handler) => handler(this, component));
  }

  /** Fire every `onSet` hook registered for `meta`. */
  private _runOnSetHandlers(meta: ComponentMeta, component: ComponentInstance): void {
    meta._onSetHandlers?.forEach((handler) => handler(this, component));
  }

  /**
   * Re-evaluate queries that can be affected by `meta` for this entity,
   * firing `_enter` / `_exit` routing whenever membership flipped.
   */
  private _updateQueries(meta: ComponentMeta): void {
    this.world._forEachQueryForComponent(meta.eid, (q) => {
      const belongs = q.belongs(this);
      const isIn = this._queries.has(q);
      if (belongs !== isIn) {
        belongs ? q._enter(this) : q._exit(this);
      }
    });
  }

  /** Store a component instance and perform the shared add-side bookkeeping. */
  private _storeComponent(meta: ComponentMeta, instance: ComponentInstance, isAdd: boolean): void {
    if (meta._exclusive) {
      for (const exclusiveMeta of meta._exclusive) {
        if (this._components.has(exclusiveMeta.eid)) {
          this._remove(exclusiveMeta);
        }
      }
    }
    const existing = this._components.has(meta.eid);
    this._components.set(meta.eid, instance);
    this.componentBitmask.addBit(meta.bitPtr);
    if (!existing) {
      meta._incrementUsage();
    }
    if (isAdd && !existing) {
      this._runOnAddHandlers(meta, instance);
    }
    this._updateQueries(meta);
  }

  /** Perform the shared set-side hook and query update routing. */
  private _notifyComponentSet(
    meta: ComponentMeta,
    instance: ComponentInstance,
    isUpdate: boolean
  ): void {
    this._runOnSetHandlers(meta, instance);
    this._dirtyComponentBitmask.deleteBit(meta.bitPtr);
    if (isUpdate) {
      this._queries.forEach((q) => q._notifyModified(this, meta, instance));
    }
  }

  /**
   * Construct a fresh component of `type`, apply `props`, store it on this
   * entity, fire the `onAdd` hook, and route query updates.
   *
   * If the component type belongs to an exclusivity group, any conflicting
   * component already on this entity is removed first.
   */
  private _new(
    meta: ComponentMeta,
    props: Partial<ComponentInstance> | undefined
  ): ComponentInstance {
    const c = new (meta.Class as ComponentClass)();
    if (props !== undefined) {
      Object.assign(c, props);
    }
    this._storeComponent(meta, c, true);
    return c;
  }

  /**
   * @internal Record that this entity is now tracked by `q`. Called by
   * `Query._enter`.
   */
  public _addQueryMembership(q: Query): void {
    this._queries.add(q);
  }

  /**
   * @internal Apply an `Attach` command: store the provided component instance,
   * replacing any previous instance for this type. Events are fired as if the
   * caller had performed a `set` operation.
   */
  public _attach(meta: ComponentMeta, component: ComponentInstance): void {
    if (this._destroyed) {
      return;
    }
    const existing = this._components.get(meta.eid);
    this._storeComponent(meta, component, existing === undefined);
    this._notifyComponentSet(meta, component, existing !== undefined);
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
    const ownMeta = this._ownMeta;
    if (ownMeta && ownMeta.usageCount > (this._components.has(ownMeta.eid) ? 1 : 0)) {
      throw new Error(`Cannot destroy entity ${this.eid}; component eid is still in use`);
    }
    this._destroyed = true;

    const toExit: Query[] = [];
    this._queries.forEach((q) => {
      if (q.world) {
        toExit.push(q);
      }
    });
    toExit.forEach((q) => q._exit(this));

    this._components.forEach((c, eid) => {
      const meta = this.world.entity(eid).ownMeta;
      meta._decrementUsage();
      const removeHandlers = meta._onRemoveHandlers;
      if (removeHandlers) {
        removeHandlers.forEach((handler) => handler(this, c));
      }
    });
    this._dirtyComponentBitmask.clear();

    if (this._events) {
      this._events.emit("destroy");
      this._events.removeAllListeners("destroy");
    }

    if (ownMeta && ownMeta.usageCount === 0 && ownMeta.Class !== Object) {
      delete (ownMeta.Class as any)[this.world.worldKey];
    }

    this.world._unregisterEntity(this);
    if (this._parent) {
      this._parent._children?.delete(this);
      this._parent = undefined;
    }
  }

  /**
   * @internal Look up a component instance by component eid.
   *
   * Faster than {@link get} because no class to type id resolution is needed.
   */
  public _get(eid: number): ComponentInstance | undefined {
    return this._components.get(eid);
  }

  /**
   * @internal Return `true` when this entity is currently tracked by `q`.
   */
  public _isInQuery(q: Query): boolean {
    return this._queries.has(q);
  }

  /**
   * @internal Apply a `Modified` command: fire `onSet` and route modified
   * events to every query that watches the component type.
   */
  public _modified(meta: ComponentMeta): void {
    if (this._destroyed) {
      return;
    }
    const c = this._components.get(meta.eid);
    if (!c) {
      return;
    }
    this._notifyComponentSet(meta, c, true);
  }

  /**
   * @internal Forget query `q` without firing exit callbacks. Called by
   * {@link World} when a {@link Query.destroy} sweeps every entity.
   */
  public _purgeQuery(q: Query): void {
    this._queries.delete(q);
  }

  /**
   * @internal Apply a `Remove` command: clear the type bit, route exits,
   * detach the component, and fire `onRemove`.
   */
  public _remove(meta: ComponentMeta): void {
    if (this._destroyed) {
      return;
    }
    const c = this._components.get(meta.eid);
    if (!c) {
      return;
    }
    this._dirtyComponentBitmask.deleteBit(meta.bitPtr);
    this.componentBitmask.deleteBit(meta.bitPtr);
    this._updateQueries(meta);
    this._components.delete(meta.eid);
    meta._decrementUsage();
    const removeHandlers = meta._onRemoveHandlers;
    if (removeHandlers) {
      removeHandlers.forEach((handler) => handler(this, c));
    }
  }

  /**
   * @internal Record that this entity is no longer tracked by `q`. Called by
   * `Query._exit`.
   */
  public _removeQueryMembership(q: Query): void {
    this._queries.delete(q);
  }

  /**
   * @internal Apply a `Set` command: create the component if missing, assign
   * `props` if provided, fire `onSet`, and route modified events to every
   * query that watches the component type.
   */
  public _set(meta: ComponentMeta, props: Partial<ComponentInstance> | undefined): void {
    if (this._destroyed) {
      return;
    }
    const existing = this._components.get(meta.eid);
    const c = existing ?? this._new(meta, props);
    if (props !== undefined) {
      if (existing) {
        Object.assign(c, props);
      }
      this._notifyComponentSet(meta, c, existing !== undefined);
    }
  }

  /**
   * @internal Reparent this entity in place, maintaining the bidirectional
   * link. Throws if `newParent` is a descendant of this entity.
   *
   * Called by the world either inline (outside deferred mode) or while
   * routing a queued `SetParent` command.
   */
  public _setParent(newParent: Entity | undefined): void {
    if (this._destroyed) {
      return;
    }
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
   * Read-only view of direct child entities. The backing set is created lazily
   * on the first child link; before that this getter returns a shared empty set.
   */
  public get children(): ReadonlySet<Entity> {
    return this._children ?? Entity._emptyChildren;
  }

  /**
   * Read-only view of all components currently attached to this entity, keyed
   * by numeric component type id.
   *
   * The mutating methods (`set`, `delete`, `clear`) are not exposed. Use
   * `entity.add`, `entity.attach`, `entity.set`, and `entity.remove` to change
   * the component set.
   *
   * ```ts
   * entity.components.forEach((c) => console.log(c.constructor.name));
   * ```
   */
  public get components(): ReadonlyArrayMap<ComponentInstance> {
    return this._components;
  }

  /** `true` when no components are currently attached to this entity. */
  public get empty(): boolean {
    return this._components.size == 0;
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

  /** Parent entity in the scene hierarchy, or `undefined` for a root entity. */
  public get parent(): Entity | undefined {
    return this._parent;
  }

  /** Metadata for using this entity's eid as a component key. Created lazily for plain entities. */
  public get ownMeta(): ComponentMeta {
    return (this._ownMeta ??= new ComponentMeta(Object, this.eid));
  }

  /** Number of live component instances currently attached for this entity's component key. */
  public instanceCount(): number {
    return this._ownMeta?.usageCount ?? 0;
  }

  /**
   * Attach a component to this entity if it is not already present.
   *
   * Idempotent. Does not fire `onSet` -- use {@link set} when you want to apply
   * data and notify watchers.
   *
   * @param Class - Component class to instantiate.
   * @returns This entity, for chaining.
   */
  public add<C extends ComponentClass>(Class: C): this;

  /**
   * Attach a component by numeric type id.
   *
   * @param type - Numeric component type id.
   * @returns This entity, for chaining.
   */
  public add(eid: number): this;

  public add(entity: Entity): this;

  public add(ref: ComponentRef): this {
    const meta = this.world.entity(ref).ownMeta;
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Set, entity: this, meta, props: undefined });
    } else {
      this._set(meta, undefined);
    }
    return this;
  }

  /**
   * Attach an existing component instance to this entity and store that exact
   * object. If a component of the same registered class already exists, it is
   * replaced rather than assigned into.
   *
   * By default `attach` uses the instance constructor to resolve component
   * metadata. Pass an explicit class when the instance should be stored under
   * a base component key. The constructor must already be registered in this
   * world. The operation fires hooks and query updates like a `set` operation.
   *
   * @param component - Existing component instance to store on the entity.
   * @returns This entity, for chaining.
   */
  public attach(component: ComponentInstance): this;

  public attach<C extends ComponentInstance>(Class: ComponentType<C>, component: C): this;

  public attach<C extends ComponentInstance>(
    classOrComponent: ComponentType<C> | ComponentInstance,
    component?: C
  ): this {
    const ComponentKey = component === undefined ? classOrComponent.constructor : classOrComponent;
    const instance = component ?? classOrComponent;
    const meta = this.world.entity(ComponentKey as ComponentRef).ownMeta;
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Attach, entity: this, meta, component: instance });
    } else {
      this._attach(meta, instance);
    }
    return this;
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

  /**
   * Look up a component on this entity as a readonly value.
   *
   * @param typeOrClass - Component class or numeric type id.
   * @returns The component instance, or `undefined` when it is not attached.
   */
  public get<C extends ComponentType>(Class: C): Readonly<InstanceType<C>> | undefined;

  /** Look up a component by numeric type id as a readonly value. */
  public get(eid: number): Readonly<ComponentInstance> | undefined;

  public get(entity: Entity): Readonly<ComponentInstance> | undefined;

  public get(ref: ComponentRef): Readonly<ComponentInstance> | undefined {
    const eid = this.world.entity(ref).eid;
    return this._get(eid);
  }

  /**
   * Look up a component on this entity for mutation.
   *
   * When the component is present, this marks the component modified before
   * returning the mutable instance.
   *
   * @param typeOrClass - Component class or numeric type id.
   * @returns The component instance, or `undefined` when it is not attached.
   */
  public getMut<C extends ComponentType>(Class: C): InstanceType<C> | undefined;

  /** Look up a component by numeric type id for mutation. */
  public getMut(eid: number): ComponentInstance | undefined;

  public getMut(entity: Entity): ComponentInstance | undefined;

  public getMut(ref: ComponentRef): ComponentInstance | undefined {
    const eid = this.world.entity(ref).eid;
    const component = this._get(eid);
    if (component) {
      this.modified(ref);
    }
    return component;
  }

  /**
   * Mark a component type as having changed, queueing the corresponding `onSet` / `update`
   * notifications.
   *
   * Repeated calls before the world routes the modified command are coalesced via
   * the entity's dirty component bitset.
   *
   * @param typeOrClass - Component class or numeric type id whose data changed.
   * @returns This entity, for chaining.
   */
  public modified(ref: ComponentRef): this {
    const meta = this.world.entity(ref).ownMeta;
    if (this._dirtyComponentBitmask.hasBit(meta.bitPtr)) {
      return this;
    }
    this._dirtyComponentBitmask.addBit(meta.bitPtr);
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Modified, entity: this, meta });
    } else {
      this._modified(meta);
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
  public remove<C extends ComponentType>(Class: C): void;

  /**
   * Detach a component by numeric type id.
   *
   * @param type - Numeric component type id.
   */
  public remove(eid: number): void;

  public remove(entity: Entity): void;

  public remove(ref: ComponentRef): void {
    const meta = this.world.entity(ref).ownMeta;
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Remove, entity: this, meta });
    } else {
      this._remove(meta);
    }
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
  public set<C extends ComponentClass>(Class: C, props: Partial<InstanceType<C>>): this;

  /**
   * Attach a component by numeric type id and copy `props` onto it.
   *
   * @param type - Numeric component type id.
   * @param props - Properties to assign onto the component instance.
   * @returns This entity, for chaining.
   */
  public set(eid: number, props: Partial<ComponentInstance>): this;

  public set(entity: Entity, props: Partial<ComponentInstance>): this;

  public set(ref: ComponentRef, props: Partial<ComponentInstance>): this {
    const meta = this.world.entity(ref).ownMeta;
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Set, entity: this, meta, props });
    } else {
      this._set(meta, props);
    }
    return this;
  }

  /** Returns `"EntityN"` where N is the entity id. */
  public override toString(): string {
    return `Entity${this.eid}`;
  }
}
