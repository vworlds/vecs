import { Entity } from "./entity/index.js";
import type { ComponentInstance, ComponentType } from "./component_meta.js";

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
  type RetargetHandler,
} from "./component_meta.js";

/** A component entity created by {@link World.component}. */
export class Component<T extends ComponentType = ComponentType> extends Entity {
  /**
   * Register a callback fired each time this component is **added** to an entity.
   *
   * The handler is called with the owning entity and the freshly created
   * component instance. Use it to initialise external state (e.g. scene objects)
   * that should exist for the lifetime of the component.
   *
   * @param handler - Callback invoked with `(entity, componentInstance)`.
   * @returns This `Component` entity, for chaining.
   *
   * @example
   * ```ts
   * world.component(Sprite).onAdd((entity, sprite) => sprite.initialize(scene));
   * ```
   */
  public override onAdd(handler: (entity: Entity, c: InstanceType<T>) => void): this;
  public override onAdd(handler: (entity: Entity, c: ComponentInstance) => void): this;
  public override onAdd(handler: (entity: Entity, c: any) => void): this {
    super.onAdd(handler as (entity: Entity, c: ComponentInstance) => void);
    return this;
  }

  /**
   * Register a callback fired each time this component is **removed** from an
   * entity, or when the owning entity is destroyed.
   *
   * The handler is called with the owning entity and the component instance that
   * is about to be detached. Use it to clean up any external state associated
   * with the component.
   *
   * @param handler - Callback invoked with `(entity, componentInstance)`.
   * @returns This `Component` entity, for chaining.
   *
   * @example
   * ```ts
   * world.component(Sprite).onRemove((entity, sprite) => sprite.destroy(scene));
   * ```
   */
  public override onRemove(handler: (entity: Entity, c: InstanceType<T>) => void): this;
  public override onRemove(handler: (entity: Entity, c: ComponentInstance) => void): this;
  public override onRemove(handler: (entity: Entity, c: any) => void): this {
    super.onRemove(handler as (entity: Entity, c: ComponentInstance) => void);
    return this;
  }

  /**
   * Register a callback fired each time this component's data is **set or
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
   * @param handler - Callback invoked with `(entity, componentInstance)`.
   * @returns This `Component` entity, for chaining.
   *
   * @example
   * ```ts
   * world.component(Transform).onSet((entity, t) => renderer.syncTransform(entity.eid, t));
   * ```
   */
  public override onSet(handler: (entity: Entity, c: InstanceType<T>) => void): this;
  public override onSet(handler: (entity: Entity, c: ComponentInstance) => void): this;
  public override onSet(handler: (entity: Entity, c: any) => void): this {
    super.onSet(handler as (entity: Entity, c: ComponentInstance) => void);
    return this;
  }
}
