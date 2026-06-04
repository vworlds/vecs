import { BitPtr } from "./util/bitset.js";
import type { Entity, EntityClass } from "./entity/index.js";

export enum CleanupPolicy {
  Throw = "throw",
  Remove = "remove",
  Delete = "delete",
}

/** Base class for relationship components that point at another entity. */
export abstract class Relationship {
  public target!: Entity;
}

/** A component instance. Components are plain objects created with a no-arg constructor. */
export type ComponentInstance = object;

/** A component constructor used as a component key. */
export type ComponentType<T extends ComponentInstance = ComponentInstance> = new (
  ...args: any[]
) => T;

/** A component class constructor that can be instantiated by entity.add/set. */
export type ComponentClass<T extends ComponentInstance = ComponentInstance> = new () => T;

/** A component class constructor, component eid, or entity component key. */
export type ComponentRef = number | ComponentType | EntityClass | Entity;

/**
 * Lifecycle hook for a registered component class. Exposed by
 * {@link World.component}.
 *
 * Hooks are a lightweight alternative to building a {@link System} when all
 * you need is a callback on add / remove / set for a single component type.
 * Component entities expose the same registration methods, so calls chain:
 *
 * ```ts
 * world.component(Sprite)
 *   .onAdd((e, c) => initSprite(e, c))
 *   .onRemove((e, c) => destroySprite(e, c))
 *   .onSet((e, c) => syncSprite(e, c));
 * ```
 *
 * Callbacks fire synchronously when the corresponding entity command is
 * applied: inline outside deferred mode, or while the world drains its command
 * queue inside a system / `forEach` / `defer` block.
 *
 * @typeParam C - Component class this hook is bound to.
 */
export interface Hook<C extends ComponentInstance = ComponentInstance> {
  /**
   * Register a handler invoked when a component of this type is first attached
   * to an entity (`entity.add(C)` or `entity.set(C, ...)` on an entity that
   * does not yet have the component).
   *
   * @param handler - Receives the entity and freshly created component instance.
   * @returns This hook, for chaining.
   */
  onAdd(handler: (entity: Entity, c: C) => void): Hook<C>;

  /**
   * Register a handler invoked when a component of this type is removed from
   * an entity (explicit `entity.remove(C)` or implicit removal during
   * `entity.destroy()`).
   *
   * @param handler - Receives the entity and component instance that was removed.
   * @returns This hook, for chaining.
   */
  onRemove(handler: (entity: Entity, c: C) => void): Hook<C>;

  /**
   * Register a handler invoked when a component's data has been marked as
   * changed (`entity.modified(C)`), and when
   * `entity.set(C, props)` is called on an entity that already has the
   * component.
   *
   * @param handler - Receives the entity and component instance whose data changed.
   * @returns This hook, for chaining.
   */
  onSet(handler: (entity: Entity, c: C) => void): Hook<C>;
}

/**
 * Bookkeeping record produced for each component eid.
 *
 * Holds the constructor, component eid, and pre-computed
 * {@link BitPtr} used by archetype checks. Implements {@link Hook}, so the
 * lifecycle handlers attached via `world.component(C)` are stored directly on
 * the meta object.
 */
export class ComponentMeta implements Hook<ComponentInstance> {
  /** The component class constructor this meta represents. */
  public readonly Class: ComponentType;
  /** Component entity id assigned at registration time. */
  public readonly eid: number;
  /** Pre-computed bit-pointer into the entity archetype {@link Bitset}. */
  public readonly bitPtr: BitPtr;
  /** Whether this component is a relationship pointing at another entity. */
  public readonly isRelationship: boolean;

  /** Applied to entities carrying this component when this component entity is deleted. */
  public onDelete = CleanupPolicy.Throw;
  /** Applied to entities targeting a deleted entity through this relationship. */
  public onDeleteTarget = CleanupPolicy.Remove;

  /**
   * @internal Peer metas of components that cannot coexist with this one on
   * the same entity. Set via {@link World.setExclusiveComponents}; `undefined`
   * means no restriction.
   */
  public _exclusive: ComponentMeta[] | undefined = undefined;

  /** @internal `onAdd` handlers, lazily allocated and prepended by {@link onAdd}. */
  public _onAddHandlers: ((entity: Entity, c: ComponentInstance) => void)[] | undefined;
  /** @internal `onRemove` handlers, lazily allocated and prepended by {@link onRemove}. */
  public _onRemoveHandlers: ((entity: Entity, c: ComponentInstance) => void)[] | undefined;
  /** @internal `onSet` handlers, lazily allocated and prepended by {@link onSet}. */
  public _onSetHandlers: ((entity: Entity, c: ComponentInstance) => void)[] | undefined;

  private _usageCount = 0;

  constructor(Class: ComponentType, eid: number) {
    this.Class = Class;
    this.eid = eid;
    this.bitPtr = new BitPtr(eid);
    this.isRelationship = Class.prototype instanceof Relationship;
  }

  /** Number of entities currently carrying this component eid. */
  public get usageCount(): number {
    return this._usageCount;
  }

  /** @internal */
  public _incrementUsage(): void {
    this._usageCount++;
  }

  /** @internal */
  public _decrementUsage(): void {
    if (this._usageCount > 0) {
      this._usageCount--;
    }
  }

  /** @inheritdoc */
  public onAdd<T extends ComponentInstance>(
    handler: (entity: Entity, c: T) => void
  ): ComponentMeta {
    (this._onAddHandlers ??= []).unshift(handler as any);
    return this;
  }

  /** @inheritdoc */
  public onRemove<T extends ComponentInstance>(
    handler: (entity: Entity, c: T) => void
  ): ComponentMeta {
    (this._onRemoveHandlers ??= []).unshift(handler as any);
    return this;
  }

  /** @inheritdoc */
  public onSet<T extends ComponentInstance>(
    handler: (entity: Entity, c: T) => void
  ): ComponentMeta {
    (this._onSetHandlers ??= []).unshift(handler as any);
    return this;
  }
}

/**
 * An array of component classes or numeric type ids, used by query helpers.
 *
 * @internal
 */
export type ComponentRefArray = ComponentRef[];
