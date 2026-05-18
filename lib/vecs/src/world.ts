import { type ComponentClass, ComponentClassOrType, ComponentMeta, Hook } from "./component.js";
import { Entity } from "./entity.js";
import { Query } from "./query.js";
import { System } from "./system.js";
import { Filter } from "./filter.js";
import { _extractQueryDependencies, type QueryDSL, type ExtractRequired } from "./dsl.js";
import { ArrayMap } from "./util/array_map.js";
import { IPhase, Phase } from "./phase.js";
import { CommandKind, type Command } from "./command.js";
import { ALWAYS_TICK_SOURCE, type ITickSource } from "./timer.js";

const DEFAULT_COMPONENT_TYPE_START = 256;
const RESERVED_COMPONENT_TYPE = 0;

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
 * class Position { x = 0; y = 0; }
 * class Velocity { vx = 0; vy = 0; }
 *
 * world.registerComponent(Position);
 * world.registerComponent(Velocity);
 *
 * world.system("Move")
 *   .requires(Position, Velocity)
 *   .each([Position, Velocity], (e, [pos, vel]) => {
 *     pos.x += vel.vx;
 *     e.modified(Position);
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
 * (`add` / `attach` / `set` / `remove` / `destroy` / `setParent` / `modified`) are
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
  /** @internal Queries created but not yet built into the world. */
  private _unbuiltQueries = new Set<Query>();
  /** @internal Component type id -> queries invalidated by that component. */
  private _queryIndex = new ArrayMap<Set<Query>>();
  /** @internal Queries whose predicates are too broad for component indexing. */
  private _unindexedQueries = new Set<Query>();

  /** @internal Component type id → meta record. */
  private _Type2Meta = new ArrayMap<ComponentMeta>();
  /** @internal Pre-registered name → type id mappings (server-assigned ids). */
  private _componentNameTypeMap = new Map<string, number>();
  /** @internal Counter used to auto-assign local component type ids. */
  private _localComponentCounter: number;
  /** @internal `true` once {@link start} (or {@link disableComponentRegistration}) has been called. */
  private _componentRegistrationDisabled = false;
  /** @internal `true` once {@link start} has prepared the phase pipeline. */
  private _started = false;

  /** @internal Auto-incrementing entity id counter, seeded by {@link setEntityIdRange}. */
  private _eidCounter = 0;
  /** @internal First id reserved for locally-created entities. */
  private _localEntityIdStart = 0;

  /** @internal Single ordered command queue used in deferred mode. */
  private _commandQueue: Command[] = [];
  /** @internal Nested {@link beginDefer} / {@link endDefer} count. */
  private _deferredDepth = 0;
  /** @internal `true` while {@link _processCommandQueue} is iterating, to avoid re-entrant drains. */
  private _draining = false;

  /** @internal Phase name → phase. Insertion-ordered, matches pipeline execution order. */
  public _pipeline = new Map<string, Phase>();
  /** @internal World-owned tick sources evaluated once per frame. */
  private _tickSources: Set<ITickSource> = new Set();
  /** @internal Monotonic frame id used to memoize tick-source evaluation. */
  public _frameCounter = 0;
  /** @internal True while the world is driving one logical frame. */
  private _frameInProgress = false;
  /** @internal True while the world is auto-building pending queries. */
  private _buildingPendingQueries = false;

  /** Hidden property key used to store this world's meta on component classes. */
  public readonly worldKey = `__vecs_world_${Math.random().toString(36).slice(2)}`;

  constructor() {
    this._localComponentCounter = DEFAULT_COMPONENT_TYPE_START;
    this._tickSources.add(ALWAYS_TICK_SOURCE);
  }

  private _nextComponentType(): number {
    let type = this._localComponentCounter;
    while (
      type === RESERVED_COMPONENT_TYPE ||
      this._Type2Meta.get(type) ||
      this._isMappedComponentType(type)
    ) {
      type++;
    }
    this._localComponentCounter = type + 1;
    return type;
  }

  private _isMappedComponentType(type: number): boolean {
    for (const mappedType of this._componentNameTypeMap.values()) {
      if (mappedType === type) {
        return true;
      }
    }
    return false;
  }

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
        cmd.entity._set(cmd.meta, cmd.props);
        return;
      case CommandKind.Modified:
        cmd.entity._modified(cmd.meta);
        return;
      case CommandKind.Remove:
        cmd.entity._remove(cmd.meta);
        return;
      case CommandKind.Destroy:
        cmd.entity._destroy();
        return;
      case CommandKind.SetParent:
        cmd.entity._setParent(cmd.parent);
        return;
      case CommandKind.Attach:
        cmd.entity._attach(cmd.meta, cmd.component);
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

    this._pipeline.forEach((phase) => {
      phase.systems.length = 0;
    });

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

  /** @internal Register and index a freshly built {@link Query}. */
  public _addQuery(q: Query): void {
    if (this._frameInProgress && !this._buildingPendingQueries) {
      throw "queries cannot be built while a frame is in progress";
    }
    this._removeUnbuiltQuery(q);
    this._queries.push(q);
    if (q._dsl !== undefined) {
      this._indexQuery(q, _extractQueryDependencies(this, q._dsl));
    }
  }

  /** @internal Track a newly-created query until it is explicitly or automatically built. */
  public _addUnbuiltQuery(q: Query): void {
    this._unbuiltQueries.add(q);
  }

  /** @internal Stop tracking a pending query. */
  public _removeUnbuiltQuery(q: Query): void {
    this._unbuiltQueries.delete(q);
  }

  /** @internal Build every query that has not yet entered the world. */
  private _buildPendingQueries(): void {
    if (this._unbuiltQueries.size === 0) {
      return;
    }
    const pending = [...this._unbuiltQueries];
    this._buildingPendingQueries = true;
    try {
      pending.forEach((q) => q._build());
    } finally {
      this._buildingPendingQueries = false;
    }
  }

  /** @internal Visit queries whose membership may change when component `type` changes. */
  public _forEachQueryForComponent(type: number, callback: (q: Query) => void): void {
    this._queryIndex.get(type)?.forEach(callback);
    this._unindexedQueries.forEach(callback);
  }

  /** @internal Register a query in the component index, or fallback routing. */
  public _indexQuery(q: Query, componentTypes: number[] | undefined): void {
    this._unindexQuery(q);
    if (componentTypes === undefined || componentTypes.length === 0) {
      this._unindexedQueries.add(q);
      q._queryIndexKeys = undefined;
      return;
    }

    const indexedTypes = [...new Set(componentTypes)];
    indexedTypes.forEach((type) => {
      let queries = this._queryIndex.get(type);
      if (!queries) {
        queries = new Set<Query>();
        this._queryIndex.set(type, queries);
      }
      queries.add(q);
    });
    q._queryIndexKeys = indexedTypes;
  }

  /** @internal Remove a query from every index/fallback bucket. */
  public _unindexQuery(q: Query): void {
    if (q._queryIndexKeys !== undefined) {
      q._queryIndexKeys.forEach((type) => {
        const queries = this._queryIndex.get(type);
        queries?.delete(q);
        if (queries?.size === 0) {
          this._queryIndex.delete(type);
        }
      });
    }
    this._unindexedQueries.delete(q);
    q._queryIndexKeys = undefined;
  }

  /** @internal Register a tick source with this world. */
  public _registerTickSource(t: ITickSource): void {
    this._tickSources.add(t);
  }

  /**
   * @internal Unregister a query and purge its membership from every entity.
   * Called by {@link Query.destroy}.
   */
  public _removeQuery(q: Query): void {
    this._removeUnbuiltQuery(q);
    this._unindexQuery(q);
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
   * Build pending queries and drain queued commands at the top level (depth 0).
   *
   * Call between phases or after batch-loading network snapshots to surface
   * accumulated query builds and mutations (firing hooks and routing enter /
   * exit / update) before the next read or system run. Pending queries are
   * built before queued commands are processed so they can observe the batch.
   */
  public flush(): void {
    if (this._deferredDepth === 0) {
      this._buildPendingQueries();
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
    if (type === RESERVED_COMPONENT_TYPE) {
      throw new Error(`Component type ${type} is reserved`);
    }
    this._componentNameTypeMap.set(componentName, type);
  }

  /**
   * Register a component class with the world.
   *
   * Must be called before any entity uses the component. Components are plain
   * classes constructed with no arguments. Registration is disabled once
   * {@link start} (or {@link disableComponentRegistration}) is called.
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
   * @returns The world-specific metadata record for the component class.
   * @throws When the class has already been registered in this world or
   *   registration is disabled.
   */
  public registerComponent(ComponentClass: ComponentClass): ComponentMeta;
  public registerComponent(ComponentClass: ComponentClass, type: number): ComponentMeta;
  public registerComponent(ComponentClass: ComponentClass, componentName?: string): ComponentMeta;
  public registerComponent(
    ComponentClass: ComponentClass,
    type: number,
    componentName: string
  ): ComponentMeta;
  public registerComponent(
    ComponentClass: ComponentClass,
    typeOrComponentName?: number | string,
    componentName?: string
  ): ComponentMeta {
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
        type = this._nextComponentType();
        local = true;
      }
    }

    let meta = this._tryGetComponentMeta(ComponentClass);
    if (meta) {
      if (local) {
        this._localComponentCounter--;
      }
      throw `Trying to register ${componentName} with type=${type} which is already registered to ${meta.componentName}`;
    }
    this.registerComponentType(componentName, type);
    meta = new ComponentMeta(ComponentClass, type, componentName);
    Object.defineProperty(ComponentClass, this.worldKey, {
      value: meta,
      enumerable: false,
    });
    this._Type2Meta.set(type, meta);
    console.log(
      "Registered component %s with type=%d as %s component",
      componentName,
      type,
      local ? "local" : "networked"
    );
    return meta;
  }

  /** @internal Return registered metadata for this world without throwing. */
  public _tryGetComponentMeta(typeOrClass: ComponentClassOrType): ComponentMeta | undefined {
    if (typeof typeOrClass === "function") {
      return (typeOrClass as any)[this.worldKey] as ComponentMeta | undefined;
    }
    return this._Type2Meta.get(typeOrClass);
  }

  /**
   * Look up the {@link ComponentMeta} for a registered component.
   *
   * @param typeOrClass - Component class or numeric type id.
   * @returns The corresponding meta record.
   * @throws When no component with that class or type id has been registered.
   */
  public getComponentMeta(typeOrClass: ComponentClassOrType): ComponentMeta {
    const meta = this._tryGetComponentMeta(typeOrClass);
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
   *   .onAdd((entity, c) => c.initialize(scene, entity))
   *   .onRemove((entity, c) => c.destroy(scene, entity));
   * ```
   *
   * @param C - Component class.
   * @returns The hook bound to that component type.
   */
  public hook<T extends ComponentClass>(C: T): Hook<InstanceType<T>> {
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
  public setExclusiveComponents(...components: ComponentClass[]): void {
    const metas = components.map((C) => this.getComponentMeta(C));
    for (let i = 0; i < metas.length; i++) {
      metas[i]._exclusive = metas.filter((_, j) => j !== i);
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
    this._localEntityIdStart = min;
    this._eidCounter = min;
  }

  /**
   * Set the starting value of the auto-incrementing component type id counter.
   *
   * Must be called before component registration is disabled. This is useful
   * when a host protocol reserves a compact component type range and wants
   * user-registered components to start within that range.
   *
   * @param min - First type id considered by automatic component registration.
   * @throws When called after registration is disabled or with the reserved type 0.
   */
  public setComponentTypeRange(min: number): void {
    if (this._componentRegistrationDisabled) {
      throw "setComponentTypeRange must be called before component registration is disabled";
    }
    if (!Number.isSafeInteger(min) || min <= RESERVED_COMPONENT_TYPE) {
      throw new Error(
        `Component type range must start above reserved type ${RESERVED_COMPONENT_TYPE}`
      );
    }
    this._localComponentCounter = min;
  }

  /** First entity id reserved for locally-created entities. */
  public get localEntityIdStart(): number {
    return this._localEntityIdStart;
  }

  /**
   * Return the entity with id `eid`, creating it if it does not yet exist.
   *
   * Used by networking code to materialise server-assigned entities:
   *
   * ```ts
   * const [eid, type] = unpackSnapshotId(snapshot.cid);
   * const e = world.getOrCreateEntity(eid, (e) => {
   *   networkEntities.add(e);
   * });
   * e.add(type);
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
   * Create and return a new {@link System}, ready for fluent configuration.
   * Systems must be created before {@link start}.
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
    if (this._started) {
      throw "systems cannot be added after world start";
    }
    return new System(name, this);
  }

  /**
   * Create and return a standalone {@link Query}, ready for fluent configuration.
   *
   * Unlike a {@link System}, a standalone query has no phase and no per-tick
   * callbacks — it is a reactive entity set that can be read at any time. It
   * can also be created **after** {@link start}; call {@link Query.build} to
   * register and backfill immediately, or let the world build it at the next
   * top-level {@link flush}.
   *
   * ```ts
   * const enemies = world.query("Enemies")
   *   .requires(Enemy, Health)
   *   .enter((e) => console.log("enemy spawned", e.eid));
   *
   * world.start();
   * // enemies.count and query iteration are kept up-to-date automatically
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
  public filter<T extends ComponentClass[]>(q: QueryDSL, _guaranteed: readonly [...T]): Filter<T>;
  public filter(q: QueryDSL, _guaranteed?: readonly ComponentClass[]): Filter<any> {
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
   * Builds pending queries, distributes every system into its phase (defaulting
   * to `"update"`), and logs the phase → system order to the console. Systems
   * cannot be created after this call; standalone queries can still be created
   * and will build before the next frame unless built explicitly.
   *
   * Call once before the first {@link runPhase} / {@link progress}.
   */
  public start(): void {
    this._buildPendingQueries();
    this._componentRegistrationDisabled = true;
    this._started = true;
    this._reindexSystems();
  }

  /**
   * Open a new frame and evaluate every registered tick source once.
   *
   * Call this before one or more {@link runPhase} calls when manually driving
   * phases. {@link progress} wraps this automatically for the full pipeline.
   *
   * @param delta - Milliseconds elapsed since the previous frame.
   * @throws When a frame is already open.
   */
  public beginFrame(delta: number): void {
    if (this._frameInProgress) {
      throw "endFrame() not called before beginFrame()";
    }
    this._frameInProgress = true;
    this._frameCounter++;
    this.flush();
    this._tickSources.forEach((t) => t._evalTick(delta, this._frameCounter));
  }

  /**
   * Close the current frame.
   *
   * @throws When no frame is currently open.
   */
  public endFrame(): void {
    if (!this._frameInProgress) {
      throw "beginFrame() not called before endFrame()";
    }
    this._frameInProgress = false;
  }

  /**
   * Execute every system in `phase` within the current frame.
   *
   * Pending top-level mutations are drained before the first system runs so
   * each system observes a consistent world. Each system body executes in a
   * deferred scope; mutations made by callbacks land in the world queue and
   * are processed before the next system runs.
   *
   * `runPhase` is safe to call re-entrantly from a system body: it reuses the
   * frame opened by {@link beginFrame} and does not advance `_frameCounter` or
   * re-evaluate tick sources.
   *
   * @param phase - Phase reference returned from {@link addPhase}.
   * @param now - Absolute timestamp in milliseconds (e.g. `Date.now()`).
   * @param delta - Milliseconds elapsed since the previous tick.
   * @throws When called outside an open frame.
   */
  public runPhase(phase: IPhase, now: number, delta: number): void {
    if (!this._frameInProgress) {
      throw "runPhase() called outside a frame — call beginFrame() first";
    }
    this.flush();
    (phase as Phase).systems.forEach((s) => {
      s._run(now, delta);
    });
  }

  /**
   * Run every phase in the pipeline in registration order.
   *
   * Equivalent to `beginFrame(delta)`, calling {@link runPhase} for each
   * phase, then {@link endFrame}. All registered tick sources are evaluated
   * once up front for the whole frame, and the frame is closed in a `finally`
   * block if a system throws.
   *
   * @param now - Absolute timestamp in milliseconds (e.g. `Date.now()`).
   * @param delta - Milliseconds elapsed since the previous tick.
   */
  public progress(now: number, delta: number): void {
    this.beginFrame(delta);
    try {
      this._pipeline.forEach((phase) => {
        this.runPhase(phase, now, delta);
      });
    } finally {
      this.endFrame();
    }
  }
}
