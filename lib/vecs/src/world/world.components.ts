import { Component, type ComponentClass, type ComponentType } from "../component.js";
import { Entity, type EID, type EntityClass } from "../entity/index.js";
import { type IdPool } from "../util/id_pool.js";
import { Entities } from "./world.entities.js";
import { type World } from "./world.js";

const RESERVED_EID = 0;

export class Components extends Entities {
  /** @internal `true` once {@link start} or {@link disableComponentRegistration} has been called. */
  protected _componentRegistrationDisabled = false;

  /**
   * Register a component class with this world, or look up a previously
   * registered component entity.
   *
   * On the first call with a given class, a new `Component` entity is created
   * and its id is drawn from the `"component"` id pool (1–899 by default).
   * Subsequent calls with the same class return the same entity. The same class
   * may be registered independently in multiple worlds.
   *
   * Pass an explicit numeric `ceid` to pin the component to a server-assigned
   * stable id instead of auto-allocating one.
   *
   * Passing a **string** resolves an already-registered component entity by
   * name (set via `world.component(C).name = "..."`). Throws if no entity with
   * that name exists or if the named entity is not a `Component` entity.
   *
   * After {@link start} (or {@link disableComponentRegistration}), registering a
   * new class throws.
   *
   * @param ComponentClass - The component class to register or retrieve.
   * @param ceid - Optional explicit numeric component entity id.
   * @returns The `Component` entity for the given class.
   *
   * @example
   * ```ts
   * world.component(Position);               // register and auto-assign id
   * world.component(Position, 42);           // register with explicit id 42
   * const componentMeta = world.component(Position).meta; // access metadata
   * world.component(Position).name = "Position";
   * world.component("Position");             // look up by name
   * ```
   */
  public component<T extends ComponentType>(
    this: World,
    ComponentClass: T,
    ceid?: EID
  ): Component<T>;
  public component(this: World, name: string): Component;
  public component<T extends ComponentType>(
    this: World,
    ComponentClassOrName: T | string,
    ceid?: EID
  ): Component<T> {
    if (typeof ComponentClassOrName === "string") {
      const entity = this.entity(ComponentClassOrName);

      if (!(entity instanceof Component)) {
        throw new Error(`Entity named '${ComponentClassOrName}' is not a component entity`);
      }

      return entity as unknown as Component<T>;
    }

    return this._component<Component<T>>(Component, ComponentClassOrName, ceid);
  }

  /** Prevent any further calls to {@link component}. */
  public disableComponentRegistration(): void {
    this._componentRegistrationDisabled = true;
  }

  /**
   * Read the singleton data stored on the component entity for `Class`.
   *
   * This is a convenience shorthand for `world.component(Class).get(Class)`.
   * Use it when you store world-global state as a component on the component
   * entity itself (the Singleton pattern).
   *
   * @param Class - Registered component class.
   * @returns The component instance stored on the component entity, or
   *   `undefined` when none has been set.
   */
  public get<C extends ComponentClass>(
    this: World,
    Class: C
  ): Readonly<InstanceType<C>> | undefined {
    return this.component(Class).get(Class);
  }

  /**
   * Attach or update the singleton data stored on the component entity for `Class`.
   *
   * Shorthand for `world.component(Class).set(Class, props)`. Stores `props`
   * on the component entity itself so the data can be retrieved globally via
   * {@link get}.
   *
   * @param Class - Registered component class.
   * @param props - Properties to merge onto the component instance.
   * @returns The `Component` entity, for chaining.
   */
  public set<C extends ComponentClass>(
    this: World,
    Class: C,
    props: Partial<InstanceType<C>>
  ): Component<C> {
    return this.component(Class).set(Class, props);
  }

  /** Declare a group of mutually exclusive components. */
  public setExclusiveComponents(this: World, ...components: ComponentClass[]): void {
    const componentMetas = components.map((C) => this.entity(C).meta);
    for (let i = 0; i < componentMetas.length; i++) {
      componentMetas[i]._exclusive = componentMetas.filter((_, j) => j !== i);
    }
  }

  /** @internal Register a component-like entity in the requested id pool. */
  protected _component<T extends Entity>(
    this: World,
    Constructor: EntityClass<T>,
    ComponentClass: ComponentType,
    ceid?: EID,
    pool: IdPool = this._componentPool
  ): T {
    if (ceid === RESERVED_EID) {
      throw new Error(`Component eid ${ceid} is reserved`);
    }

    const existingComponent = this._classRegistry.get(ComponentClass) as T | undefined;
    if (existingComponent) {
      if (ceid === undefined || ceid === existingComponent.eid) {
        return existingComponent;
      }
      throw new Error(
        `Component class ${ComponentClass.name} is already registered with eid ${existingComponent.eid}`
      );
    }
    if (this._componentRegistrationDisabled) {
      throw new Error("World component registration is disabled");
    }
    if (ceid === undefined) {
      ceid = pool.alloc();
    } else {
      if (this._entities.has(ceid)) {
        throw new Error(`Entity id ${ceid} is already taken`);
      }
      this._reserveEid(ceid);
    }
    const component = new Constructor(this, ceid, ComponentClass);
    this._entities.set(ceid, component);
    this._classRegistry.set(ComponentClass, component);
    // Component-definition entities are first-class entities: notify so any
    // live world-rooted query/term picks them up reactively (reflection),
    // exactly like an ordinary `world.entity()`.
    this._notifyEntityCreated(component as unknown as Entity);
    return component;
  }
}
