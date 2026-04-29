import { Component, ComponentClassOrType, ComponentMeta, Hook } from "./component.js";
import { Entity } from "./entity.js";
import { Query } from "./query.js";
import { System } from "./system.js";
import { Filter } from "./filter.js";
import { type QueryDSL, type ExtractRequired } from "./dsl.js";
import { ArrayMap } from "./util/array_map.js";
import { IPhase, Phase } from "./phase.js";

const LOCAL_COMPONENT_MIN = 256;

/**
 * The central ECS container.
 *
 * A `World` owns all entities, components, systems, queries, and the update
 * pipeline. Typical lifecycle:
 *
 * 1. **Register components** — call {@link registerComponent} (and optionally
 *    {@link registerComponentType}) for every component class.
 * 2. **Register systems and queries** — call {@link system} and {@link query}
 *    to create and configure them.
 * 3. **Start** — call {@link start} to freeze component registration and
 *    distribute systems into their phases.
 * 4. **Run loop** — call {@link runPhase} once per frame for each phase.
 *
 * ```ts
 * const world = new World();
 *
 * world.registerComponent(Position);
 * world.registerComponent(Velocity);
 *
 * world.system("Move")
 *   .requires(Position, Velocity)
 *   .update(Position, (pos) => { pos.x += vel.x; });
 *
 * world.start();
 *
 * // game loop:
 * world.runPhase(updatePhase, Date.now(), 16);
 * ```
 */
export class World {
  private entities = new Map<number, Entity>(); // maps entity Id to Entity
  private componentNameTypeMap = new Map<string, number>();
  private archChangeQueue: Entity[] = [];
  private destroyedEntities: Entity[] = [];
  private allQueries: Query[] = [];

  private Class2Meta = new Map<typeof Component, ComponentMeta>();
  private Type2Meta = new ArrayMap<ComponentMeta>();
  private updatedComponents: Component[] = [];
  private localComponentCounter = LOCAL_COMPONENT_MIN;
  private componentRegistrationDisabled = false;
  /** @internal */
  public _pipeline = new Map<string, Phase>();
  private eidCounter = 0;
  constructor() {}

  /**
   * Return the entity with id `eid`, creating it if it does not yet exist.
   *
   * Used by networking code to materialise server-assigned entities:
   *
   * ```ts
   * const e = world.getOrCreateEntity(snapshot.eid, (e) => {
   *   networkEntities.add(e);
   * });
   * e.add(snapshot.type, false);
   * ```
   *
   * @param eid - The entity id to look up or create.
   * @param onCreateCallback - Optional callback invoked only when a **new**
   *   entity is created, before it is returned. Use this to initialise
   *   bookkeeping (e.g. tracking it in a local set).
   * @returns The existing or newly created entity.
   */
  public getOrCreateEntity(eid: number, onCreateCallback?: (e: Entity) => void) {
    let e = this.entities.get(eid);
    if (!e) {
      e = new Entity(this, eid);
      this.entities.set(eid, e);
      if (onCreateCallback) {
        onCreateCallback(e);
      }
    }
    return e;
  }

  /**
   * Create a new entity with an auto-assigned id and register it in the world.
   *
   * The id counter starts at 0 (or at the value set by
   * {@link setEntityIdRange}) and increments by one for each call.
   */
  public entity(): Entity;

  /**
   * Look up an entity by id.
   *
   * @param id - Numeric entity id.
   * @returns The entity, or `undefined` if no entity with that id exists.
   */
  public entity(id: number): Entity | undefined;

  public entity(id?: number): Entity | undefined {
    if (id === undefined) {
      const eid = this.eidCounter++;
      const e = new Entity(this, eid);
      this.entities.set(eid, e);
      return e;
    }
    return this.entities.get(id);
  }

  /**
   * Set the starting value for the auto-incrementing entity id counter.
   *
   * Must be called **before** {@link start} (or
   * {@link disableComponentRegistration}). Useful when the world runs alongside
   * a server that owns a different id range — for example, locally-created
   * client entities can start at a high offset to avoid collisions with
   * server-assigned ids.
   *
   * @param min - The first id that will be assigned by {@link entity}.
   * @throws If called after registration has been disabled.
   */
  public setEntityIdRange(min: number) {
    if (this.componentRegistrationDisabled) {
      throw "setEntityIdRange must be called before component registration is disabled";
    }
    this.eidCounter = min;
  }

  /**
   * Retrieve the {@link ComponentMeta} record for a registered component.
   *
   * @param typeOrClass - A component class constructor or a numeric type id.
   * @returns The corresponding `ComponentMeta`.
   * @throws If no component with that class or type id has been registered.
   */
  public getComponentMeta(typeOrClass: ComponentClassOrType) {
    let meta: ComponentMeta | undefined;
    if (typeof typeOrClass === "function") {
      meta = this.Class2Meta.get(typeOrClass);
    } else {
      meta = this.Type2Meta.get(typeOrClass);
    }
    if (!meta) {
      throw `unregistered component meta for component type or class '${typeOrClass}'`;
    }
    return meta;
  }

  /**
   * Resolve a component class or type id to its numeric type id.
   *
   * @param typeOrClass - A component class constructor or a numeric type id.
   * @returns The numeric type id.
   */
  public getComponentType(typeOrClass: ComponentClassOrType) {
    if (typeof typeOrClass === "function") {
      return this.getComponentMeta(typeOrClass).type;
    }
    return typeOrClass;
  }

  /**
   * Mark an entity's archetype as changed, queuing it for re-evaluation
   * against all system queries at the end of the current system run.
   *
   * Also recursively marks all children as changed so that `{ PARENT: ... }`
   * queries are re-evaluated.
   *
   * @internal Called automatically by {@link Entity.add} and
   * {@link Entity.remove}.
   */
  public archetypeChanged(e: Entity) {
    if (e._archetypeChanged) {
      return;
    }
    e._archetypeChanged = true;
    this.archChangeQueue.push(e);
    e.children.forEach((child) => this.archetypeChanged(child));
  }

  /** @internal */
  public _notifyComponentAdded(e: Entity, c: Component) {
    this.archetypeChanged(e);
  }

  /** @internal */
  public _notifyComponentRemoved(e: Entity, c: Component) {
    const hook = c.meta._onRemoveHandler;
    if (hook) {
      hook(c);
    }

    this.archetypeChanged(e);
  }

  /** @internal */
  public _notifyEntityDestroyed(e: Entity) {
    if (!this.entities.delete(e.eid)) {
      return;
    }
    e.forEachComponent((c) => {
      e.remove(c.type);
    });
    this.destroyedEntities.push(e);
  }

  private updateArchetypes() {
    if (this.archChangeQueue.length > 0) {
      this.allQueries.forEach((q) => {
        this.archChangeQueue.forEach((e) => {
          if (q.belongs(e)) {
            e._addQuery(q);
          } else {
            e._removeQuery(q);
          }
        });
      });
      this.archChangeQueue.forEach((e) => {
        e.clearDeletedComponents();
      });
    }

    if (this.destroyedEntities.length > 0) {
      this.destroyedEntities.forEach((e) => {
        e._destroy();
      });
      this.destroyedEntities.length = 0;
    }

    if (this.updatedComponents.length > 0) {
      this.updatedComponents.forEach((c) => {
        const hook = c.meta._onSetHandler;
        if (hook) {
          hook(c);
        }
        c.entity._notifyModified(c);
        c._dirty = false;
      });
      this.updatedComponents.length = 0;
    }

    if (this.archChangeQueue.length > 0) {
      this.archChangeQueue.forEach((e) => {
        e._updateQueries();
        e._archetypeChanged = false;
      });
      this.archChangeQueue.length = 0;
    }
  }

  /** @internal Queues a component for onSet / update delivery. */
  public _queueUpdatedComponent(c: Component) {
    if (c._dirty) {
      return;
    }
    c._dirty = true;
    this.updatedComponents.push(c);
  }

  /**
   * Register a component class with the world.
   *
   * Must be called before any entity can use the component. Registration is
   * disabled once {@link start} is called.
   *
   * **Overloads:**
   * - `registerComponent(Class)` — type id auto-assigned from the name map, or
   *   from a local counter (≥ 256) if the name is not yet mapped.
   * - `registerComponent(Class, type)` — explicit numeric type id.
   * - `registerComponent(Class, componentName)` — auto-assigned id, custom
   *   display name (useful when the class name differs from the network name).
   * - `registerComponent(Class, type, componentName)` — explicit id + name.
   *
   * @param ComponentClass - The component class to register.
   * @throws If the class has already been registered, or if registration is
   *   disabled.
   */
  public registerComponent(ComponentClass: typeof Component): void;
  public registerComponent(ComponentClass: typeof Component, type: number): void;
  public registerComponent(ComponentClass: typeof Component, componentName?: string): void;
  public registerComponent(
    ComponentClass: typeof Component,
    type: number,
    componentName: string
  ): void;
  public registerComponent(
    ComponentClass: typeof Component,
    typeOrComponentName?: number | string,
    componentName?: string
  ): void {
    if (this.componentRegistrationDisabled) {
      throw "World component registartion is disabled";
    }
    let type: number | undefined = undefined;

    // Determine if the second argument is type or componentName based on its type
    if (typeof typeOrComponentName === "number") {
      type = typeOrComponentName;
    } else if (typeof typeOrComponentName === "string") {
      componentName = typeOrComponentName;
    }

    componentName = componentName || ComponentClass.name;
    let local = false;
    if (type === undefined) {
      // attempt to get type id from name->type map
      type = this.componentNameTypeMap.get(componentName);
      if (type === undefined) {
        type = this.localComponentCounter++;
        local = true;
      }
    }

    let meta = this.Class2Meta.get(ComponentClass);
    if (meta) {
      if (local) {
        this.localComponentCounter--;
      }
      throw `Trying to register ${componentName} with type=${type} which is already registered to ${meta.componentName}`;
    }
    this.registerComponentType(componentName, type);
    meta = new ComponentMeta(ComponentClass, type, componentName);
    this.Class2Meta.set(ComponentClass, meta);
    this.Type2Meta.set(type, meta);
    console.log(
      "Registered component %s with type=%d as %s component",
      componentName,
      type,
      local ? "local" : "networked"
    );
  }

  /**
   * Pre-register a component name → type id mapping without associating a
   * class.
   *
   * Useful when network messages refer to components by type id and the
   * corresponding class may be registered later. Call this before
   * {@link registerComponent} to ensure the class picks up the server-assigned
   * id rather than a locally generated one.
   *
   * @param componentName - The string name used in network payloads.
   * @param type - The numeric type id assigned by the server.
   */
  public registerComponentType(componentName: string, type: number) {
    this.componentNameTypeMap.set(componentName, type);
  }

  /** @internal Called by the {@link Query} constructor to register itself. */
  public _addQuery(q: Query) {
    this.allQueries.push(q);
  }

  /** @internal Called by {@link Query.destroy} to unregister a query and remove it from all entities. */
  public _removeQuery(q: Query): void {
    const idx = this.allQueries.indexOf(q);
    if (idx !== -1) {
      this.allQueries.splice(idx, 1);
    }
    this.entities.forEach((e) => e._purgeQuery(q));
  }

  /** @internal Iterate over all entities currently in the world. */
  public _forEachEntity(callback: (e: Entity) => void): void {
    this.entities.forEach(callback);
  }

  /**
   * Create a new {@link System}, register it, and return it for configuration.
   *
   * ```ts
   * world.system("Render")
   *   .phase("update")
   *   .requires(Position, Sprite)
   *   .enter([Sprite], (e, [sprite]) => sprite.initialize(scene))
   *   .update(Position, (pos) => { ... });
   * ```
   *
   * @param name - A unique display name for the system.
   * @returns The new `System` instance.
   */
  public system(name: string) {
    return new System(name, this);
  }

  /**
   * Create a standalone {@link Query}, register it, and return it for
   * configuration.
   *
   * Unlike a {@link System}, a standalone query has no phase and no per-tick
   * callbacks — it is a reactive, always-updated entity set that can be read
   * at any time after {@link start}. Standalone queries can also be created
   * after {@link start}; existing matched entities are backfilled immediately.
   *
   * ```ts
   * const enemies = world.query("Enemies")
   *   .requires(Enemy, Health)
   *   .enter((e) => console.log("enemy spawned", e.eid));
   *
   * world.start();
   * // enemies.entities is kept up-to-date automatically
   * ```
   *
   * @param name - A unique display name for the query.
   * @returns The new `Query` instance.
   */
  public query(name: string) {
    return new Query(name, this);
  }

  /**
   * Create a non-reactive {@link Filter} that matches entities satisfying `q`.
   *
   * Unlike {@link query}, the returned filter holds no tracked entity set and
   * registers nothing with the world. Each call to {@link Filter.forEach} walks
   * all current world entities and invokes the callback for matching ones.
   *
   * Component classes guaranteed present on every matched entity are inferred
   * automatically from the DSL where possible (plain arrays, `HAS`, `HAS_ONLY`,
   * and `AND` of those forms). For cases the type extractor cannot see through
   * (`OR`, `NOT`, `PARENT`, custom `EntityTestFunc`), pass a `_guaranteed`
   * tuple as a type-level override:
   *
   * ```ts
   * // Auto-deduced — pos and vel are non-nullable
   * world.filter([Position, Velocity])
   *   .forEach([Position, Velocity], (e, [pos, vel]) => { ... });
   *
   * // Manual override for an opaque query
   * world.filter(myTestFunc, [Position])
   *   .forEach([Position], (e, [pos]) => pos.x);
   * ```
   *
   * @param q - A {@link QueryDSL} expression.
   * @param _guaranteed - Optional type hint declaring which components are
   *   guaranteed present (not validated at runtime).
   */
  public filter<Q extends QueryDSL>(q: Q): Filter<ExtractRequired<Q>>;
  public filter<T extends (typeof Component)[]>(
    q: QueryDSL,
    _guaranteed: readonly [...T]
  ): Filter<T>;
  public filter(q: QueryDSL, _guaranteed?: readonly (typeof Component)[]): Filter<any> {
    return new Filter(this, q);
  }

  /**
   * Prevent any further calls to {@link registerComponent}.
   *
   * Called automatically by {@link start}. Can be called early if you want to
   * lock component registration before systems are fully configured.
   */
  public disableComponentRegistration() {
    this.componentRegistrationDisabled = true;
  }

  /**
   * Freeze component registration and prepare the world for running.
   *
   * Distributes all systems registered so far into their pipeline phases
   * (defaulting to `"update"`) and logs the phase → system order to the
   * console. Systems and queries can still be created after this call —
   * standalone queries will immediately backfill existing matched entities.
   *
   * Call this once before the first {@link runPhase} call.
   */
  public start() {
    this.componentRegistrationDisabled = true;
    this.reindexSystems();
  }

  private reindexSystems() {
    let _defaultPhase = this._pipeline.get("update");
    if (!_defaultPhase) {
      _defaultPhase = new Phase("update", this);
      this._pipeline.set(_defaultPhase.name, _defaultPhase);
    }

    const defaultPhase = _defaultPhase;

    this.allQueries.forEach((q) => {
      if (!(q instanceof System)) {
        return;
      }
      let phase = q._phase as Phase | undefined;
      if (typeof phase === "string") {
        phase = this._pipeline.get(phase);
      }
      phase = phase || defaultPhase;
      phase.systems.push(q);
    });

    this._pipeline.forEach((phase) => {
      console.log("Phase %s : %s", phase.name, phase.systems.map((s) => s.name).join(" -> "));
    });
  }

  /**
   * Return the {@link Hook} for a component class.
   *
   * Hooks let you react to component lifecycle events (add / remove / set)
   * without building a full {@link System}. The hook is backed by the
   * component's {@link ComponentMeta} and the same object is returned on every
   * call.
   *
   * ```ts
   * world.hook(Sprite)
   *   .onAdd(c  => c.initialize(scene))
   *   .onRemove(c => c.destroy());
   * ```
   *
   * @param C - The component class.
   * @returns The `Hook` for that component type.
   */
  public hook<T extends typeof Component>(C: T): Hook<InstanceType<T>> {
    return this.getComponentMeta(C) as any;
  }

  /**
   * Add a named phase to the update pipeline and return it.
   *
   * Phases are executed in insertion order when you call {@link runPhase} for
   * each one. Systems are assigned to a phase via {@link System.phase}.
   *
   * ```ts
   * const preUpdate = world.addPhase("preupdate");
   * const update    = world.addPhase("update");
   * const send      = world.addPhase("send");
   * ```
   *
   * @param name - Unique phase name. Systems can reference it by this string.
   * @returns The new {@link IPhase}.
   */
  public addPhase(name: string): IPhase {
    const phase = new Phase(name, this);
    this._pipeline.set(name, phase);
    return phase;
  }

  /**
   * Execute all systems in the given phase for one tick.
   *
   * After each system runs, pending archetype changes (entity add/remove
   * component events) are flushed so that `enter` / `exit` callbacks are
   * delivered before the next system in the same phase executes.
   *
   * @param phase - The {@link IPhase} to run (returned by {@link addPhase}).
   * @param now - Absolute timestamp in milliseconds (e.g. `Date.now()`).
   * @param delta - Milliseconds elapsed since the previous tick.
   */
  public runPhase(phase: IPhase, now: number, delta: number) {
    (phase as Phase).systems.forEach((s) => {
      s._run(now, delta);
      this.updateArchetypes();
    });
  }

  /**
   * Run every phase in the pipeline in insertion order (the order phases were
   * registered via {@link addPhase}). Equivalent to calling
   * {@link runPhase} for each phase manually.
   *
   * @param now - Absolute timestamp in milliseconds (e.g. `Date.now()`).
   * @param delta - Milliseconds elapsed since the previous tick.
   */
  public progress(now: number, delta: number) {
    this.updateArchetypes();
    this._pipeline.forEach((phase) => {
      this.runPhase(phase, now, delta);
    });
  }

  /**
   * Declare a group of mutually exclusive components.
   *
   * After this call, adding any component in the group to an entity that
   * already has another component from the same group will remove the other component
   *
   * ```ts
   * world.setExclusiveComponents(Walking, Running, Idle);
   * // entity.add(Running) throws if entity already has Walking or Idle
   * ```
   *
   * @param components - Two or more component classes that cannot coexist.
   * @throws If any class has not been registered.
   */
  public setExclusiveComponents(...components: (typeof Component)[]): void {
    const types = components.map((C) => this.getComponentType(C));
    for (let i = 0; i < components.length; i++) {
      this.getComponentMeta(components[i]).exclusive = types.filter((_, j) => j !== i);
    }
  }

  /**
   * Destroy every entity currently tracked by the world.
   *
   * Triggers all `onRemove` hooks and `exit` callbacks. Useful when
   * transitioning between game sessions or resetting to a clean state.
   */
  public clearAllEntities() {
    this.entities.forEach((e) => {
      e.destroy();
    });
    this.entities.clear();
  }
}
