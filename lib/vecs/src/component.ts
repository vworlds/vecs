import { Entity } from "./entity/index.js";
import {
  Relationship,
  type ComponentType,
  type HookEvent,
  type HookEventMap,
  type HookHandler,
  type TargetHandler,
} from "./component_meta.js";

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

/** A component entity created by {@link World.component}. */
export class Component<T extends ComponentType = ComponentType> extends Entity {
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
}
