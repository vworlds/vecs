import { CommandKind } from "../command.js";
import {
  ComponentMeta,
  type ComponentClass,
  type ComponentInstance,
  type ComponentRef,
  type ComponentType,
} from "../component_meta.js";
import { Relationship } from "../component_meta.js";
import type { Query } from "../query/index.js";
import { Relationships } from "./entity.relationships.js";
import type { EID, Entity } from "./entity.js";

export class Components extends Relationships {
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
    const oldTarget = meta.isRelationship
      ? (existing as Relationship | undefined)?.target
      : undefined;
    const preMembers = existing === undefined ? this._snapshotUpdateMembers() : undefined;
    this._storeComponent(meta, component, existing === undefined);
    this._updateIncoming(meta, oldTarget, (component as Relationship).target);
    if (existing === undefined) {
      this._notifyComponentSet(meta, component, false, preMembers);
    } else {
      this._notifyComponentSet(meta, component, true);
    }
  }

  /**
   * @internal Look up a component instance by component eid.
   *
   * Faster than {@link get} because no class to type id resolution is needed.
   */
  public _get(ceid: EID): ComponentInstance | undefined {
    return this._components.get(ceid);
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
    if (meta._implementsClosure) {
      for (const aliasMeta of meta._implementsClosure) {
        if (this._components.get(aliasMeta.eid) === c) {
          this._removeRaw(aliasMeta, c);
        }
      }
    }
    this._removeRaw(meta, c);
  }

  /** @internal Apply one remove without expanding interface aliases. */
  protected _removeRaw(meta: ComponentMeta, c: ComponentInstance): void {
    if (meta.isRelationship) {
      this._removeIncoming((c as Relationship).target, meta.eid);
    }
    this._dirtyComponentBitmask.deleteBit(meta.bitPtr);
    this.componentBitmask.deleteBit(meta.bitPtr);
    this.world._notifyComponentRemoved(meta.eid, this as unknown as Entity);
    this._components.delete(meta.eid);
    this.world._notifyComponentChanged(meta.eid, this as unknown as Entity);
    meta._decrementUsage();
    const removeHandlers = meta._onRemoveHandlers;
    if (removeHandlers) {
      removeHandlers.forEach((handler) => handler(this as unknown as Entity, c));
    }
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
    if (existing !== undefined && props === undefined) {
      return;
    }
    const oldTarget = meta.isRelationship
      ? (existing as Relationship | undefined)?.target
      : undefined;
    if (existing !== undefined) {
      Object.assign(existing, props);
      this._updateIncoming(meta, oldTarget, (existing as Relationship).target);
      this._notifyComponentSet(meta, existing, true);
      return;
    }
    const preMembers = props !== undefined ? this._snapshotUpdateMembers() : undefined;
    const c = this._new(meta, props);
    if (props !== undefined) {
      this._updateIncoming(meta, oldTarget, (c as Relationship).target);
      this._notifyComponentSet(meta, c, false, preMembers);
    }
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
  public add(ceid: EID): this;

  public add(entity: Entity): this;

  public add(ref: ComponentRef): this {
    const componentMeta = this.world.entity(ref).meta;
    this._throwIfInterface(componentMeta, "add");
    if (this.world.deferred) {
      this.world._enqueue({
        kind: CommandKind.Set,
        entity: this as unknown as Entity,
        meta: componentMeta,
        props: undefined,
      });
    } else {
      this._set(componentMeta, undefined);
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
    const componentMeta = this.world.entity(ComponentKey as ComponentRef).meta;
    this._throwIfInterface(componentMeta, "attach");
    if (this.world.deferred) {
      this.world._enqueue({
        kind: CommandKind.Attach,
        entity: this as unknown as Entity,
        meta: componentMeta,
        component: instance,
      });
    } else {
      this._attach(componentMeta, instance);
    }
    return this;
  }

  /**
   * Look up a component on this entity as a readonly value.
   *
   * @param typeOrClass - Component class or numeric type id.
   * @returns The component instance, or `undefined` when it is not attached.
   */
  public get<C extends ComponentType>(Class: C): Readonly<InstanceType<C>> | undefined;

  /** Look up a component by numeric type id as a readonly value. */
  public get(ceid: EID): Readonly<ComponentInstance> | undefined;

  public get(entity: Entity): Readonly<ComponentInstance> | undefined;

  public get(ref: ComponentRef): Readonly<ComponentInstance> | undefined {
    const ceid = typeof ref === "number" ? ref : this.world.entity(ref).eid;
    return this._get(ceid);
  }

  /**
   * Return `true` when this entity has the referenced component attached.
   *
   * @param ref - Component class, numeric component type id, or entity component key.
   */
  public has(ref: ComponentRef): boolean {
    const ceid = typeof ref === "number" ? ref : this.world.entity(ref).eid;
    return this.componentBitmask.has(ceid);
  }

  /**
   * Look up a component on this entity for mutation in deferred mode.
   *
   * When the component is present, this marks the component modified before
   * returning the mutable instance. Outside deferred mode, pass a callback so
   * the component can be marked modified after the mutation callback returns.
   *
   * @param typeOrClass - Component class or numeric type id.
   * @returns The component instance, or `undefined` when it is not attached.
   */
  public getMut<C extends ComponentType>(Class: C): InstanceType<C> | undefined;

  /** Look up a component, mutate it in `callback`, then mark it modified. */
  public getMut<C extends ComponentType>(
    Class: C,
    callback: (component: InstanceType<C>) => void
  ): Readonly<InstanceType<C>> | undefined;

  /** Look up a component by numeric type id for mutation. */
  public getMut(ceid: EID): ComponentInstance | undefined;

  /** Look up a component by numeric type id, mutate it in `callback`, then mark it modified. */
  public getMut(
    ceid: EID,
    callback: (component: ComponentInstance) => void
  ): Readonly<ComponentInstance> | undefined;

  public getMut(entity: Entity): ComponentInstance | undefined;

  public getMut(
    entity: Entity,
    callback: (component: ComponentInstance) => void
  ): Readonly<ComponentInstance> | undefined;

  public getMut(
    ref: ComponentRef,
    callback?: (component: ComponentInstance) => void
  ): ComponentInstance | undefined {
    if (callback === undefined && !this.world.deferred) {
      throw new Error("Entity.getMut without a callback is only allowed in deferred mode");
    }
    const componentMeta = this.world.entity(ref).meta;
    if (componentMeta.isRelationship) {
      throw new Error("Entity.getMut cannot mutate Relationship components; retarget with set");
    }
    this._throwIfInterface(componentMeta, "getMut");
    const component = this._get(componentMeta.eid);
    if (!component) {
      return undefined;
    }
    callback?.(component);
    this._markModified(componentMeta);
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
    const componentMeta = this.world.entity(ref).meta;
    this._throwIfInterface(componentMeta, "modify");
    return this._markModified(componentMeta);
  }

  /** @internal Mark a component changed, coalescing duplicate pending notifications. */
  protected _markModified(meta: ComponentMeta): this {
    this._throwIfInterface(meta, "modify");
    if (this._dirtyComponentBitmask.hasBit(meta.bitPtr)) {
      return this;
    }
    this._dirtyComponentBitmask.addBit(meta.bitPtr);
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Modified, entity: this as unknown as Entity, meta });
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
  public remove(ceid: EID): void;

  public remove(entity: Entity): void;

  public remove(ref: ComponentRef): void {
    const componentMeta = this.world.entity(ref).meta;
    this._throwIfInterface(componentMeta, "remove");
    if (this.world.deferred) {
      this.world._enqueue({
        kind: CommandKind.Remove,
        entity: this as unknown as Entity,
        meta: componentMeta,
      });
    } else {
      this._remove(componentMeta);
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
  public set(ceid: EID, props: Partial<ComponentInstance>): this;

  public set(entity: Entity, props: Partial<ComponentInstance>): this;

  public set(ref: ComponentRef, props: Partial<ComponentInstance>): this {
    const componentMeta = this.world.entity(ref).meta;
    this._throwIfInterface(componentMeta, "set");
    if (this.world.deferred) {
      this.world._enqueue({
        kind: CommandKind.Set,
        entity: this as unknown as Entity,
        meta: componentMeta,
        props,
      });
    } else {
      this._set(componentMeta, props);
    }
    return this;
  }

  /**
   * @internal
   *
   * Construct a fresh component of `type`, apply `props`, store it on this
   * entity, fire the `onAdd` hook, and route query updates.
   *
   * If the component type belongs to an exclusivity group, any conflicting
   * component already on this entity is removed first.
   */
  protected _new(
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
   * @internal Perform the shared set-side hook and query update routing.
   *
   * When `isUpdate` is `true` (an already-existing component was set, attached,
   * or marked modified), every query currently watching this entity is
   * notified and the term graph is woken via `_notifyComponentChanged`.
   *
   * When `isUpdate` is `false` (a first-time set/attach that just stored a
   * brand-new component), `preMembers` is the snapshot of update-watching
   * queries taken before the store ran. Only queries that were members both
   * before and after the store are notified -- entry-replay already covers
   * queries the store itself caused the entity to join, and queries the store
   * caused the entity to leave must not fire for this update.
   */
  protected _notifyComponentSet(
    meta: ComponentMeta,
    instance: ComponentInstance,
    isUpdate: boolean,
    preMembers?: readonly Query[]
  ): void {
    this._notifyRaw(meta, instance, isUpdate, preMembers);
    if (meta._implementsClosure) {
      for (const aliasMeta of meta._implementsClosure) {
        this._notifyRaw(aliasMeta, instance, isUpdate, preMembers);
      }
    }
  }

  /** @internal Perform one set-side hook and query update without expanding aliases. */
  protected _notifyRaw(
    meta: ComponentMeta,
    instance: ComponentInstance,
    isUpdate: boolean,
    preMembers?: readonly Query[]
  ): void {
    meta._onSetHandlers?.forEach((handler) => handler(this as unknown as Entity, instance));
    this._dirtyComponentBitmask.deleteBit(meta.bitPtr);
    if (isUpdate) {
      this.world._notifyComponentChanged(meta.eid, this as unknown as Entity);
      this._queries.forEach((q) =>
        q._notifyModified(this as unknown as Entity, meta.eid, instance)
      );
    } else if (preMembers) {
      for (const q of preMembers) {
        if (this._queries.has(q)) {
          q._notifyModified(this as unknown as Entity, meta.eid, instance);
        }
      }
    }
  }

  /** @internal Store a component instance and perform the shared add-side bookkeeping. */
  protected _storeComponent(
    meta: ComponentMeta,
    instance: ComponentInstance,
    isAdd: boolean
  ): void {
    if (meta._exclusive) {
      for (const exclusiveMeta of meta._exclusive) {
        if (this._components.has(exclusiveMeta.eid)) {
          this._remove(exclusiveMeta);
        }
      }
    }
    if (meta._implementsClosure) {
      for (const aliasMeta of meta._implementsClosure) {
        const prev = this._components.get(aliasMeta.eid);
        if (prev !== undefined && prev !== instance) {
          const concreteMeta = this.world.entity((prev as any).constructor).meta;
          this._remove(concreteMeta);
        }
      }
    }
    this._storeRaw(meta, instance, isAdd);
    if (meta._implementsClosure) {
      for (const aliasMeta of meta._implementsClosure) {
        this._storeRaw(aliasMeta, instance, isAdd);
      }
    }
  }

  /** @internal Store one component eid without expanding interface aliases. */
  protected _storeRaw(meta: ComponentMeta, instance: ComponentInstance, isAdd: boolean): void {
    const existing = this._components.has(meta.eid);
    this._components.set(meta.eid, instance);
    this.componentBitmask.addBit(meta.bitPtr);
    if (!existing) {
      meta._incrementUsage();
    }
    if (isAdd && !existing) {
      meta._onAddHandlers?.forEach((handler) => handler(this as unknown as Entity, instance));
    }
    if (!existing) {
      this.world._notifyComponentAdded(meta.eid, this as unknown as Entity);
    }
  }

  /**
   * @internal Snapshot the update-watching queries this entity currently
   * belongs to, for replay after a first-time set/attach store. Returns
   * `undefined` when there is nothing to snapshot.
   */
  private _snapshotUpdateMembers(): readonly Query[] | undefined {
    return this._queries.size > 0 ? [...this._queries] : undefined;
  }

  private _throwIfInterface(meta: ComponentMeta, op: string): void {
    if (meta._isInterface) {
      throw new Error(
        `Cannot ${op} the abstract interface ${meta.Class.name}; operate via the concrete component`
      );
    }
  }

  public onAdd(handler: (entity: Entity, c: ComponentInstance) => void): this {
    this.meta.onAdd(handler);
    return this;
  }

  public onRemove(handler: (entity: Entity, c: ComponentInstance) => void): this {
    this.meta.onRemove(handler);
    return this;
  }

  public onSet(handler: (entity: Entity, c: ComponentInstance) => void): this {
    this.meta.onSet(handler);
    return this;
  }
}
