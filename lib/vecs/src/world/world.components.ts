import {
  Component,
  type ComponentClass,
  type ComponentInstance,
  type ComponentMeta,
  type ComponentType,
  type HookEvent,
} from "../component.js";
import { ComponentDef, Trait } from "../component_def.js";
import { Relationship, _slotHandlers } from "../component_meta.js";
import { Entity, type EID, type EntityClass } from "../entity/index.js";
import {
  _defaultNormalize,
  _defaultValidate,
  _hasDefaultChecks,
  type ValidationResult,
} from "../reflection/defaults.js";
import { _ownDecoratedMembers } from "../reflection/decorators.js";
import { _attachVecsStruct } from "../reflection/component_members.js";
import { _classChain, _declareMembers } from "../reflection/vecs_struct.js";
import { type IdPool } from "../util/id_pool.js";
import { Entities } from "./world.entities.js";
import { type World } from "./world.js";

const RESERVED_EID = 0;

/** Hook events a class can implement as a static `vecs_<event>` method. */
const STATIC_HOOK_EVENTS: readonly HookEvent[] = [
  "add",
  "set",
  "remove",
  "targetAdd",
  "targetRemove",
  "validate",
  "normalize",
];

export class Components extends Entities {
  /**
   * Register a component class with this world, or look up a previously
   * registered component entity.
   *
   * On the first call with a given class, a new `Component` entity is created
   * and its id is drawn from the `"component"` id pool (1–899 by default).
   * Subsequent calls with the same class return the same entity. The same class
   * may be registered independently in multiple worlds.
   * Every registered definition carries the local-only `ComponentDef` tag.
   * A newly registered definition inherits the current scope parent immediately.
   * Scopes must be entered outside deferred mode. Existing lookups do not reparent it.
   *
   * On first registration the class's member decorators ({@link type},
   * {@link range}, …) are read into its {@link VecsStruct} definition, which
   * is attached to the component entity when the class declares any member.
   * Static `vecs_<event>` methods (`vecs_add`, `vecs_set`, `vecs_remove`,
   * `vecs_targetAdd`, `vecs_targetRemove`, `vecs_validate`, `vecs_normalize`)
   * are registered as hooks for `<event>`, ahead of hooks added with `.on(…)`.
   * A class without decorators or statics registers exactly as before.
   *
   * Pass an explicit numeric `ceid` to pin the component to a server-assigned
   * stable id instead of auto-allocating one.
   *
   * Passing a **string** resolves an already-registered component entity by
   * name (set via `world.component(C).name = "..."`). Throws if no entity with
   * that name exists or if the named entity is not a `Component` entity.
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

  /**
   * Check `component` with its class's `validate` hooks.
   *
   * Hooks run in registration order and the first failure is returned. When
   * the class has no explicit hook but declares ranges or integer member
   * types, a default hook is created on first use: it checks each such member
   * against its range and its type's bounds (for example `u8` is 0–255), that
   * integers are whole, and that an `enum` with `values` holds one of them. It
   * reads the live definition, inherited members included. A class with
   * neither ranges nor integer types is valid.
   *
   * Nothing calls this on `set`; call it where your code accepts external data.
   *
   * @param component - An instance of a class registered in this world.
   * @returns `true`, or the violations: one message or a list of them.
   * @throws When `component.constructor` is not registered in this world.
   */
  public validate(this: World, component: ComponentInstance): ValidationResult {
    const meta = this._reflectedMeta(component, "validate");
    if (meta._onValidate === undefined) {
      if (!_hasDefaultChecks(meta.Class)) {
        return true;
      }
      meta._onValidate = _defaultValidate(meta.Class);
      meta._validateIsDefault = true;
    }
    for (const hook of _slotHandlers(meta._onValidate)) {
      const result = hook(component);
      if (result !== true) {
        return result;
      }
    }
    return true;
  }

  /**
   * Return whether {@link validate} accepts `component`.
   *
   * @throws When `component.constructor` is not registered in this world.
   */
  public isValid(this: World, component: ComponentInstance): boolean {
    return this.validate(component) === true;
  }

  /**
   * Modify `component` in place with its class's `normalize` hooks, so it
   * becomes valid.
   *
   * Hooks run in registration order, each on the result of the previous one.
   * When the class has no explicit hook but declares ranges or integer member
   * types, a default hook is created on first use: it truncates integers and
   * clamps each such member to its range and its type's bounds. Values of the
   * wrong JavaScript type and `enum` values outside their `values` are left as
   * they are; `NaN` becomes `0` first.
   *
   * @param component - An instance of a class registered in this world.
   * @returns `component`, for chaining.
   * @throws When `component.constructor` is not registered in this world.
   */
  public normalize<C extends ComponentInstance>(this: World, component: C): C {
    const meta = this._reflectedMeta(component, "normalize");
    if (meta._onNormalize === undefined) {
      if (!_hasDefaultChecks(meta.Class)) {
        return component;
      }
      meta._onNormalize = _defaultNormalize(meta.Class);
      meta._normalizeIsDefault = true;
    }
    meta._onNormalize(component);
    return component;
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
    // Validate declarations before allocating an id, so a throw leaves no
    // half-registered class behind.
    for (const Class of _classChain(ComponentClass)) {
      _declareMembers(Class, _ownDecoratedMembers(Class));
    }
    const staticHooks = staticHooksOf(ComponentClass);
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
    for (const [event, hook] of staticHooks) {
      component.meta.on(event, hook as never);
    }
    // Publish the class before resolving core metadata: recursive registrations
    // find themselves, so bootstrap needs neither special ids nor a second pass.
    // Both metadata definitions exist before any module can claim their scope.
    this.component(ComponentDef);
    this.component(Trait);
    component.add(ComponentDef);
    _attachVecsStruct(component as unknown as Component);
    const parent = this._scope;
    if (parent !== undefined) {
      component.childOf(parent);
    }
    // Component-definition entities are first-class entities: notify so any
    // live world-rooted query/term picks them up reactively (reflection),
    // exactly like an ordinary `world.entity()`.
    this._notifyEntityCreated(component as unknown as Entity);
    return component;
  }

  /** Resolve the meta of a component instance's class for the reflection API. */
  private _reflectedMeta(this: World, component: ComponentInstance, api: string): ComponentMeta {
    const Class = (component as { constructor?: Function } | null)?.constructor;
    const registered = Class === undefined ? undefined : this._classRegistry.get(Class);
    if (registered === undefined) {
      throw new Error(
        `world.${api}: component class ${Class?.name || "<unknown>"} is not registered in this world`
      );
    }
    return registered.meta;
  }
}

/**
 * Collect a class's static `vecs_<event>` methods, bound to the class.
 *
 * @throws When a class that is not a relationship declares a `target*` static.
 */
function staticHooksOf(Class: ComponentType): [HookEvent, Function][] {
  const statics = Class as unknown as Record<string, unknown>;
  const hooks: [HookEvent, Function][] = [];
  for (const event of STATIC_HOOK_EVENTS) {
    const hook = statics[`vecs_${event}`];
    if (typeof hook !== "function") {
      continue;
    }
    if (event.startsWith("target") && !(Class.prototype instanceof Relationship)) {
      throw new Error(`"${event}" hooks can only be registered on a Relationship component`);
    }
    hooks.push([event, hook.bind(Class)]);
  }
  return hooks;
}
