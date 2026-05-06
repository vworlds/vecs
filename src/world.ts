import { Component, ComponentClassOrType, ComponentMeta, Hook } from "./component.js";
import { Entity } from "./entity.js";
import { Query } from "./query.js";
import { System } from "./system.js";
import { Filter } from "./filter.js";
import { type QueryDSL, type ExtractRequired } from "./dsl.js";
import { ArrayMap } from "./util/array_map.js";
import { IPhase, Phase } from "./phase.js";
import { CommandKind, type Command } from "./command.js";

/**
 * Numeric type ids below this value are reserved for components whose id was
 * pre-registered via {@link World.registerComponentType} (typically server
 * assigned). Auto-assigned ids start here.
 */
const LOCAL_COMPONENT_MIN = 256;

/**
 * The central ECS container. One world per game session.
 *
 * A `World` owns every entity, every registered component class, every
 * registered query / system, and the update pipeline. The typical lifecycle:
 *
 * 1. **Register components** — {@link registerComponent} (and optionally
 *    {@link registerComponentType}) for every component class you plan to use.
 * 2. **Build the pipeline** — {@link addPhase} for every named phase, then
 *    {@link system} / {@link query} for each processor.
 * 3. **Start** — call {@link start} to freeze component registration and
 *    distribute systems into their phases.
 * 4. **Run loop** — call {@link runPhase} per phase or {@link progress} for
 *    every phase, once per frame.
 *
 * ```ts
 * const world = new World();
 *
 * world.registerComponent(Position);
 * world.registerComponent(Velocity);
 *
 * world.system("Move")
 *   .requires(Position, Velocity)
 *   .each([Position, Velocity], (e, [pos, vel]) => {
 *     pos.x += vel.vx;
 *   });
 *
 * world.start();
 *
 * // game loop:
 * world.progress(now, delta);
 * ```
 *
 * ## Deferred mode
 *
 * The world can be in **deferred mode**, in which case entity mutations
 * (`add` / `set` / `remove` / `destroy` / `setParent` / `modified`) are
 * queued instead of applied inline. Systems run inside an automatically
 * deferred scope; user code can wrap arbitrary blocks with
 * {@link beginDefer} / {@link endDefer} or {@link defer}. {@link flush}
 * drains the queue at top level.
 */
export class World {
  /** @internal Entity id → entity. Owns every live entity. */
  private _entities = new Map<number, Entity>();
  /** @internal All registered queries, including systems (which extend `Query`). */
  private _queries: Query[] = [];

  /** @internal Component class → meta record. */
  private _Class2Meta = new Map<typeof Component, ComponentMeta>();
  /** @internal Component type id → meta record. */
  private _Type2Meta = new ArrayMap<ComponentMeta>();
  /** @internal Pre-registered name → type id mappings (server-assigned ids). */
  private _componentNameTypeMap = new Map<string, number>();
  /** @internal Counter used to auto-assign type ids for "local" components (≥ 256). */
  private _localComponentCounter = LOCAL_COMPONENT_MIN;
  /** @internal `true` once {@link start} (or {@link disableComponentRegistration}) has been called. */
  private _componentRegistrationDisabled = false;

  /** @internal Auto-incrementing entity id counter, seeded by {@link setEntityIdRange}. */
  private _eidCounter = 0;

  /** @internal Single ordered command queue used in deferred mode. */
  private _commandQueue: Command[] = [];
  /** @internal Nested {@link beginDefer} / {@link endDefer} count. */
  private _deferredDepth = 0;
  /** @internal `true` while {@link _processCommandQueue} is iterating, to avoid re-entrant drains. */
  private _draining = false;

  /** @internal Phase name → phase. Insertion-ordered, matches pipeline execution order. */
  public _pipeline = new Map<string, Phase>();

  constructor() {}

  /**
   * @internal Drain the top-level command queue: walk it in arrival order,
   * executing each command. Callbacks may push more commands; they are picked
   * up by index iteration in the same pass.
   */
  private _processCommandQueue(): void {
    if (this._draining) {
      return;
    }
    if (this._commandQueue.length === 0) {
      return;
    }
    this._draining = true;
    try {
      for (let i = 0; i < this._commandQueue.length; i++) {
        this._executeCommand(this._commandQueue[i]);
      }
      this._commandQueue.length = 0;
    } finally {
      this._draining = false;
    }
  }

  /**
   * @internal Run one command's side effects: data-layer mutation, hook
   * firing, and routing to every registered query / system.
   */
  private _executeCommand(cmd: Command): void {
    switch (cmd.kind) {
      case CommandKind.CreateEntity:
        this._entities.set(cmd.entity.eid, cmd.entity);
        return;
      case CommandKind.Set:
        cmd.entity._set(cmd.type, cmd.props);
        return;
      case CommandKind.Modified:
        cmd.entity._modified(cmd.type);
        return;
      case CommandKind.Remove:
        cmd.entity._remove(cmd.type);
        return;
      case CommandKind.Destroy:
        cmd.entity._destroy();
        return;
      case CommandKind.SetParent:
        cmd.entity._setParent(cmd.parent);
        return;
    }
  }

  /**
   * @internal Distribute every registered system into its phase's `systems`
   * list. Called by {@link start}; idempotent so it can be re-run if the
   * pipeline is rebuilt.
   */
  private _reindexSystems(): void {
    let _defaultPhase = this._pipeline.get("update");
    if (!_defaultPhase) {
      _defaultPhase = new Phase("update", this);
      this._pipeline.set(_defaultPhase.name, _defaultPhase);
    }

    const defaultPhase = _defaultPhase;

    this._queries.forEach((q) => {
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

  /** @internal Append a command to the deferred-mode queue. */
  public _enqueue(cmd: Command): void {
    this._commandQueue.push(cmd);
  }

  /** @internal Register a freshly created {@link Query} (called from its constructor). */
  public _addQuery(q: Query): void {
    this._queries.push(q);
  }

  /**
   * @internal Unregister a query and purge its membership from every entity.
   * Called by {@link Query.destroy}.
   */
  public _removeQuery(q: Query): void {
    const idx = this._queries.indexOf(q);
    if (idx !== -1) {
      this._queries.splice(idx, 1);
    }
    this._entities.forEach((e) => e._purgeQuery(q));
  }

  /** @internal Remove an entity from the world's entity map (called by `Entity._destroy`). */
  public _unregisterEntity(entity: Entity): void {
    this._entities.delete(entity.eid);
  }

  /** Read-only view of the live entities, keyed by entity id. */
  public get entities(): Omit<Map<number, Entity>, "set" | "delete" | "clear"> {
    return this._entities as any;
  }

  /** Read-only view of every registered query (includes systems). */
  public get queries(): ReadonlyArray<Query> {
    return this._queries;
  }

  /**
   * `true` while the world is in deferred mode — entity mutations are queued
   * rather than applied inline. Equivalent to "the queue depth is non-zero or
   * the world is currently draining".
   */
  public get deferred(): boolean {
    return this._deferredDepth > 0 || this._draining;
  }

  /**
   * Enter deferred mode. Mutations made until the matching {@link endDefer}
   * are queued instead of executing inline.
   *
   * Nested `beginDefer` / `endDefer` pairs are allowed; only the outermost
   * `endDefer` triggers a queue drain.
   */
  public beginDefer(): void {
    this._deferredDepth++;
  }

  /**
   * Leave deferred mode. When the depth returns to zero the world drains the
   * command queue (firing hooks and routing enter / exit / update events).
   */
  public endDefer(): void {
    this._deferredDepth--;
    this.flush();
  }

  /**
   * Run `fn` inside a deferred scope. Equivalent to
   * `beginDefer(); try { fn(); } finally { endDefer(); }`.
   *
   * @param fn - Callback executed in deferred mode.
   */
  public defer(fn: () => void): void {
    this.beginDefer();
    try {
      fn();
    } finally {
      this.endDefer();
    }
  }

  /**
   * Drain any commands queued at the top level (depth 0).
   *
   * Call between phases or after batch-loading network snapshots to surface
   * accumulated mutations (firing hooks and routing enter / exit / update)
   * before the next read or system run.
   */
  public flush(): void {
    if (this._deferredDepth === 0) {
      this._processCommandQueue();
    }
  }

  /**
   * Pre-register a `componentName → typeId` mapping without binding a class.
   *
   * Useful when network messages refer to components by type id and the
   * corresponding class may be registered later. Call this **before**
   * {@link registerComponent} so the class picks up the server-assigned id
   * rather than a locally generated one.
   *
   * @param componentName - String name used in network payloads.
   * @param type - Numeric type id assigned by the server.
   */
  public registerComponentType(componentName: string, type: number): void {
    this._componentNameTypeMap.set(componentName, type);
  }

  /**
   * Register a component class with the world.
   *
   * Must be called before any entity uses the component. Registration is
   * disabled once {@link start} (or {@link disableComponentRegistration}) is
   * called.
   *
   * **Overloads:**
   * - `registerComponent(Class)` — type id auto-assigned from the
   *   {@link registerComponentType} map, falling back to a local counter
   *   (≥ 256) if the name is not yet mapped.
   * - `registerComponent(Class, type)` — explicit numeric type id.
   * - `registerComponent(Class, componentName)` — auto-assigned id, custom
   *   display name (useful when the class name differs from the network name).
   * - `registerComponent(Class, type, componentName)` — explicit id + name.
   *
   * @param ComponentClass - Component class to register.
   * @throws When the class has already been registered or registration is
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
    if (this._componentRegistrationDisabled) {
      throw "World component registartion is disabled";
    }
    let type: number | undefined = undefined;

    if (typeof typeOrComponentName === "number") {
      type = typeOrComponentName;
    } else if (typeof typeOrComponentName === "string") {
      componentName = typeOrComponentName;
    }

    componentName = componentName || ComponentClass.name;
    let local = false;
    if (type === undefined) {
      type = this._componentNameTypeMap.get(componentName);
      if (type === undefined) {
        type = this._localComponentCounter++;
        local = true;
      }
    }

    let meta = this._Class2Meta.get(ComponentClass);
    if (meta) {
      if (local) {
        this._localComponentCounter--;
      }
      throw `Trying to register ${componentName} with type=${type} which is already registered to ${meta.componentName}`;
    }
    this.registerComponentType(componentName, type);
    meta = new ComponentMeta(ComponentClass, type, componentName);
    this._Class2Meta.set(ComponentClass, meta);
    this._Type2Meta.set(type, meta);
    console.log(
      "Registered component %s with type=%d as %s component",
      componentName,
      type,
      local ? "local" : "networked"
    );
  }

  /**
   * Look up the {@link ComponentMeta} for a registered component.
   *
   * @param typeOrClass - Component class or numeric type id.
   * @returns The corresponding meta record.
   * @throws When no component with that class or type id has been registered.
   */
  public getComponentMeta(typeOrClass: ComponentClassOrType): ComponentMeta {
    let meta: ComponentMeta | undefined;
    if (typeof typeOrClass === "function") {
      meta = this._Class2Meta.get(typeOrClass);
    } else {
      meta = this._Type2Meta.get(typeOrClass);
    }
    if (!meta) {
      throw `unregistered component meta for component type or class '${typeOrClass}'`;
    }
    return meta;
  }

  /**
   * Resolve a component class or type id to its numeric type id.
   *
   * @param typeOrClass - Component class or numeric type id.
   * @returns The numeric type id.
   */
  public getComponentType(typeOrClass: ComponentClassOrType): number {
    if (typeof typeOrClass === "function") {
      return this.getComponentMeta(typeOrClass).type;
    }
    return typeOrClass;
  }

  /**
   * Return the {@link Hook} for a component class.
   *
   * Hooks let you react to component lifecycle events (add / remove / set)
   * without building a full {@link System}. The same hook is returned on every
   * call — handlers stack on the underlying meta record.
   *
   * ```ts
   * world.hook(Sprite)
   *   .onAdd(c => c.initialize(scene))
   *   .onRemove(c => c.destroy());
   * ```
   *
   * @param C - Component class.
   * @returns The hook bound to that component type.
   */
  public hook<T extends typeof Component>(C: T): Hook<InstanceType<T>> {
    return this.getComponentMeta(C) as any;
  }

  /**
   * Declare a group of mutually exclusive components.
   *
   * Adding any component in the group to an entity that already has another
   * member of the group automatically removes the previous member. Members
   * not in the group are unaffected.
   *
   * ```ts
   * world.setExclusiveComponents(Walking, Running, Idle);
   * entity.add(Walking);
   * entity.add(Running);            // Walking is removed automatically
   * ```
   *
   * Each call defines one independent group. A component may belong to at
   * most one group at a time; calling {@link setExclusiveComponents} with the
   * same class again overwrites its group. Safe to call before or after
   * {@link start}.
   *
   * @param components - Two or more component classes that cannot coexist.
   * @throws When any class has not been registered.
   */
  public setExclusiveComponents(...components: (typeof Component)[]): void {
    const types = components.map((C) => this.getComponentType(C));
    for (let i = 0; i < components.length; i++) {
      this.getComponentMeta(components[i]).exclusive = types.filter((_, j) => j !== i);
    }
  }

  /**
   * Set the starting value of the auto-incrementing entity id counter.
   *
   * Must be called **before** {@link start} (or
   * {@link disableComponentRegistration}). Useful when the world runs
   * alongside a server that owns a different id range — locally created
   * client entities can start at a high offset to avoid collisions with
   * server-assigned ids.
   *
   * @param min - First id assigned by {@link entity}.
   * @throws When called after registration has been disabled.
   */
  public setEntityIdRange(min: number): void {
    if (this._componentRegistrationDisabled) {
      throw "setEntityIdRange must be called before component registration is disabled";
    }
    this._eidCounter = min;
  }

  /**
   * Return the entity with id `eid`, creating it if it does not yet exist.
   *
   * Used by networking code to materialise server-assigned entities:
   *
   * ```ts
   * const e = world.getOrCreateEntity(snapshot.eid, (e) => {
   *   networkEntities.add(e);
   * });
   * e.add(snapshot.type);
   * ```
   *
   * @param eid - Entity id to look up or create.
   * @param onCreateCallback - Optional callback invoked only when a new
   *   entity is created, before it is returned. Use it to initialise
   *   bookkeeping (e.g. tracking it in a local set).
   * @returns The existing or newly created entity.
   */
  public getOrCreateEntity(eid: number, onCreateCallback?: (e: Entity) => void): Entity {
    let e = this._entities.get(eid);
    if (!e) {
      e = new Entity(this, eid);
      this._entities.set(eid, e);
      if (onCreateCallback) {
        onCreateCallback(e);
      }
    }
    return e;
  }

  /**
   * Create a new entity with an auto-assigned id.
   *
   * The id counter starts at `0` (or at the value set by
   * {@link setEntityIdRange}) and increments by one for each call. In
   * deferred mode the new entity is queued onto the command queue and is not
   * visible in {@link entities} until the queue drains.
   */
  public entity(): Entity;

  /**
   * Look up an existing entity by id.
   *
   * @param id - Numeric entity id.
   * @returns The entity, or `undefined` when no entity with that id exists.
   */
  public entity(id: number): Entity | undefined;

  public entity(id?: number): Entity | undefined {
    if (id === undefined) {
      const eid = this._eidCounter++;
      const e = new Entity(this, eid);
      if (this.deferred) {
        this._enqueue({ kind: CommandKind.CreateEntity, entity: e });
      } else {
        this._entities.set(eid, e);
      }
      return e;
    }
    return this._entities.get(id);
  }

  /**
   * Destroy every entity currently tracked by the world.
   *
   * Triggers all `onRemove` hooks and `exit` callbacks. Useful when
   * transitioning between game sessions or resetting to a clean state.
   */
  public clearAllEntities(): void {
    this._entities.forEach((e) => {
      e.destroy();
    });
    this.flush();
  }

  /**
   * Create, register, and return a new {@link System}, ready for fluent
   * configuration.
   *
   * ```ts
   * world.system("Render")
   *   .phase("update")
   *   .requires(Position, Sprite)
   *   .enter([Sprite], (e, [sprite]) => sprite.initialize(scene))
   *   .each([Position, Sprite], (e, [pos, sprite]) => sprite.draw(pos.x, pos.y));
   * ```
   *
   * @param name - Unique display name for the system.
   * @returns The new system.
   */
  public system(name: string): System {
    return new System(name, this);
  }

  /**
   * Create, register, and return a standalone {@link Query}, ready for fluent
   * configuration.
   *
   * Unlike a {@link System}, a standalone query has no phase and no per-tick
   * callbacks — it is a reactive entity set that can be read at any time. It
   * can also be created **after** {@link start}; existing matched entities
   * are backfilled immediately.
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
   * @param name - Unique display name for the query.
   * @returns The new query.
   */
  public query(name: string): Query {
    return new Query(name, this);
  }

  /**
   * Create a non-reactive {@link Filter} that matches entities satisfying `q`.
   *
   * Unlike {@link query}, the returned filter holds no tracked entity set and
   * registers nothing on the world. Each call to {@link Filter.forEach} walks
   * all current world entities and invokes the callback on the matches.
   *
   * The component classes guaranteed present on every matched entity are
   * inferred from the DSL where possible (plain arrays, `HAS`, `HAS_ONLY`,
   * and `AND` of those forms). For shapes the inferer cannot see through
   * (`OR`, `NOT`, `PARENT`, custom `EntityTestFunc`) supply a `_guaranteed`
   * tuple as a type-level override:
   *
   * ```ts
   * // Auto-deduced: pos and vel are non-nullable.
   * world.filter([Position, Velocity])
   *   .forEach([Position, Velocity], (e, [pos, vel]) => { ... });
   *
   * // Manual override for an opaque query.
   * world.filter(myTestFunc, [Position])
   *   .forEach([Position], (e, [pos]) => pos.x);
   * ```
   *
   * @param q - Query expression.
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
   * Add a named phase to the update pipeline.
   *
   * Phases are executed in insertion order when {@link runPhase} or
   * {@link progress} is called. Systems join a phase via {@link System.phase}.
   *
   * ```ts
   * const preUpdate = world.addPhase("preupdate");
   * const update    = world.addPhase("update");
   * const send      = world.addPhase("send");
   * ```
   *
   * @param name - Unique phase name. Systems can reference it by this string.
   * @returns The new phase.
   */
  public addPhase(name: string): IPhase {
    const phase = new Phase(name, this);
    this._pipeline.set(name, phase);
    return phase;
  }

  /**
   * Prevent any further calls to {@link registerComponent}.
   *
   * Called automatically by {@link start}. Call directly if you want to lock
   * registration before the rest of the systems are wired up.
   */
  public disableComponentRegistration(): void {
    this._componentRegistrationDisabled = true;
  }

  /**
   * Freeze component registration and prepare the world for running.
   *
   * Distributes every system registered so far into its phase (defaulting to
   * `"update"`) and logs the phase → system order to the console. Systems
   * and queries can still be created after this call — standalone queries
   * backfill existing matched entities immediately.
   *
   * Call once before the first {@link runPhase} / {@link progress}.
   */
  public start(): void {
    this._componentRegistrationDisabled = true;
    this._reindexSystems();
  }

  /**
   * Execute every system in `phase` for one tick.
   *
   * Pending top-level mutations are drained before the first system runs so
   * each system observes a consistent world. Each system body executes in a
   * deferred scope; mutations made by callbacks land in the world queue and
   * are processed before the next system runs.
   *
   * @param phase - Phase reference returned from {@link addPhase}.
   * @param now - Absolute timestamp in milliseconds (e.g. `Date.now()`).
   * @param delta - Milliseconds elapsed since the previous tick.
   */
  public runPhase(phase: IPhase, now: number, delta: number): void {
    this.flush();
    (phase as Phase).systems.forEach((s) => {
      s._run(now, delta);
    });
  }

  /**
   * Run every phase in the pipeline in registration order.
   *
   * Equivalent to calling {@link runPhase} for each phase manually.
   *
   * @param now - Absolute timestamp in milliseconds (e.g. `Date.now()`).
   * @param delta - Milliseconds elapsed since the previous tick.
   */
  public progress(now: number, delta: number): void {
    this.flush();
    this._pipeline.forEach((phase) => {
      this.runPhase(phase, now, delta);
    });
  }
}
