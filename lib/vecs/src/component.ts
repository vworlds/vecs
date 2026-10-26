import { Entity } from "./entity/index.js";
import {
  Relationship,
  type ComponentInstance,
  type ComponentType,
  type HookEvent,
  type HookEventMap,
  type HookHandler,
  type NormalizeHandler,
  type TargetHandler,
  type ValidateHandler,
} from "./component_meta.js";
import { ComponentMember, _declareComponentMember } from "./reflection/member_builder.js";
import { type MemberType } from "./reflection/member_types.js";
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
  type NormalizeHandler,
  type TargetHandler,
  type ValidateHandler,
} from "./component_meta.js";

/**
 * A per-component event map that narrows `add` / `remove` / `set` handlers to
 * the instance type `T` produces, narrows `validate` / `normalize` handlers to
 * that instance type, and narrows `targetAdd` / `targetRemove` /
 * `targetPolicyAdd` / `targetPolicyRemove` handlers to `T`'s relationship
 * instance type when `T` produces a relationship.
 */
type ComponentEventMap<T extends ComponentType> = {
  add: HookHandler<InstanceType<T>>;
  remove: HookHandler<InstanceType<T>>;
  set: HookHandler<InstanceType<T>>;
  targetAdd: TargetHandler<InstanceType<T> & Relationship>;
  targetRemove: TargetHandler<InstanceType<T> & Relationship>;
  validate: ValidateHandler<InstanceType<T>>;
  normalize: NormalizeHandler<InstanceType<T>>;
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
  /**
   * Declare a member of this component class and its type, for reflection.
   *
   * Chain `.range(min, max)`, `.description(text)`, `.unit(text)` and
   * `.values([...])` onto the result, then `.member(...)` for the next member.
   * The declaration merges into the class's process-wide {@link VecsStruct}
   * definition, which this component entity carries; repeating an identical
   * declaration in another world is a no-op. Subclasses inherit the member, as
   * they inherit decorator declarations.
   *
   * @param name - The member's property name.
   * @param type - A scalar type name, a nested component class, or an array `[type]`.
   * @returns A builder for this member's metadata.
   * @throws When the declaration contradicts the existing definition.
   */
  public member<K extends keyof InstanceType<T> & string>(
    name: K,
    type: MemberType
  ): ComponentMember<T> {
    _declareComponentMember(this, name, { type });
    return new ComponentMember(this, name);
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
}
