import { BitPtr, Bitset } from "./util/bitset.js";
import type { Entity } from "./entity.js";
import { type World } from "./world.js";

/**
 * Lifecycle hook for a component type. Obtained via {@link World.hook}.
 *
 * Hooks let you react to component lifecycle events without building a full
 * {@link System}. Each call returns the same `Hook` so the methods can be
 * chained:
 *
 * ```ts
 * world.hook(Sprite)
 *   .onAdd(c  => initSprite(c))
 *   .onRemove(c => destroySprite(c))
 *   .onSet(c  => syncSprite(c));
 * ```
 *
 * Callbacks are invoked synchronously during {@link World.runPhase} when
 * archetype changes are flushed.
 *
 * @typeParam C - The `Component` subclass this hook is bound to.
 */
export interface Hook<C extends Component = Component> {
  /**
   * Register a callback that fires when a component of this type is added to
   * an entity.
   *
   * @param handler - Receives the newly created component instance.
   * @returns `this` for chaining.
   */
  onAdd(handler: (c: C) => void): Hook<C>;

  /**
   * Register a callback that fires when a component of this type is removed
   * from an entity (including when the entity is destroyed).
   *
   * @param handler - Receives the component instance being removed.
   * @returns `this` for chaining.
   */
  onRemove(handler: (c: C) => void): Hook<C>;

  /**
   * Register a callback that fires when {@link Component.modified} is called
   * on a component of this type.
   *
   * @param handler - Receives the component instance that changed.
   * @returns `this` for chaining.
   */
  onSet(handler: (c: C) => void): Hook<C>;
}

/**
 * Internal bookkeeping record for a registered component class.
 *
 * Every component class that is passed to {@link World.registerComponent} gets
 * a `ComponentMeta` that maps it to a numeric type id, a string name, and a
 * pre-computed {@link BitPtr} used for fast archetype checks.
 *
 * `ComponentMeta` also implements {@link Hook}, so you can attach lifecycle
 * callbacks directly on the meta object (as `World.hook()` returns it).
 */
export class ComponentMeta implements Hook<Component> {
  /** The component class constructor. */
  public readonly Class: typeof Component;
  /** Numeric type id assigned at registration time. */
  public readonly type: number;
  /** Human-readable name used in logs and serialization lookups. */
  public readonly componentName: string;
  /** Pre-computed bit-pointer into the entity archetype {@link Bitset}. */
  public readonly bitPtr: BitPtr;
  private onAddHandler: ((c: Component) => void) | undefined;
  private onRemoveHandler: ((c: Component) => void) | undefined;
  private onSetHandler: ((c: Component) => void) | undefined;
  /**
   * Type ids of components that cannot coexist with this one on the same entity.
   * Set via {@link World.setExclusiveComponents}. `undefined` means no restrictions.
   */
  public exclusive: number[] | undefined = undefined;

  constructor(Class: typeof Component, type: number, componentName: string) {
    this.Class = Class;
    this.type = type;
    this.componentName = componentName;
    this.bitPtr = new BitPtr(type);
  }

  /** @inheritdoc */
  public onAdd(handler: (c: Component) => void): ComponentMeta {
    this.onAddHandler = handler;
    return this;
  }

  /** @inheritdoc */
  public onRemove(handler: (c: Component) => void): ComponentMeta {
    this.onRemoveHandler = handler;
    return this;
  }

  /** @inheritdoc */
  public onSet(handler: (c: Component) => void): ComponentMeta {
    this.onSetHandler = handler;
    return this;
  }
}

/** A component class constructor or its numeric type id. */
export type ComponentClassOrType = number | typeof Component;

/** An array of component class constructors or type ids. */
export type ComponentClassArray = ComponentClassOrType[];

/**
 * Base class for all ECS components.
 *
 * Extend this class to define data that can be attached to an {@link Entity}:
 *
 * ```ts
 * class Position extends Component {
 *   x = 0;
 *   y = 0;
 * }
 *
 * world.registerComponent(Position);
 * const pos = entity.add(Position);
 * pos.x = 100;
 * pos.modified(); // notify watching systems
 * ```
 *
 * A component instance is always bound to a single entity and is created by
 * the world when {@link Entity.add} is called.
 */
export class Component {
  private dirty: boolean = false;

  constructor(
    /** The entity this component belongs to. */
    public readonly entity: Entity,
    /** Registration metadata (type id, name, bit-pointer). */
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
   * Queues the component for delivery to all {@link System.update} callbacks
   * that watch this component type. Call this after mutating the component's
   * fields to ensure systems react to the new values.
   */
  public modified() {
    this.entity.world._queueUpdatedComponent(this);
  }

  /** Returns the component's registered name, e.g. `"Position"`. */
  public toString(): string {
    return this.meta.componentName;
  }
}

/**
 * Compute a {@link Bitset} that has a bit set for every component class or
 * type id in `classes`.
 *
 * @internal Used internally to build archetype masks for system queries.
 */
export function calculateComponentBitmask(
  classes: ComponentClassArray,
  world: World
) {
  const bitmask = new Bitset();
  classes.forEach((C) => {
    bitmask.add(world.getComponentType(C));
  });
  return bitmask;
}
