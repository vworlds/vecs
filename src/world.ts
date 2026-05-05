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
 * Command kinds emitted by {@link Entity} and routed by {@link World}.
 *
 * Commands are produced by `entity.add` / `entity.set` / `entity.remove` /
 * `entity.destroy` (and `Component.modified`). In deferred mode they are
 * pushed onto the world's command queue and processed at well-defined
 * boundaries (after each system run, on `flush()`, on the next `runPhase`,
 * etc.). Outside deferred mode they execute inline.
 *
 * @internal
 */
export type Command =
  | { kind: "CreateEntity"; entity: Entity }
  | {
      kind: "Set";
      entity: Entity;
      type: number;
      /** Properties to assign. `undefined` for `entity.add(C)` (ensure-exists, no data). */
      props: Partial<Component> | undefined;
    }
  | { kind: "Modified"; entity: Entity; type: number }
  | { kind: "Remove"; entity: Entity; type: number }
  | { kind: "Destroy"; entity: Entity };

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
  private allQueries: Query[] = [];

  private Class2Meta = new Map<typeof Component, ComponentMeta>();
  private Type2Meta = new ArrayMap<ComponentMeta>();
  private localComponentCounter = LOCAL_COMPONENT_MIN;
  private componentRegistrationDisabled = false;

  /** @internal Single ordered command queue used in deferred mode. */
  private commandQueue: Command[] = [];
  /** @internal Nested `beginDeferred` / `endDeferred` count. */
  private deferredDepth = 0;
  /** @internal True while `processCommandQueue` is iterating, to avoid re-entrant drains. */
  private draining = false;

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
      this.dispatch({ kind: "CreateEntity", entity: e });
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
   * Enter deferred mode. Mutations made until the matching {@link endDeferred}
   * are queued instead of executing inline.
   *
   * Nested begin/end pairs are allowed; only the outermost `endDeferred`
   * triggers a drain.
   *
   * @internal Used by `System._run`, `Query.forEach`, and `Filter.forEach` to
   * isolate iteration from in-flight mutations.
   */
  public beginDeferred(): void {
    this.deferredDepth++;
  }

  /**
   * Leave deferred mode. When the depth returns to zero, the world processes
   * the command queue (firing hooks and routing enter / exit / update events).
   *
   * @internal Pair with {@link beginDeferred}.
   */
  public endDeferred(): void {
    this.deferredDepth--;
    if (this.deferredDepth === 0) {
      this.processCommandQueue();
    }
  }

  /**
   * Drain any pending commands queued at the top level (depth 0).
   *
   * Useful between phases or after batch-loading network snapshots, to make
   * accumulated mutations visible (fire hooks, route enter/exit/update) before
   * the next read or system run.
   */
  public flush(): void {
    if (this.deferredDepth === 0) {
      this.processCommandQueue();
    }
  }

  /**
   * @internal Submit a command. In deferred mode it is appended to the
   * command queue; otherwise it is executed inline.
   */
  public dispatch(cmd: Command): void {
    if (this.deferredDepth > 0 || this.draining) {
      this.commandQueue.push(cmd);
    } else {
      this.executeCommand(cmd);
    }
  }

  /**
   * @internal Walk the command queue in insertion order, executing each
   * command. Callbacks may push more commands, which are processed in the
   * same pass via index iteration.
   */
  private processCommandQueue(): void {
    if (this.draining) {
      return;
    }
    if (this.commandQueue.length === 0) {
      return;
    }
    this.draining = true;
    try {
      for (let i = 0; i < this.commandQueue.length; i++) {
        this.executeCommand(this.commandQueue[i]);
      }
      this.commandQueue.length = 0;
    } finally {
      this.draining = false;
    }
  }

  /**
   * @internal Run a single command's side effects: data-layer mutation, hook
   * firing, and routing to all registered queries / systems.
   */
  private executeCommand(cmd: Command): void {
    switch (cmd.kind) {
      case "CreateEntity":
        this.entities.set(cmd.entity.eid, cmd.entity);
        return;
      case "Set":
        this.executeSet(cmd.entity, cmd.type, cmd.props);
        return;
      case "Modified":
        this.executeModified(cmd.entity, cmd.type);
        return;
      case "Remove":
        this.executeRemove(cmd.entity, cmd.type);
        return;
      case "Destroy":
        this.executeDestroy(cmd.entity);
        return;
    }
  }

  private _updateEntityQueries(entity: Entity) {
    this.allQueries.forEach((q) => {
      const belongs = q.belongs(entity);
      const isInQuery = entity.isInQuery(q);

      if (belongs !== isInQuery) {
        belongs ? q._enter(entity) : q._exit(entity);
      }
    });
  }

  /**
   * Internal helper: create + install a component on an entity, fire onAdd,
   * and route enter events. Used by `executeSet`'s
   * create-if-missing path. Caller is responsible for applying any props
   * before installation if the props should be visible to query predicates
   * (e.g. ordered-set comparators).
   */
  private installComponent(entity: Entity, type: number, props: Partial<Component> | undefined) {
    const meta = this.getComponentMeta(type);

    // Exclusive components: synchronously remove any conflicting type so that
    // onRemove(displaced) fires before onAdd(new).
    if (meta.exclusive) {
      for (const exclusiveType of meta.exclusive) {
        if (entity._hasComponentType(exclusiveType)) {
          this.executeRemove(entity, exclusiveType);
        }
      }
    }

    const c = new meta.Class(entity, meta);
    if (props !== undefined) {
      Object.assign(c, props);
    }
    entity._installComponent(type, c);

    if (meta._onAddHandler) {
      meta._onAddHandler(c);
    }

    this._updateEntityQueries(entity);

    return c;
  }

  private executeSet(entity: Entity, type: number, props: Partial<Component> | undefined): void {
    if (entity._destroyed) {
      return;
    }
    let c = entity._getInstalledComponent(type);
    const isNew = c === undefined;
    c = isNew ? this.installComponent(entity, type, props) : c!;

    if (props !== undefined) {
      if (!isNew) {
        Object.assign(c, props);
      }
      c.meta._onSetHandler?.(c);
      c._dirty = false;
      if (!isNew) {
        entity._forEachQuery((q) => q.notifyModified(c!));
      }
    }
    // entity.add on an existing component → no-op (idempotent ensure-exists).
  }

  private executeModified(entity: Entity, type: number): void {
    if (entity._destroyed) {
      return;
    }
    const c = entity._getInstalledComponent(type);
    if (!c) {
      return; // stale reference — component was removed
    }
    if (c.meta._onSetHandler) {
      c.meta._onSetHandler(c);
    }
    c._dirty = false;
    entity._forEachQuery((q) => {
      q.notifyModified(c);
    });
  }

  private executeRemove(entity: Entity, type: number): void {
    if (entity._destroyed) {
      return;
    }
    const c = entity._getInstalledComponent(type);
    if (!c) {
      return;
    }
    // Clear the bitmask first so q.belongs() returns false during exit routing,
    // but leave the component in entity.components so exit callbacks and the
    // sort comparator can still read it via entity.get(C).
    entity.componentBitmask.delete(type);

    this._updateEntityQueries(entity);
    // Remove from components after exits have fired.
    entity._removeInstalledComponent(type);

    // onRemove hook fires last.
    const meta = c.meta;
    if (meta._onRemoveHandler) {
      meta._onRemoveHandler(c);
    }
  }

  private executeDestroy(entity: Entity): void {
    if (entity._destroyed) {
      return;
    }

    // 1. Fire exit on every query the entity belongs to.
    const queries: Query[] = [];
    entity._forEachQuery((q) => queries.push(q));
    queries.forEach((q) => {
      if (q.world) {
        q._exit(entity);
      }
    });

    // 2. Fire onRemove on every still-attached component.
    entity._forEachInstalledComponent((c) => c.meta._onRemoveHandler?.(c));

    // 3. Emit the destroy event.
    if (entity._events) {
      entity._events.emit("destroy");
      entity._events.removeAllListeners("destroy");
    }

    // 4. Mark the entity destroyed and unhook from world / parent.
    entity._destroyed = true;
    this.entities.delete(entity.eid);

    if (entity.parent) {
      entity.parent.children.delete(entity);
      // The parent may match `{ PARENT: ... }` queries that depend on this
      // child's archetype — but since we don't change parent's bitmask here,
      // there's no archetype change to dispatch. Existing code didn't either.
      entity.parent = undefined;
    }
  }

  /** @internal */
  public _notifyEntityDestroyed(e: Entity) {
    this.dispatch({ kind: "Destroy", entity: e });
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
   * Pending top-level mutations are drained at the start of the phase so the
   * first system observes a consistent world. Each system's body runs in a
   * deferred scope; mutations made by callbacks are appended to the world
   * queue and processed by the world after the system returns, before the
   * next system runs.
   *
   * @param phase - The {@link IPhase} to run (returned by {@link addPhase}).
   * @param now - Absolute timestamp in milliseconds (e.g. `Date.now()`).
   * @param delta - Milliseconds elapsed since the previous tick.
   */
  public runPhase(phase: IPhase, now: number, delta: number) {
    this.flush();
    (phase as Phase).systems.forEach((s) => {
      s._run(now, delta);
      // System._run wraps in begin/end which drains on return; nothing more
      // to do here.
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
    this.flush();
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
    this.flush();
  }
}
