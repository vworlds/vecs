import { CommandKind } from "../command.js";
import {
  ComponentMeta,
  _slotHandlers,
  type ComponentClass,
  type ComponentInstance,
  type ComponentRef,
  type ComponentType,
  type HookEvent,
  type HookEventMap,
} from "../component_meta.js";
import { Relationship } from "../component_meta.js";
import { Relationships } from "./entity.relationships.js";
import type { EID, Entity } from "./entity.js";

export class Components extends Relationships {
  /**
   * @internal Apply an `Attach` command: store the provided component instance,
   * replacing any previous instance for this type. Events are fired as if the
   * caller had performed a `set` operation.
   */
  public _attach(this: Entity, meta: ComponentMeta, component: ComponentInstance): void {
    if (meta._pendingEnsures?.get(this) === component) {
      meta._pendingEnsures.delete(this);
    }
    if (this._destroyed) {
      return;
    }
    if (meta.isRelationship) {
      throw new Error("Entity.attach cannot attach Relationship components; add explicit targets");
    }
    const existing = this._components.get(meta.eid);
    if (existing !== undefined && existing !== component) {
      meta._onPolicyRemove?.(this, existing);
    }
    this._storeComponent(meta, component, existing === undefined);
    if (existing !== undefined && existing !== component) {
      meta._onPolicyAdd?.(this, component);
    }
    this._notifyComponentSet(meta, component, existing !== undefined);
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
  public _modified(this: Entity, meta: ComponentMeta): void {
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
  public _remove(this: Entity, meta: ComponentMeta): void {
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
  protected _removeRaw(this: Entity, meta: ComponentMeta, c: ComponentInstance): void {
    if (meta.isRelationship) {
      this._detachRelationship(meta, c as Relationship);
      return;
    }
    this._dirtyComponentBitmask.deleteBit(meta.bitPtr);
    this.componentBitmask.deleteBit(meta.bitPtr);
    this.world._notifyComponentRemoved(meta.eid, this);
    this._components.delete(meta.eid);
    this.world._notifyComponentChanged(meta.eid, this);
    meta._detachCarrier(this);
    meta._onPolicyRemove?.(this, c);
    meta._onRemove?.(this, c);
  }

  /**
   * @internal Apply a `Set` command: create the component if missing, assign
   * `props` if provided, fire `onSet`, and route modified events to every
   * query that watches the component type.
   */
  public _set(
    this: Entity,
    meta: ComponentMeta,
    props: Partial<ComponentInstance> | undefined
  ): void {
    if (this._destroyed) {
      return;
    }

    if (meta.isRelationship) {
      const relationship = this._components.get(meta.eid) as Relationship | undefined;
      if (!relationship || props === undefined) {
        return;
      }
      if (this._assignRelationshipProps(relationship, props)) {
        this._notifyComponentSet(meta, relationship, true);
      }
      return;
    }

    const existing = this._components.get(meta.eid);
    const c = existing ?? this._materialize(meta, props);
    if (props !== undefined) {
      if (existing) {
        Object.assign(c, props);
      }
      this._notifyComponentSet(meta, c, existing !== undefined);
    }
  }

  /**
   * Attach a component to this entity if it is not already present.
   *
   * Idempotent. Does not fire `onSet` -- use {@link set} when you want to apply
   * data and notify watchers.
   *
   * Relationship components require an explicit `target`. The target is
   * resolved eagerly via {@link World.entity}: any {@link ComponentRef} that
   * resolves to an existing entity is accepted, but a ref that does not yet
   * resolve throws. Non-relationship components ignore `target` and throw when
   * one is supplied.
   *
   * @param Class - Component class to instantiate.
   * @param target - Relationship target. Any {@link ComponentRef} that resolves
   *   to an existing entity; required for {@link Relationship} components.
   * @returns This entity, for chaining.
   */
  public add<C extends ComponentClass>(
    Class: C,
    ...target: InstanceType<C> extends Relationship ? [target: ComponentRef] : []
  ): this;

  /**
   * Attach a component by numeric type id.
   *
   * @param type - Numeric component type id.
   * @param target - Relationship target; any {@link ComponentRef} that resolves
   *   to an existing entity. Ignored for non-relationship components.
   * @returns This entity, for chaining.
   */
  public add(ceid: EID, target?: ComponentRef): this;

  public add(entity: Entity, target?: ComponentRef): this;

  public add(this: Entity, ref: ComponentRef, target?: ComponentRef): this {
    const componentMeta = this.world.entity(ref).meta;
    this._throwIfInterface(componentMeta, "add");
    if (componentMeta.isRelationship) {
      if (target === undefined) {
        throw new Error("Entity.add requires a target for Relationship components");
      }
      const targetEntity = this.world.entity(target);
      if (this.world.deferred) {
        this.world._enqueue({
          kind: CommandKind.AddTarget,
          entity: this,
          meta: componentMeta,
          target: targetEntity,
        });
      } else {
        this._addTarget(componentMeta, targetEntity);
      }
      return this as unknown as this;
    }
    if (target !== undefined) {
      throw new Error("Entity.add target argument requires a Relationship component");
    }
    if (this.world.deferred) {
      this.world._enqueue({
        kind: CommandKind.Set,
        entity: this,
        meta: componentMeta,
        props: undefined,
      });
    } else {
      this._set(componentMeta, undefined);
    }
    return this as unknown as this;
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
    this: Entity,
    classOrComponent: ComponentType<C> | ComponentInstance,
    component?: C
  ): this {
    const ComponentKey = component === undefined ? classOrComponent.constructor : classOrComponent;
    const instance = component ?? classOrComponent;
    const componentMeta = this.world.entity(ComponentKey as ComponentRef).meta;
    this._throwIfInterface(componentMeta, "attach");
    if (componentMeta.isRelationship) {
      throw new Error("Entity.attach cannot attach Relationship components; add explicit targets");
    }
    this._attach_or_enqueue(componentMeta, instance);
    return this as unknown as this;
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
    this: Entity,
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
   * Look up a component for mutation, creating and attaching it when missing.
   *
   * Outside deferred mode, pass a callback so creation/modified notifications
   * fire after the mutation callback returns. Inside deferred mode, the callback
   * is optional and the returned component may be mutated before the queue drains.
   * Repeated calls before that drain return the same pending component instance.
   *
   * On a destroyed entity, skips the callback and notifications and returns the
   * existing instance or a fresh default instance that is never stored or pending.
   * This drop applies with or without a callback, even outside deferred mode,
   * before the live-entity relationship and interface checks.
   *
   * @param typeOrClass - Component class or numeric type id.
   * @returns The mutable component instance.
   */
  public ensure<C extends ComponentType>(Class: C): InstanceType<C>;

  /** Look up or create a component, mutate it in `callback`, then notify watchers. */
  public ensure<C extends ComponentType>(
    Class: C,
    callback: (component: InstanceType<C>) => void
  ): Readonly<InstanceType<C>>;

  /** Look up or create a component by numeric type id for mutation. */
  public ensure(ceid: EID): ComponentInstance;

  /** Look up or create a component by numeric type id, mutate it in `callback`, then notify watchers. */
  public ensure(
    ceid: EID,
    callback: (component: ComponentInstance) => void
  ): Readonly<ComponentInstance>;

  public ensure(entity: Entity): ComponentInstance;

  public ensure(
    entity: Entity,
    callback: (component: ComponentInstance) => void
  ): Readonly<ComponentInstance>;

  public ensure(
    this: Entity,
    ref: ComponentRef,
    callback?: (component: ComponentInstance) => void
  ): ComponentInstance {
    if (this._destroyed) {
      const componentMeta = this.world.entity(ref).meta;
      return this._get(componentMeta.eid) ?? new (componentMeta.Class as ComponentClass)();
    }
    if (callback === undefined && !this.world.deferred) {
      throw new Error("Entity.ensure without a callback is only allowed in deferred mode");
    }
    const componentMeta = this.world.entity(ref).meta;
    if (componentMeta.isRelationship) {
      throw new Error("Entity.ensure cannot mutate Relationship components; retarget with set");
    }
    this._throwIfInterface(componentMeta, "ensure");
    const existing = this._get(componentMeta.eid);
    if (existing) {
      callback?.(existing);
      this._markModified(componentMeta);
      return existing;
    }
    return this._ensureMissingInstance(componentMeta, callback);
  }

  /** @internal Return a pending instance, or create and attach one. The caller checked storage. */
  protected _ensureMissingInstance(
    this: Entity,
    componentMeta: ComponentMeta,
    callback?: (component: ComponentInstance) => void,
    initializePending = true
  ): ComponentInstance {
    const pending = componentMeta._pendingEnsures?.get(this);
    if (pending) {
      if (initializePending) {
        callback?.(pending);
      }
      return pending;
    }
    const component = new (componentMeta.Class as ComponentClass)();
    callback?.(component);
    if (this.world.deferred) {
      (componentMeta._pendingEnsures ??= new WeakMap()).set(this, component);
    }
    this._attach_or_enqueue(componentMeta, component);
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
  public modified(this: Entity, ref: ComponentRef): this {
    const componentMeta = this.world.entity(ref).meta;
    this._throwIfInterface(componentMeta, "modify");
    return this._markModified(componentMeta) as unknown as this;
  }

  /** @internal Mark a component changed, coalescing duplicate pending notifications. */
  protected _markModified(this: Entity, meta: ComponentMeta): this {
    this._throwIfInterface(meta, "modify");
    if (this._dirtyComponentBitmask.hasBit(meta.bitPtr)) {
      return this as unknown as this;
    }
    this._dirtyComponentBitmask.addBit(meta.bitPtr);
    if (this.world.deferred) {
      this.world._enqueue({ kind: CommandKind.Modified, entity: this, meta });
    } else {
      this._modified(meta);
    }
    return this as unknown as this;
  }

  /** @internal Attach immediately or enqueue the attach while deferred. */
  protected _attach_or_enqueue(
    this: Entity,
    meta: ComponentMeta,
    component: ComponentInstance
  ): void {
    if (this.world.deferred) {
      this.world._enqueue({
        kind: CommandKind.Attach,
        entity: this,
        meta,
        component,
      });
    } else {
      this._attach(meta, component);
    }
  }

  /**
   * Detach a component from this entity.
   *
   * In deferred mode the removal is queued; `get(C)` continues to return the
   * component until the queue drains. When applied, queries fire `exit`
   * callbacks first and the `onRemove` hook fires last.
   *
   * Relationship components take an explicit `target` to remove one edge. The
   * target is resolved eagerly via {@link World.entity}: any
   * {@link ComponentRef} that resolves to an existing entity is accepted, but
   * a ref that does not yet resolve throws. Omit `target` to remove every edge
   * of the relationship.
   *
   * @param Class - Component class to detach.
   * @param target - Relationship target; any {@link ComponentRef} that resolves
   *   to an existing entity. Ignored for non-relationship components.
   */
  public remove<C extends ComponentType>(
    Class: C,
    ...target: InstanceType<C> extends Relationship ? [target?: ComponentRef] : []
  ): void;

  /**
   * Detach a component by numeric type id.
   *
   * @param type - Numeric component type id.
   * @param target - Relationship target; any {@link ComponentRef} that resolves
   *   to an existing entity. Ignored for non-relationship components.
   */
  public remove(ceid: EID, target?: ComponentRef): void;

  public remove(entity: Entity, target?: ComponentRef): void;

  public remove(this: Entity, ref: ComponentRef, target?: ComponentRef): void {
    const componentMeta = this.world.entity(ref).meta;
    this._throwIfInterface(componentMeta, "remove");
    if (target !== undefined) {
      if (!componentMeta.isRelationship) {
        throw new Error("Entity.remove target argument requires a Relationship component");
      }
      const targetEntity = this.world.entity(target);
      if (this.world.deferred) {
        this.world._enqueue({
          kind: CommandKind.RemoveTarget,
          entity: this,
          meta: componentMeta,
          target: targetEntity,
        });
      } else {
        this._removeTarget(componentMeta, targetEntity);
      }
      return;
    }
    if (this.world.deferred) {
      this.world._enqueue({
        kind: CommandKind.Remove,
        entity: this,
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

  public set(this: Entity, ref: ComponentRef, props: Partial<ComponentInstance>): this {
    const componentMeta = this.world.entity(ref).meta;
    this._throwIfInterface(componentMeta, "set");
    if (this.world.deferred) {
      this.world._enqueue({
        kind: CommandKind.Set,
        entity: this,
        meta: componentMeta,
        props,
      });
    } else {
      this._set(componentMeta, props);
    }
    return this as unknown as this;
  }

  /**
   * @internal
   *
   * The canonical component materializer: construct a destination-owned
   * instance of `meta`'s class, assign `data` onto it, and store it on this
   * entity. Every metadata semantic is applied exactly once, in this order:
   * exclusivity eviction of conflicting components, interface-alias eviction
   * and storage, the framework `policyAdd` hook, the public `add` hook, and
   * query-entry notification.
   *
   * This is the single constructor-and-copy implementation in vecs. Ordinary
   * {@link set} calls it, and so does the cross-world subtree restore
   * (`lib/vecs/src/snapshot/restore.ts`), so a component that
   * arrives in a destination world is indistinguishable from one created by
   * `set` — same alias slots, same exclusivity outcome, same hooks, same
   * notifications.
   *
   * @param meta - Metadata of the component type to materialize.
   * @param data - The instance's own fields. Assignable onto a default-constructed
   *   instance, or handed to `construct` for a custom policy.
   * @param construct - Optional factory that builds the instance from `data`,
   *   used by owner-declared snapshot policies whose type needs construction
   *   beyond `new Class()` plus field assignment. Omit it for the default.
   * @returns The freshly materialized, destination-owned instance.
   */
  public _materialize(
    this: Entity,
    meta: ComponentMeta,
    data?: unknown,
    construct?: (data: unknown) => ComponentInstance
  ): ComponentInstance {
    const c = construct ? construct(data) : this._constructFrom(meta, data);
    this._storeComponent(meta, c, true);
    return c;
  }

  /** @internal Default construction for {@link _materialize}: `new Class()` plus field assignment. */
  private _constructFrom(this: Entity, meta: ComponentMeta, data: unknown): ComponentInstance {
    const c = new (meta.Class as ComponentClass)();
    if (data != null) {
      Object.assign(c, data as Record<string, unknown>);
    }
    return c;
  }

  /** @internal Apply one relationship-edge addition. */
  public _addTarget(this: Entity, meta: ComponentMeta, target: Entity): void {
    this._assertTargetWorld(target);
    if (this._destroyed || target._destroyed) {
      return;
    }
    const existing = this._components.get(meta.eid) as Relationship | undefined;
    if (existing?._hasTarget(target)) {
      return;
    }
    if (existing && meta.relationshipExclusive) {
      const previous = existing._replaceTarget(target);
      this._removeIncoming(previous, meta.eid);
      this._addIncoming(target, meta.eid);
      const reflectsReplacement = (): boolean =>
        this._components.get(meta.eid) === existing &&
        existing._hasTarget(target) &&
        !existing._hasTarget(previous);
      if (!this._emitTargetRemove(meta, existing, previous, reflectsReplacement)) {
        return;
      }
      if (!this._emitTargetAdd(meta, existing, target, reflectsReplacement)) {
        return;
      }
      this._notifyRelationshipChanged(meta, existing);
      return;
    }
    if (existing) {
      existing._addTarget(target);
      this._addIncoming(target, meta.eid);
      const reflectsAdd = (): boolean =>
        this._components.get(meta.eid) === existing && existing._hasTarget(target);
      if (!this._emitTargetAdd(meta, existing, target, reflectsAdd)) {
        return;
      }
      this._notifyRelationshipChanged(meta, existing);
      return;
    }

    const relationship = new (meta.Class as ComponentClass)() as Relationship;
    relationship._addTarget(target);
    this._storeRelationship(meta, relationship);
    this._addIncoming(target, meta.eid);
    const reflectsAdd = (): boolean =>
      this._components.get(meta.eid) === relationship && relationship._hasTarget(target);
    if (!this._emitTargetAdd(meta, relationship, target, reflectsAdd)) {
      return;
    }
    meta._onAdd?.(this, relationship);
    if (!reflectsAdd()) {
      return;
    }
    this.world._notifyComponentAdded(meta.eid, this);
  }

  /** @internal Apply one relationship-edge removal. */
  public _removeTarget(this: Entity, meta: ComponentMeta, target: Entity): void {
    this._assertTargetWorld(target);
    if (this._destroyed) {
      return;
    }
    const relationship = this._components.get(meta.eid) as Relationship | undefined;
    if (!relationship?._hasTarget(target)) {
      return;
    }
    if (relationship._targetCount() === 1) {
      this._remove(meta);
      return;
    }
    relationship._removeTarget(target);
    this._removeIncoming(target, meta.eid);
    const reflectsRemove = (): boolean =>
      this._components.get(meta.eid) === relationship && !relationship._hasTarget(target);
    if (!this._emitTargetRemove(meta, relationship, target, reflectsRemove)) {
      return;
    }
    this._notifyRelationshipChanged(meta, relationship);
  }

  /** @internal Perform the shared set-side hook and query update routing. */
  protected _notifyComponentSet(
    this: Entity,
    meta: ComponentMeta,
    instance: ComponentInstance,
    isUpdate: boolean
  ): void {
    this._notifyRaw(meta, instance, isUpdate);
    if (meta._implementsClosure) {
      for (const aliasMeta of meta._implementsClosure) {
        this._notifyRaw(aliasMeta, instance, isUpdate);
      }
    }
  }

  /** @internal Detach a whole relationship before exposing its zero-target snapshot to hooks. */
  protected _detachRelationship(
    this: Entity,
    meta: ComponentMeta,
    relationship: Relationship
  ): void {
    this._dirtyComponentBitmask.deleteBit(meta.bitPtr);
    this.componentBitmask.deleteBit(meta.bitPtr);
    this.world._notifyComponentRemoved(meta.eid, this);
    this._components.delete(meta.eid);
    this.world._notifyComponentChanged(meta.eid, this);
    meta._detachCarrier(this);
    const targets = relationship._takeTargets();
    for (const target of targets) {
      this._removeIncoming(target, meta.eid);
    }
    for (const target of targets) {
      const reflectsRemove = (): boolean =>
        this._components.get(meta.eid) !== relationship && !relationship._hasTarget(target);
      this._emitTargetRemove(meta, relationship, target, reflectsRemove);
    }
    meta._onRemove?.(this, relationship);
  }

  /** @internal Store a newly attached relationship without firing hooks or query entry early. */
  private _storeRelationship(this: Entity, meta: ComponentMeta, relationship: Relationship): void {
    if (meta._exclusive) {
      for (const exclusiveMeta of meta._exclusive) {
        if (this._components.has(exclusiveMeta.eid)) {
          this._remove(exclusiveMeta);
        }
      }
    }
    this._components.set(meta.eid, relationship);
    this.componentBitmask.addBit(meta.bitPtr);
    meta._attachCarrier(this);
  }

  /** Assign relationship data; target storage is symbol-keyed and never among `props`' entries. */
  private _assignRelationshipProps(
    relationship: Relationship,
    props: Partial<ComponentInstance>
  ): boolean {
    let assigned = false;
    for (const [key, value] of Object.entries(props)) {
      (relationship as unknown as Record<string, unknown>)[key] = value;
      assigned = true;
    }
    return assigned;
  }

  /** @internal Perform one set-side hook and query update without expanding aliases. */
  protected _notifyRaw(
    this: Entity,
    meta: ComponentMeta,
    instance: ComponentInstance,
    isUpdate: boolean
  ): void {
    meta._onSet?.(this, instance);
    this._dirtyComponentBitmask.deleteBit(meta.bitPtr);
    if (isUpdate) {
      this.world._notifyComponentChanged(meta.eid, this);
      this._routeModified(meta.eid, instance);
    }
  }

  /** @internal Store a component instance and perform the shared add-side bookkeeping. */
  protected _storeComponent(
    this: Entity,
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
  protected _storeRaw(
    this: Entity,
    meta: ComponentMeta,
    instance: ComponentInstance,
    isAdd: boolean
  ): void {
    const existing = this._components.has(meta.eid);
    this._components.set(meta.eid, instance);
    this.componentBitmask.addBit(meta.bitPtr);
    if (!existing) {
      meta._attachCarrier(this);
    }
    if (isAdd && !existing) {
      meta._onPolicyAdd?.(this, instance);
      meta._onAdd?.(this, instance);
    }
    if (!existing) {
      this.world._notifyComponentAdded(meta.eid, this);
    }
  }

  private _throwIfInterface(meta: ComponentMeta, op: string): void {
    if (meta._isInterface) {
      throw new Error(
        `Cannot ${op} the abstract interface ${meta.Class.name}; operate via the concrete component`
      );
    }
  }

  private _assertTargetWorld(target: Entity): void {
    if (target.world !== this.world) {
      throw new Error("Relationship target must belong to the same World as its source");
    }
  }

  private _emitTargetAdd(
    this: Entity,
    meta: ComponentMeta,
    relationship: Relationship,
    target: Entity,
    isCurrent: () => boolean
  ): boolean {
    // Policy handlers run first; each may mutate the relationship (e.g. an
    // OwnedTarget policy parents the target). If one makes the edge no longer
    // current, abort remaining policies and the public hook.
    if (meta._onTargetPolicyAdd !== undefined) {
      for (const h of _slotHandlers(meta._onTargetPolicyAdd)) {
        h(this, relationship, target);
        if (!isCurrent()) {
          return false;
        }
      }
    }
    meta._onTargetAdd?.(this, relationship, target);
    return isCurrent();
  }

  private _emitTargetRemove(
    this: Entity,
    meta: ComponentMeta,
    relationship: Relationship,
    target: Entity,
    isCurrent: () => boolean
  ): boolean {
    if (meta._onTargetPolicyRemove !== undefined) {
      for (const h of _slotHandlers(meta._onTargetPolicyRemove)) {
        h(this, relationship, target);
        if (!isCurrent()) {
          return false;
        }
      }
    }
    meta._onTargetRemove?.(this, relationship, target);
    return isCurrent();
  }

  /**
   * Register a handler for a hook event on this entity's component meta.
   * See {@link ComponentMeta.on} for the event list and semantics. Returns this
   * entity for chaining.
   */
  public on<E extends HookEvent>(event: E, handler: HookEventMap[E], insert = false): this {
    this.meta.on(event, handler, insert);
    return this;
  }

  /** Remove a previously-registered handler by reference. See {@link ComponentMeta.off}. */
  public off<E extends HookEvent>(event: E, handler: HookEventMap[E]): this {
    this.meta.off(event, handler);
    return this;
  }
}
