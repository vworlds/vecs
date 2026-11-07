import { Entity } from "./entity/index.js";
import {
  Relationship,
  type ComponentInstance,
  type ComponentType,
  type HookEvent,
  type HookHandler,
  type TraitEvent,
  type TraitHookOptions,
  type NormalizeHandler,
  type EqualsHandler,
  type TargetHandler,
  type ValidateHandler,
} from "./component_meta.js";
import { _declareComponentMember } from "./reflection/component_members.js";
import { type MemberType, type RangeBound } from "./reflection/member_types.js";
import { type MemberDeclaration } from "./reflection/vecs_struct.js";
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
  type EqualsHandler,
  type TargetHandler,
  type ValidateHandler,
} from "./component_meta.js";

/**
 * A per-component event map that narrows `add` / `remove` / `set` handlers to
 * the instance type `T` produces, narrows `validate` / `normalize` handlers to
 * that instance type, compares that type for `equals`, and narrows `targetAdd` /
 * `targetRemove` handlers to `T`'s relationship instance type when `T` produces
 * a relationship.
 */
type ComponentEventMap<T extends ComponentType> = {
  add: HookHandler<InstanceType<T>>;
  remove: HookHandler<InstanceType<T>>;
  set: HookHandler<InstanceType<T>>;
  targetAdd: TargetHandler<InstanceType<T> & Relationship>;
  targetRemove: TargetHandler<InstanceType<T> & Relationship>;
  validate: ValidateHandler<InstanceType<T>>;
  normalize: NormalizeHandler<InstanceType<T>>;
  equals: EqualsHandler<InstanceType<T>>;
};

/** Callbacks declared alongside the {@link CustomSnapshot} policy value. */
export interface CustomSnapshotOptions<T extends ComponentInstance = ComponentInstance> {
  /** Convert a live component instance into detached, world-agnostic data. */
  capture: SnapshotCapture;
  /** Construct a fresh, destination-owned instance from previously captured data. */
  materialize: SnapshotMaterialize;
}

/**
 * The definition entity of a registered component class, as returned by
 * {@link World.component}: an ordinary {@link Entity} with the
 * {@link ComponentDeclarations} builders typed for `T`.
 *
 * `Component` is a type, not a class: every entity, definitions included, is an
 * `Entity` and shares one prototype. Test an entity with
 * {@link Entity.isComponent}.
 */
export type Component<T extends ComponentType = ComponentType> = ComponentDeclarations<T> & Entity;

/**
 * Declaration builders and typed hook registration of a component definition
 * entity. Reach them through {@link Component}, the type {@link World.component}
 * returns.
 */
export interface ComponentDeclarations<T extends ComponentType = ComponentType> {
  /**
   * Declare the human-readable description of the member most recently
   * declared with {@link member}.
   *
   * @throws When no member has been declared on this component yet.
   */
  description(text: string): this;

  /**
   * Declare a member of this component class and its type, for reflection.
   *
   * Member modifiers apply to the member most recently declared here, as in
   * Flecs: chain `.range(min, max)`, `.description(text)`, `.unit(text)` and
   * `.values([...])` after this call, then `.member(...)` for the next member.
   * The chain stays on this component entity, so it can continue with `.on(…)`
   * or any other entity method:
   *
   * ```ts
   * world.component(Position)
   *   .member("x", "i32").range(-100, 100).unit("m")
   *   .member("y", "i32").range(-100, 100)
   *   .on("set", (entity, position) => sync(entity, position));
   * ```
   *
   * The declaration merges into the class's process-wide {@link VecsStruct}
   * definition, which this component entity carries; repeating an identical
   * declaration in another world is a no-op. Subclasses inherit the member, as
   * they inherit decorator declarations.
   *
   * @param name - The member's property name.
   * @param type - A scalar type name, a nested component class, or an array `[type]`.
   * @returns This component entity, for chaining.
   * @throws When the declaration contradicts the existing definition.
   */
  member<K extends keyof InstanceType<T> & string>(name: K, type: MemberType): this;

  /**
   * Register a handler for a hook event (`equals` replaces its single handler),
   * with the handler signature narrowed
   * to this component's instance type (for `add` / `remove` / `set`) or its
   * relationship instance type (for the `target*` events). See
   * {@link ComponentMeta.on} for full semantics.
   */
  on<E extends HookEvent>(event: E, handler: ComponentEventMap<T>[E]): this;
  /** @internal Register a relationship-trait handler. See {@link ComponentMeta.on}. */
  on<E extends TraitEvent>(
    event: E,
    options: TraitHookOptions,
    handler: ComponentEventMap<T>[E]
  ): this;

  /** Remove a previously-registered handler by reference. See {@link ComponentMeta.off}. */
  off<E extends HookEvent>(event: E, handler: ComponentEventMap<T>[E]): this;

  /**
   * Declare the inclusive `[min, max]` range of the numeric member most
   * recently declared with {@link member}. Metadata only: nothing checks it on
   * `set`.
   *
   * @throws When no member has been declared on this component yet.
   */
  range(min: RangeBound, max: RangeBound): this;

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
  snapshotPolicy(policy: typeof ClonePublic | typeof DontSnapshot): this;
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
  snapshotPolicy(
    policy: typeof CustomSnapshot,
    options: CustomSnapshotOptions<InstanceType<T>>
  ): this;

  /**
   * Declare the unit of measure, for example `"m"`, of the member most recently
   * declared with {@link member}.
   *
   * @throws When no member has been declared on this component yet.
   */
  unit(text: string): this;

  /**
   * Declare the allowed values of the `enum` member most recently declared
   * with {@link member}.
   *
   * @throws When no member has been declared on this component yet.
   */
  values(allowed: readonly number[]): this;
}

/**
 * The builder implementations, installed on `Entity.prototype` so definition
 * entities keep the one entity class and hidden class. `on` / `off` need no
 * implementation here: the typed overloads above narrow `Entity`'s own.
 */
const declarations: ThisType<Component> &
  Pick<ComponentDeclarations, "description" | "member" | "range" | "unit" | "values"> & {
    snapshotPolicy(policy: SnapshotPolicyType, options?: CustomSnapshotOptions): Component;
  } = {
  description(text) {
    return declareCurrent(this, "description", { description: text });
  },
  member(name, type) {
    _declareComponentMember(this, name, { type });
    this.meta._currentMember = name;
    return this;
  },
  range(min, max) {
    return declareCurrent(this, "range", { range: [min, max] });
  },
  snapshotPolicy(policy, options) {
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
  },
  unit(text) {
    return declareCurrent(this, "unit", { unit: text });
  },
  values(allowed) {
    return declareCurrent(this, "values", { values: allowed });
  },
};

for (const [name, value] of Object.entries(declarations)) {
  Object.defineProperty(Entity.prototype, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function declareCurrent(
  component: Component,
  modifier: string,
  declaration: MemberDeclaration
): Component {
  const name = component.meta._currentMember;
  if (name === undefined) {
    throw new Error(
      `${modifier}() on ${component.meta.Class.name}: call .member(name, type) first`
    );
  }
  _declareComponentMember(component, name, declaration);
  return component;
}
