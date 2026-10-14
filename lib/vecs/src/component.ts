import { Entity, type EID, type EntityClass } from "./entity/index.js";
import { type Module } from "./module.js";
import {
  Relationship,
  type ComponentClass,
  type ComponentRef,
  type ComponentMeta,
  type ComponentInstance,
  type ComponentType,
  type HookEvent,
  type HookEventMap,
  type HookHandler,
  type TargetHandler,
} from "./component_meta.js";
import {
  type SnapshotCapture,
  type SnapshotMaterialize,
  type SnapshotPolicyType,
  ClonePublic,
  CustomSnapshot,
  DontSnapshot,
  _declareSnapshotPolicy,
} from "./modules/snapshot_types.js";

export {
  CleanupPolicy,
  ComponentMeta,
  Implements,
  Relationship,
  type ComponentClass,
  type ComponentInstance,
  type ComponentRef,
  type ComponentRefArray,
  type ComponentType,
  type HookEvent,
  type HookEventMap,
  type HookHandler,
  type TargetHandler,
} from "./component_meta.js";

/**
 * A per-component event map that narrows `add` / `remove` / `set` handlers to
 * the instance type `T` produces, and narrows `targetAdd` / `targetRemove` /
 * `targetPolicyAdd` / `targetPolicyRemove` handlers to `T`'s relationship
 * instance type when `T` produces a relationship.
 */
type ComponentEventMap<T extends ComponentType> = {
  add: HookHandler<InstanceType<T>>;
  remove: HookHandler<InstanceType<T>>;
  set: HookHandler<InstanceType<T>>;
  targetAdd: TargetHandler<InstanceType<T> & Relationship>;
  targetRemove: TargetHandler<InstanceType<T> & Relationship>;
  targetPolicyAdd: TargetHandler<InstanceType<T> & Relationship>;
  targetPolicyRemove: TargetHandler<InstanceType<T> & Relationship>;
  policyAdd: HookHandler;
  policyRemove: HookHandler;
};

/** Callbacks declared alongside the {@link CustomSnapshot} policy value. */
export interface CustomSnapshotOptions<T extends ComponentInstance = ComponentInstance> {
  /** Convert a live component instance into detached, world-agnostic data. */
  capture: SnapshotCapture;
  /** Construct a fresh, destination-owned instance from previously captured data. */
  materialize: SnapshotMaterialize;
}

/**
 * A component entity created by {@link World.component}.
 */
export class Component<T extends ComponentType = ComponentType> extends Entity {
  private readonly _registrars: (EntityClass<Module<any>> | undefined)[] = [];
  private _traitRegistrars: Map<EID, Map<EID | undefined, EntityClass<Module<any>>>> | undefined =
    undefined;

  /**
   * First module class that registered this component, or `undefined` for
   * registration outside module init. Later lookups never replace it.
   */
  public registeredBy(): EntityClass<Module<any>> | undefined {
    return this._registrars[0];
  }

  /**
   * Distinct registering module classes in declaration order. Includes
   * `undefined` only for an initial registration outside module init; subsequent
   * application lookups are ignored. Returns a detached read-only snapshot.
   */
  public registrars(): readonly (EntityClass<Module<any>> | undefined)[] {
    return [...this._registrars];
  }

  /**
   * First module class that declared a trait on this component entity during
   * synchronous module init. Application declarations outside init and the
   * component's own singleton data are not recorded. Pass a target for a
   * relationship trait edge. Returns `undefined` when no module declaration
   * was recorded for this trait/edge. Refs
   * must resolve in this world, as with {@link Entity.has}. History survives removal;
   * idempotent adds and data updates do not replace the first registrar.
   */
  public traitRegisteredBy(
    trait: ComponentRef,
    target?: ComponentRef
  ): EntityClass<Module<any>> | undefined {
    const traitEid = this.world.entity(trait).eid;
    const targetEid = target === undefined ? undefined : this.world.entity(target).eid;
    return this._traitRegistrars?.get(traitEid)?.get(targetEid);
  }

  /** Attach a trait and record its first module-init declaration. See {@link Entity.add}. */
  public override add<C extends ComponentClass>(
    Class: C,
    ...target: InstanceType<C> extends Relationship ? [target: ComponentRef] : []
  ): this;
  public override add(ceid: EID, target?: ComponentRef): this;
  public override add(entity: Entity, target?: ComponentRef): this;
  public override add(ref: ComponentRef, target?: ComponentRef): this {
    const registrar = this.world._currentModule;
    if (registrar === undefined) {
      return super.add(ref as Entity, target);
    }
    const trait = this.world.entity(ref);
    const targetEntity = target === undefined ? undefined : this.world.entity(target);
    super.add(trait, targetEntity);
    if (trait !== this) {
      this._recordTrait(trait.eid, targetEntity?.eid, registrar);
    }
    return this;
  }

  /** Set a trait and record its first module-init declaration. See {@link Entity.set}. */
  public override set<C extends ComponentClass>(Class: C, props: Partial<InstanceType<C>>): this;
  public override set(ceid: EID, props: Partial<ComponentInstance>): this;
  public override set(entity: Entity, props: Partial<ComponentInstance>): this;
  public override set(ref: ComponentRef, props: Partial<ComponentInstance>): this {
    const registrar = this.world._currentModule;
    if (registrar === undefined) {
      return super.set(ref as Entity, props);
    }
    const trait = this.world.entity(ref);
    super.set(trait, props);
    if (trait !== this && !trait.meta.isRelationship) {
      this._recordTrait(trait.eid, undefined, registrar);
    }
    return this;
  }

  /** @internal Record declarations only on component builders, never ordinary entities. */
  public _recordRegistration(registrar: EntityClass<Module<any>> | undefined): void {
    if (
      this._registrars.length === 0 ||
      (registrar !== undefined && !this._registrars.includes(registrar))
    ) {
      this._registrars.push(registrar);
    }
  }

  /**
   * Register a handler for a hook event, with the handler signature narrowed
   * to this component's instance type (for `add` / `remove` / `set`) or its
   * relationship instance type (for the `target*` events). See
   * {@link ComponentMeta.on} for full semantics.
   */
  public override on<E extends HookEvent>(
    event: E,
    handler: ComponentEventMap<T>[E],
    insert = false
  ): this {
    return super.on(event, handler as HookEventMap[E], insert);
  }

  /** Remove a previously-registered handler by reference. See {@link ComponentMeta.off}. */
  public override off<E extends HookEvent>(event: E, handler: ComponentEventMap<T>[E]): this {
    return super.off(event, handler as HookEventMap[E]);
  }

  /**
   * Declare how cross-world subtree snapshots capture this component type.
   *
   * Callable at any time. The declaration affects future captures only:
   * snapshots already captured retain the materializer their policy resolved to
   * at capture time, so changing or revoking this policy cannot alter how they
   * restore.
   *
   * `ClonePublic` — the default — captures a fresh instance with the source's
   * own enumerable fields cloned. `DontSnapshot` never captures the type.
   *
   * @param policy - `ClonePublic` or `DontSnapshot`.
   * @returns This component entity, for chaining.
   */
  public snapshotPolicy(policy: typeof ClonePublic | typeof DontSnapshot): this;
  /**
   * Declare a bespoke capture/materialize policy for this component type.
   *
   * Use it when a component mixes declarative state with runtime state that must
   * not cross worlds — a physics handle, a socket, a compiled shader.
   *
   * Callable at any time. It affects future captures only; existing snapshots
   * restore through the materializer bound when they were captured.
   *
   * @param CustomSnapshot - Selects the owner-supplied policy.
   * @param options - The `capture` and `materialize` callbacks, stored on this
   *   entity's own `OnSnapshot` edge so each component type keeps its policy.
   * @returns This component entity, for chaining.
   */
  public snapshotPolicy(
    policy: typeof CustomSnapshot,
    options: CustomSnapshotOptions<InstanceType<T>>
  ): this;
  public snapshotPolicy(
    policy: SnapshotPolicyType,
    options?: CustomSnapshotOptions<InstanceType<T>>
  ): this {
    if (policy === CustomSnapshot) {
      if (options?.capture === undefined || options.materialize === undefined) {
        throw new Error(
          `snapshotPolicy(CustomSnapshot) requires both capture and materialize callbacks for ${this.meta.Class.name}`
        );
      }
      _declareSnapshotPolicy(this, policy, options.capture, options.materialize);
    } else {
      _declareSnapshotPolicy(this, policy);
    }
    return this;
  }

  /** @internal Capture attach/ensure declarations before a deferred command loses init context. */
  protected override _attach_or_enqueue(meta: ComponentMeta, component: ComponentInstance): void {
    const registrar = this.world._currentModule;
    if (registrar === undefined) {
      return super._attach_or_enqueue(meta, component);
    }
    super._attach_or_enqueue(meta, component);
    if (meta.eid !== this.eid) {
      this._recordTrait(meta.eid, undefined, registrar);
    }
  }

  private _recordTrait(
    traitEid: EID,
    targetEid: EID | undefined,
    registrar: EntityClass<Module<any>>
  ): void {
    const registrars = (this._traitRegistrars ??= new Map());
    let edges = registrars.get(traitEid);
    if (edges === undefined) {
      edges = new Map();
      registrars.set(traitEid, edges);
    }
    if (!edges.has(targetEid)) {
      edges.set(targetEid, registrar);
    }
  }
}
