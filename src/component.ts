import { BitPtr, Bitset } from "./util/bitset.js";
import type { Entity } from "./entity.js";
import { type World } from "./world.js";

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
 *   .onAdd(c => initSprite(c))
 *   .onRemove(c => destroySprite(c))
 *   .onSet(c => syncSprite(c));
 * ```
 *
 * Callbacks fire synchronously when the corresponding entity command is
 * applied: inline outside deferred mode, or while the world drains its command
 * queue inside a system / `forEach` / `defer` block.
 *
 * @typeParam C - Component subclass this hook is bound to.
 */
export interface Hook<C extends Component = Component> {
  /**
   * Register a handler invoked when a component of this type is first attached
   * to an entity (`entity.add(C)` or `entity.set(C, ...)` on an entity that
   * does not yet have the component).
   *
   * @param handler - Receives the freshly created component instance.
   * @returns This hook, for chaining.
   */
  onAdd(handler: (c: C) => void): Hook<C>;

  /**
   * Register a handler invoked when a component of this type is removed from
   * an entity (explicit `entity.remove(C)` or implicit removal during
   * `entity.destroy()`).
   *
   * @param handler - Receives the component instance that was removed.
   * @returns This hook, for chaining.
   */
  onRemove(handler: (c: C) => void): Hook<C>;

  /**
   * Register a handler invoked when a component's data has been marked as
   * changed (`component.modified()` or `entity.modified(c)`), and when
   * `entity.set(C, props)` is called on an entity that already has the
   * component.
   *
   * @param handler - Receives the component instance whose data changed.
   * @returns This hook, for chaining.
   */
  onSet(handler: (c: C) => void): Hook<C>;
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
  public readonly Class: typeof Component;
  /** Numeric type id assigned at registration time. */
  public readonly type: number;
  /** Human-readable name used in logs and serialization lookups. */
  public readonly componentName: string;
  /** Pre-computed bit-pointer into the entity archetype {@link Bitset}. */
  public readonly bitPtr: BitPtr;

  /**
   * Type ids of components that cannot coexist with this one on the same
   * entity. Set via {@link World.setExclusiveComponents}; `undefined` means
   * no restriction.
   */
  public exclusive: number[] | undefined = undefined;

  /** @internal `onAdd` handlers, lazily allocated and prepended by {@link onAdd}. */
  public _onAddHandlers: ((c: Component) => void)[] | undefined;
  /** @internal `onRemove` handlers, lazily allocated and prepended by {@link onRemove}. */
  public _onRemoveHandlers: ((c: Component) => void)[] | undefined;
  /** @internal `onSet` handlers, lazily allocated and prepended by {@link onSet}. */
  public _onSetHandlers: ((c: Component) => void)[] | undefined;

  constructor(Class: typeof Component, type: number, componentName: string) {
    this.Class = Class;
    this.type = type;
    this.componentName = componentName;
    this.bitPtr = new BitPtr(type);
  }

  /** @inheritdoc */
  public onAdd(handler: (c: Component) => void): ComponentMeta {
    (this._onAddHandlers ??= []).unshift(handler);
    return this;
  }

  /** @inheritdoc */
  public onRemove(handler: (c: Component) => void): ComponentMeta {
    (this._onRemoveHandlers ??= []).unshift(handler);
    return this;
  }

  /** @inheritdoc */
  public onSet(handler: (c: Component) => void): ComponentMeta {
    (this._onSetHandlers ??= []).unshift(handler);
    return this;
  }
}

/** A component class constructor or its numeric type id. */
export type ComponentClassOrType = number | typeof Component;

/**
 * An array of component classes or numeric type ids, used by query helpers.
 *
 * @internal
 */
export type ComponentClassArray = ComponentClassOrType[];

/**
 * Base class for all ECS components.
 *
 * Subclass `Component` to declare data that can be attached to an
 * {@link Entity}. Instances are constructed by the world when
 * {@link Entity.add} or {@link Entity.set} runs — never instantiate manually.
 *
 * ```ts
 * class Position extends Component {
 *   x = 0;
 *   y = 0;
 * }
 *
 * world.registerComponent(Position);
 * entity.set(Position, { x: 100 });
 * ```
 *
 * Each instance is bound to a single entity via {@link entity}; that link is
 * permanent for the component's lifetime.
 */
export class Component {
  /** @internal Set by {@link Entity.modified} to coalesce repeated calls until the world routes the modified command. */
  public _dirty: boolean = false;

  constructor(
    /** The entity this component belongs to. */
    public readonly entity: Entity,
    /** Registration metadata (type id, display name, bit-pointer). */
    public readonly meta: ComponentMeta
  ) {}

  /** Numeric type id — shorthand for `this.meta.type`. */
  public get type(): number {
    return this.meta.type;
  }

  /** Pre-computed bit-pointer — shorthand for `this.meta.bitPtr`. */
  public get bitPtr(): BitPtr {
    return this.meta.bitPtr;
  }

  /**
   * Notify the world that this component's data has changed.
   *
   * Queues a modified event that fires `update` callbacks on every system /
   * query that watches this component type, plus the component's `onSet`
   * hook. Repeated calls before the world drains its queue are coalesced
   * into one delivery.
   */
  public modified(): void {
    this.entity.modified(this);
  }

  /** Returns the component's registered display name (e.g. `"Position"`). */
  public toString(): string {
    return this.meta.componentName;
  }
}

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
