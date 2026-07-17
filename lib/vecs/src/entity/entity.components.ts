import { CommandKind } from "../command.js";
import {
  ComponentMeta,
  type ComponentClass,
  type ComponentInstance,
  type ComponentRef,
  type ComponentType,
  type HookHandler,
  type TargetHandler,
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
    const c = existing ?? this._new(meta, props);
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
   * @param Class - Component class to instantiate.
   * @returns This entity, for chaining.
   */
  public add<C extends ComponentClass>(
    Class: C,
    ...target: InstanceType<C> extends Relationship ? [target: Entity] : []
  ): this;

  /**
   * Attach a component by numeric type id.
   *
   * @param type - Numeric component type id.
   * @returns This entity, for chaining.
   */
  public add(ceid: EID, target?: Entity): this;

  public add(entity: Entity, target?: Entity): this;

  public add(this: Entity, ref: ComponentRef, target?: Entity): this {
    const componentMeta = this.world.entity(ref).meta;
    this._throwIfInterface(componentMeta, "add");
    if (componentMeta.isRelationship) {
      if (target === undefined) {
        throw new Error("Entity.add requires a target for Relationship components");
      }
      this._assertTargetWorld(target);
      if (this.world.deferred) {
        this.world._enqueue({
          kind: CommandKind.AddTarget,
          entity: this,
          meta: componentMeta,
          target,
        });
      } else {
        this._addTarget(componentMeta, target);
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
      throw new Error(`Cannot ensure component on destroyed entity ${this.eid}`);
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
   * @param Class - Component class to detach.
   */
  public remove<C extends ComponentType>(
    Class: C,
    ...target: InstanceType<C> extends Relationship ? [target?: Entity] : []
  ): void;

  /**
   * Detach a component by numeric type id.
   *
   * @param type - Numeric component type id.
   */
  public remove(ceid: EID, target?: Entity): void;

  public remove(entity: Entity, target?: Entity): void;

  public remove(this: Entity, ref: ComponentRef, target?: Entity): void {
    const componentMeta = this.world.entity(ref).meta;
    this._throwIfInterface(componentMeta, "remove");
    if (target !== undefined) {
      if (!componentMeta.isRelationship) {
        throw new Error("Entity.remove target argument requires a Relationship component");
      }
      this._assertTargetWorld(target);
      if (this.world.deferred) {
        this.world._enqueue({
          kind: CommandKind.RemoveTarget,
          entity: this,
          meta: componentMeta,
          target,
        });
      } else {
        this._removeTarget(componentMeta, target);
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
   * Construct a fresh component of `type`, apply `props`, store it on this
   * entity, fire the `onAdd` hook, and route query updates.
   *
   * If the component type belongs to an exclusivity group, any conflicting
   * component already on this entity is removed first.
   */
  protected _new(
    this: Entity,
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

  /** Assign relationship data while ignoring all target-storage spellings. */
  private _assignRelationshipProps(
    relationship: Relationship,
    props: Partial<ComponentInstance>
  ): boolean {
    let assigned = false;
    for (const [key, value] of Object.entries(props)) {
      if (key !== "target" && key !== "targets" && key !== "_targets") {
        (relationship as unknown as Record<string, unknown>)[key] = value;
        assigned = true;
      }
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
      this._queries.forEach((q) => q._notifyModified(this, meta.eid, instance));
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
    if (meta._targetAddPolicies) {
      for (const policy of meta._targetAddPolicies.values()) {
        policy(this, relationship, target);
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
    if (meta._targetRemovePolicies) {
      for (const policy of meta._targetRemovePolicies.values()) {
        policy(this, relationship, target);
        if (!isCurrent()) {
          return false;
        }
      }
    }
    meta._onTargetRemove?.(this, relationship, target);
    return isCurrent();
  }

  /** Return the current add hook, or `undefined` when none is set. */
  public onAdd(): HookHandler | undefined;

  /** Set the add hook, or remove it by passing `undefined`. */
  public onAdd(handler: HookHandler | undefined): this;

  public onAdd(handler?: HookHandler): this | HookHandler | undefined {
    if (arguments.length === 0) {
      return this.meta.onAdd();
    }
    this.meta.onAdd(handler);
    return this;
  }

  /** Return the current remove hook, or `undefined` when none is set. */
  public onRemove(): HookHandler | undefined;

  /** Set the remove hook, or remove it by passing `undefined`. */
  public onRemove(handler: HookHandler | undefined): this;

  public onRemove(handler?: HookHandler): this | HookHandler | undefined {
    if (arguments.length === 0) {
      return this.meta.onRemove();
    }
    this.meta.onRemove(handler);
    return this;
  }

  /** Return the current relationship target-add hook. */
  public onTargetAdd(): TargetHandler | undefined;
  /** Set the relationship target-add hook. */
  public onTargetAdd(handler: TargetHandler | undefined): this;
  public onTargetAdd(handler?: TargetHandler): this | TargetHandler | undefined {
    if (arguments.length === 0) {
      return this.meta.onTargetAdd();
    }
    this.meta.onTargetAdd(handler);
    return this;
  }

  /** Return the current relationship target-remove hook. */
  public onTargetRemove(): TargetHandler | undefined;
  /** Set the relationship target-remove hook. */
  public onTargetRemove(handler: TargetHandler | undefined): this;
  public onTargetRemove(handler?: TargetHandler): this | TargetHandler | undefined {
    if (arguments.length === 0) {
      return this.meta.onTargetRemove();
    }
    this.meta.onTargetRemove(handler);
    return this;
  }

  /** Return the current set hook, or `undefined` when none is set. */
  public onSet(): HookHandler | undefined;

  /** Set the set hook, or remove it by passing `undefined`. */
  public onSet(handler: HookHandler | undefined): this;

  public onSet(handler?: HookHandler): this | HookHandler | undefined {
    if (arguments.length === 0) {
      return this.meta.onSet();
    }
    this.meta.onSet(handler);
    return this;
  }
}
