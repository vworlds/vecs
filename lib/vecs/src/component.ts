import { Entity } from "./entity/index.js";
import {
  Relationship,
  type ComponentType,
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
  type Hook,
  type HookHandler,
  type TargetHandler,
} from "./component_meta.js";

/** A component entity created by {@link World.component}. */
export class Component<T extends ComponentType = ComponentType> extends Entity {
  /** Get or set the callback fired after a relationship edge is added. */
  public override onTargetAdd(): TargetHandler | undefined;
  public override onTargetAdd(
    handler: TargetHandler<InstanceType<T> & Relationship> | undefined
  ): this;
  public override onTargetAdd(handler: TargetHandler | undefined): this;
  public override onTargetAdd(handler?: any): this | TargetHandler | undefined {
    if (arguments.length === 0) {
      return super.onTargetAdd();
    }
    super.onTargetAdd(handler);
    return this;
  }

  /** Get or set the callback fired after a relationship edge is removed. */
  public override onTargetRemove(): TargetHandler | undefined;
  public override onTargetRemove(
    handler: TargetHandler<InstanceType<T> & Relationship> | undefined
  ): this;
  public override onTargetRemove(handler: TargetHandler | undefined): this;
  public override onTargetRemove(handler?: any): this | TargetHandler | undefined {
    if (arguments.length === 0) {
      return super.onTargetRemove();
    }
    super.onTargetRemove(handler);
    return this;
  }

  /**
   * Get or set the callback fired each time this component is **added** to an entity.
   *
   * The handler is called with the owning entity and the freshly created
   * component instance. Use it to initialise external state (e.g. scene objects)
   * that should exist for the lifetime of the component.
   *
   * Call without an argument to return the current handler. Pass `undefined` to remove it.
   *
   * @param handler - Callback invoked with `(entity, componentInstance)`, or `undefined`.
   * @returns The current handler when called without an argument; otherwise this component.
   *
   * @example
   * ```ts
   * world.component(Sprite).onAdd((entity, sprite) => sprite.initialize(scene));
   * ```
   */
  public override onAdd(): HookHandler | undefined;
  public override onAdd(handler: HookHandler<InstanceType<T>> | undefined): this;
  public override onAdd(handler: HookHandler | undefined): this;
  public override onAdd(handler?: any): this | HookHandler | undefined {
    if (arguments.length === 0) {
      return super.onAdd();
    }
    super.onAdd(handler);
    return this;
  }

  /**
   * Get or set the callback fired each time this component is **removed** from an
   * entity, or when the owning entity is destroyed.
   *
   * The handler is called with the owning entity and the component instance that
   * is about to be detached. Use it to clean up any external state associated
   * with the component.
   *
   * Call without an argument to return the current handler. Pass `undefined` to remove it.
   *
   * @param handler - Callback invoked with `(entity, componentInstance)`, or `undefined`.
   * @returns The current handler when called without an argument; otherwise this component.
   *
   * @example
   * ```ts
   * world.component(Sprite).onRemove((entity, sprite) => sprite.destroy(scene));
   * ```
   */
  public override onRemove(): HookHandler | undefined;
  public override onRemove(handler: HookHandler<InstanceType<T>> | undefined): this;
  public override onRemove(handler: HookHandler | undefined): this;
  public override onRemove(handler?: any): this | HookHandler | undefined {
    if (arguments.length === 0) {
      return super.onRemove();
    }
    super.onRemove(handler);
    return this;
  }

  /**
   * Get or set the callback fired each time this component's data is **set or
   * modified**.
   *
   * Fires when:
   * - `entity.set(C, props)` applies data to the component.
   * - `entity.attach(instance)` stores an existing instance.
   * - `entity.modified(C)` is called after in-place mutation.
   * - A system's `getMut(C)` marks the component dirty.
   * - `entity.ensure(C)` creates or marks the component dirty.
   *
   * The handler receives the owning entity and the current component instance.
   * Component instances do not carry entity references, which is why the entity
   * is passed explicitly.
   *
   * Call without an argument to return the current handler. Pass `undefined` to remove it.
   *
   * @param handler - Callback invoked with `(entity, componentInstance)`, or `undefined`.
   * @returns The current handler when called without an argument; otherwise this component.
   *
   * @example
   * ```ts
   * world.component(Transform).onSet((entity, t) => renderer.syncTransform(entity.eid, t));
   * ```
   */
  public override onSet(): HookHandler | undefined;
  public override onSet(handler: HookHandler<InstanceType<T>> | undefined): this;
  public override onSet(handler: HookHandler | undefined): this;
  public override onSet(handler?: any): this | HookHandler | undefined {
    if (arguments.length === 0) {
      return super.onSet();
    }
    super.onSet(handler);
    return this;
  }
}
