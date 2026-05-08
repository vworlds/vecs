import { BitPtr, Bitset } from "./util/bitset.js";
import type { Entity } from "./entity.js";
import { type World } from "./world.js";

/** A component instance. Components are plain objects created with a no-arg constructor. */
export type Component = object;

/** A component class constructor. */
export type ComponentClass<T extends Component = Component> = new () => T;

/** A component class constructor or its numeric type id. */
export type ComponentClassOrType = number | ComponentClass;

/**
 * Lifecycle hook for a registered component class. Obtained via
 * {@link World.hook}.
 *
 * Hooks are a lightweight alternative to building a {@link System} when all
 * you need is a callback on add / remove / set for a single component type.
 * The same `Hook` is returned on every call to `world.hook(C)`, so registration
 * methods chain:
 *
 * ```ts
 * world.hook(Sprite)
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
export interface Hook<C extends Component = Component> {
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
 * Bookkeeping record produced for each component class registered via
 * {@link World.registerComponent}.
 *
 * Holds the constructor, numeric type id, display name, and pre-computed
 * {@link BitPtr} used by archetype checks. Implements {@link Hook}, so the
 * lifecycle handlers attached via `world.hook(C)` are stored directly on the
 * meta object.
 */
export class ComponentMeta implements Hook<Component> {
  /** The component class constructor this meta represents. */
  public readonly Class: ComponentClass;
  /** Numeric type id assigned at registration time. */
  public readonly type: number;
  /** Human-readable name used in logs and serialization lookups. */
  public readonly componentName: string;
  /** Pre-computed bit-pointer into the entity archetype {@link Bitset}. */
  public readonly bitPtr: BitPtr;

  /**
   * @internal Peer metas of components that cannot coexist with this one on
   * the same entity. Set via {@link World.setExclusiveComponents}; `undefined`
   * means no restriction.
   */
  public _exclusive: ComponentMeta[] | undefined = undefined;

  /** @internal `onAdd` handlers, lazily allocated and prepended by {@link onAdd}. */
  public _onAddHandlers: ((entity: Entity, c: Component) => void)[] | undefined;
  /** @internal `onRemove` handlers, lazily allocated and prepended by {@link onRemove}. */
  public _onRemoveHandlers: ((entity: Entity, c: Component) => void)[] | undefined;
  /** @internal `onSet` handlers, lazily allocated and prepended by {@link onSet}. */
  public _onSetHandlers: ((entity: Entity, c: Component) => void)[] | undefined;

  constructor(Class: ComponentClass, type: number, componentName: string) {
    this.Class = Class;
    this.type = type;
    this.componentName = componentName;
    this.bitPtr = new BitPtr(type);
  }

  /** @inheritdoc */
  public onAdd(handler: (entity: Entity, c: Component) => void): ComponentMeta {
    (this._onAddHandlers ??= []).unshift(handler);
    return this;
  }

  /** @inheritdoc */
  public onRemove(handler: (entity: Entity, c: Component) => void): ComponentMeta {
    (this._onRemoveHandlers ??= []).unshift(handler);
    return this;
  }

  /** @inheritdoc */
  public onSet(handler: (entity: Entity, c: Component) => void): ComponentMeta {
    (this._onSetHandlers ??= []).unshift(handler);
    return this;
  }
}

/**
 * An array of component classes or numeric type ids, used by query helpers.
 *
 * @internal
 */
export type ComponentClassArray = ComponentClassOrType[];

/**
 * Compute a {@link Bitset} with one bit set for every component class or
 * numeric type id in `classes`.
 *
 * @internal Used to build archetype masks for `HAS` / `HAS_ONLY` queries.
 *
 * @param classes - Component classes or type ids to include.
 * @param world - World used to resolve classes to type ids.
 */
export function _calculateComponentBitmask(classes: ComponentClassArray, world: World): Bitset {
  const bitmask = new Bitset();
  classes.forEach((C) => {
    bitmask.add(world.getComponentType(C));
  });
  return bitmask;
}
