import { OrderedSet } from "./util/ordered_set.js";
import { ArrayMap } from "./util/array_map.js";
import { Bitset } from "./util/bitset.js";
import { type ComponentInstance, type ComponentMeta, type ComponentType } from "./component.js";
import { Entity } from "./entity/index.js";
import { type World } from "./world/index.js";
import { containsDownTerm, type EntityTestFunc, type MaybeRequired, type QueryDSL } from "./dsl.js";
import {
  directInjectEids,
  getInjected,
  getInjectedWithSrc,
  injectArity,
  isCursorMarker,
  Iter,
  makeInjectedInvoker,
  mapInject,
  wantsIter,
  type DownInject,
  type FanInjectElement,
  type FanInjectTuple,
  type InjectElement,
  type InjectTuple,
  type MaybeResolvedInjectTuple,
  type RequiredResolvedInjectTuple,
  type UpInject,
} from "./inject.js";
import { Term, TermEventKind, type TermConsumer } from "./terms/term.js";
import { ChildOf, SilenceSource } from "./relationship.js";

export type {
  EntityTestFunc,
  DownInject,
  FanInjectElement,
  FanInjectTuple,
  InjectElement,
  InjectTuple,
  MaybeRequired,
  MaybeResolvedInjectTuple,
  QueryDSL,
  RequiredResolvedInjectTuple,
  UpInject,
};
export { Iter };

type EntityCallback = (e: Entity, snapshot?: Map<number, ComponentInstance>) => void;
type ComponentCallback = (e: Entity, c: ComponentInstance) => void;

const EMPTY_ENTITIES: ReadonlySet<Entity> = new Set();
export const SOURCE_TRACKED_QUERY_ERROR =
  "source/children is not supported in a tracked query; use world.filter(...)";

/**
 * A reactive, always-up-to-date set of entities matching a {@link QueryDSL}
 * predicate.
 *
 * `Query` listens to entity / component mutations through the world's command
 * queue and tracks which entities currently satisfy its predicate. It fires
 * `enter`, `exit`, and `update` callbacks as the matched set changes. The
 * tracked set is exposed via {@link count}, {@link has}, iteration, and
 * {@link forEach}.
 *
 * Callbacks fire **synchronously** when the world routes a command — so
 * mutations made inside one of these callbacks are themselves observed
 * immediately by other queries / systems.
 *
 * {@link System} extends `Query` and queues callbacks into an inbox replayed
 * during `_run` instead of firing them immediately. Use `Query` directly when
 * you want a reactive entity set without pipeline integration.
 *
 * @typeParam R - Component classes guaranteed present on every matched entity
 *   (declared via {@link requires} or the `_guaranteed` hint of {@link query}).
 *   Components in `R` appear as non-nullable in {@link sort}, {@link forEach},
 *   and {@link update} callback tuples.
 */
export class Query<R extends ComponentType[] = []> implements TermConsumer {
  /** @internal Sorted projection. Unsorted membership is read from `rootTerm`. */
  protected _entities: Set<Entity> | undefined;
  /** @internal `true` once {@link query} or {@link requires} has set an explicit predicate. */
  protected _hasExplicitQuery: boolean = false;
  /** @internal DSL predicate used to build the root membership term. */
  public _dsl: QueryDSL | undefined = undefined;
  /** Entity that stores this query as a component and carries query traits. */
  public readonly entity: Entity;
  /** @internal `true` once this query has been registered with its world. */
  private _built = false;
  /** @internal Guards destroy hooks against recursive removal. */
  private _destroyed = false;
  /** @internal Whether membership APIs are enabled for this query. */
  private _tracking = false;
  /** Materialized root term that owns membership for this query. */
  public rootTerm: Term | undefined;
  /** @internal Root term subscription handle. */
  private _unsubscribeTerm: (() => void) | undefined;

  /** @internal `enter` callback (already wraps any injection logic). */
  protected _enterCallback: EntityCallback | undefined = undefined;
  /** @internal `exit` callback (already wraps any injection logic). */
  protected _exitCallback: EntityCallback | undefined = undefined;
  /** @internal Component eids the exit callback needs snapshotted before component removal. */
  protected _exitSnapshotTypes: number[] | undefined = undefined;
  /** @internal Per-component-eid `update` callbacks. */
  protected _componentUpdateCallbacks = new ArrayMap<ComponentCallback>();
  /** @internal Bitmask of component eids this query reacts to via `update`. */
  protected _watchlistBitmask: Bitset = new Bitset();
  /** @internal Silence-domain query: `update` events whose source is a member are dropped. */
  protected _silenceQuery: Query | undefined;

  constructor(name: string, world: World, track: boolean = true) {
    this.entity = world.entity();
    this.entity.name = name;
    this.entity.attach(Query, this);
    world._addUnbuiltQuery(this);
    if (track) {
      this.track();
    }
  }

  /** @internal Throw when a builder method is called after registration. */
  protected _assertConfigurable(): void {
    if (this.built) {
      throw new Error(`query '${this.name}' has already been built`);
    }
  }

  /** @internal Whether this object has enough configuration to enter the world. */
  protected _isBuildable(): boolean {
    return this._dsl !== undefined;
  }

  /**
   * @internal Backfill the tracked set from the root term. Runs inside a
   * deferred scope so the caller's reentrant routing remains consistent.
   */
  private _backfill(): void {
    if (!this._tracking || !this.rootTerm) {
      return;
    }
    this.world.defer(() => {
      for (const e of this.rootTerm ?? EMPTY_ENTITIES) {
        this._enter(e);
      }
    });
  }

  /** `true` once this query has been registered with its world. */
  public get built(): boolean {
    return this._built;
  }

  /** Unique display name; forwards to the backing entity identity. */
  public get name(): string | undefined {
    return this.entity.name;
  }

  /** World that owns this query; forwards to the backing entity. */
  public get world(): World {
    return this.entity.world;
  }

  /**
   * Finalise this query's configuration and register it with the world.
   *
   * Outside deferred mode this builds immediately. Inside deferred mode the
   * query is left pending and the world builds it at the next top-level
   * {@link World.flush}, before queued commands are drained.
   *
   * @returns This query, for chaining.
   */
  public build(): this {
    if (this.built) {
      return this;
    }
    if (this.world.deferred) {
      this.world._addUnbuiltQuery(this);
      return this;
    }
    return this._build();
  }

  /**
   * @internal Finalise this query's configuration and register it with the world.
   * Public callers should use {@link build} so deferred contexts can queue the
   * build safely.
   */
  public _build(): this {
    if (this.built) {
      return this;
    }
    if (!this._isBuildable()) {
      this.destroy();
      return this;
    }
    this.world._removeUnbuiltQuery(this);
    if (this._dsl !== undefined) {
      if (this._tracking && containsDownTerm(this._dsl)) {
        this.destroy();
        throw new Error(SOURCE_TRACKED_QUERY_ERROR);
      }
      this.rootTerm = this.world.getTerm(this._dsl);
      this._unsubscribeTerm = this.rootTerm.subscribe(this);
    }
    this.world._addQuery(this);
    this._built = true;
    this._backfill();
    return this;
  }

  /**
   * @internal Add `e` to the tracked set, register query membership on the
   * entity, fire any registered `enter` callback, then bridge the entity's
   * already-attached watched components through {@link _notifyModified} so
   * `update` callbacks see them once on entry.
   *
   * `System` overrides this to push events into its inbox.
   */
  public _enter(e: Entity): void {
    this._entities?.add(e);
    e._addQueryMembership(this);
    this._enterCallback?.(e);
    e.components.forEach((c, eid) => {
      const meta = this.world.entity(eid).ownMeta;
      if (this._watchlistBitmask.hasBit(meta.bitPtr)) {
        this._notifyModified(e, meta, c);
      }
    });
  }

  /**
   * @internal Remove `e` from the tracked set, deregister query membership,
   * and fire any registered `exit` callback. `System` overrides this to push
   * an inbox event.
   */
  public _exit(e: Entity): void {
    this._exitCallback?.(e);
    this._entities?.delete(e);
    e._removeQueryMembership(this);
  }

  /** Route a root term membership event into the existing Query API. */
  public onTermEvent(kind: TermEventKind, entity: Entity): void {
    if (kind === TermEventKind.Enter) {
      this._enter(entity);
    } else {
      this._exit(entity);
    }
  }

  /**
   * @internal Routing entry: when the watchlist matches, invoke the registered
   * `update` callback for the component type. `System` overrides this to push
   * an inbox event instead of firing immediately.
   */
  public _notifyModified(e: Entity, meta: ComponentMeta, c: ComponentInstance): void {
    if (!this._watchlistBitmask.hasBit(meta.bitPtr)) {
      return;
    }
    if (this._isSourceSilenced()) {
      return;
    }
    const callback = this._componentUpdateCallbacks.get(meta.eid);
    if (callback) {
      callback(e, c);
    }
  }

  /** @internal True when the world's current routing source is a member of this query's silence domain. */
  protected _isSourceSilenced(): boolean {
    const source = this.entity.world._routingSource;
    return source !== undefined && this._silenceQuery?.has(source) === true;
  }

  /** @internal Build a tracked silence-domain query from `dsl`, tied to this query's lifetime. */
  private _buildSilenceQuery(dsl: QueryDSL): Query {
    const query = this.world.query(`${this.name}:silence`).query(dsl);
    query.entity.set(ChildOf, { target: this.entity });
    return query;
  }

  /**
   * Ignore `update` notifications produced by a set of source entities,
   * preventing read/writeback feedback loops.
   *
   * Every component mutation is credited to the entity of the system that made
   * it. `ignoreSource` declares a **silence domain** as a query over those
   * source entities: any `update` whose source is a member of the query is
   * dropped before it reaches this query's callback. Mutations made outside
   * any system (gameplay code) have no source and always wake the query.
   *
   * Pass a {@link QueryDSL} to define the domain inline — a fresh tracked query
   * is created and tied to this query's lifetime via {@link ChildOf}. Pass an
   * existing {@link Query} to reuse its membership directly. To silence a
   * query's own writeback, include its entity in the domain (for example, tag
   * the participating query entities with a marker component and match it).
   *
   * Calling `ignoreSource` again replaces the previous domain. Entry-time
   * initialization is never silenced. Call during setup, before
   * {@link World.start}; the inline-DSL form builds a query, which cannot
   * happen while a frame is in progress.
   *
   * @param source - A {@link QueryDSL} domain expression or an existing
   *   {@link Query} whose members are the silenced sources.
   * @returns This query, for chaining.
   *
   * @example
   * ```ts
   * // Tag every physics system entity, then have the reader ignore that domain.
   * const integrate = world.system("Integrate").requires(Position, Velocity)
   *   .each([Position, Velocity], (e, [p, v]) => { p.x += v.vx; });
   * integrate.entity.add(Physics);
   *
   * const readQuery = world.query("PhysicsRead").requires(Position)
   *   .ignoreSource([Physics])
   *   .update(Position, reactToExternalChange);
   * ```
   */
  public ignoreSource(source: QueryDSL | Query): this {
    this._assertConfigurable();
    const query = source instanceof Query ? source : this._buildSilenceQuery(source);
    this.entity.set(SilenceSource, { target: query.entity });
    this._silenceQuery = query;
    return this;
  }

  /** @internal Drop the silence-domain query cache after the relationship is removed. */
  public _clearSilence(): void {
    this._silenceQuery = undefined;
  }

  /** @internal Whether this query should be present in an entity's slim update set. */
  public _watchesUpdates(): boolean {
    return this._componentUpdateCallbacks.size > 0;
  }

  /** @internal Drop the root term subscription during world removal. */
  public _unsubscribeRootTerm(): void {
    this._unsubscribeTerm?.();
    this._unsubscribeTerm = undefined;
    this.rootTerm = undefined;
  }

  /**
   * Return the number of entities currently tracked by this query.
   *
   * Returns `0` when tracking is not enabled.
   */
  public get count(): number {
    if (!this._tracking) {
      return 0;
    }
    return this._entities?.size ?? this.rootTerm?.count ?? 0;
  }

  /** Returns `true` when `e` is currently tracked by this query. */
  public has(e: Entity): boolean {
    if (!this._tracking) {
      return false;
    }
    return this._entities?.has(e) ?? this.rootTerm?.has(e) ?? false;
  }

  /** Iterate every entity currently tracked by this query. */
  public [Symbol.iterator](): IterableIterator<Entity> {
    return this._matchedEntities()[Symbol.iterator]();
  }

  /** Returns the query name. */
  public toString(): string {
    return this.name ?? "";
  }

  /**
   * Enable entity tracking: matched entities are included in {@link count},
   * {@link has}, iteration, and {@link forEach}
   * as they enter and removed as they exit.
   *
   * Idempotent. When called after {@link World.start}, immediately backfills
   * every existing entity that satisfies the current predicate.
   *
   * @returns This query, for chaining.
   */
  public track(): this {
    this._assertConfigurable();
    this._tracking = true;
    return this;
  }

  /** Returns `true` when `e` satisfies this query's predicate. */
  public belongs(e: Entity): boolean {
    return this.rootTerm?.has(e) ?? false;
  }

  /**
   * Iterate every entity currently tracked by this query.
   *
   * Mutations made by `callback` are buffered into the world command queue
   * and only become visible after iteration finishes. Nested iteration inside
   * an already-deferred context (a system, an outer `forEach`) inherits the
   * outer scope and does not drain on exit.
   *
   * @param callback - Invoked once per tracked entity, in insertion order
   *   (or sort order when {@link sort} is configured).
   */
  public forEach(callback: (e: Entity) => void): void;

  /**
   * Iterate every tracked entity with component injection.
   *
   * Components covered by {@link requires} (or the `_guaranteed` hint of
   * {@link query}) are non-nullable in the resolved tuple; any other
   * requested component may be `undefined` if the entity lacks it.
   *
   * The resolved tuple is a single array reused for every entity in the
   * iteration; treat it as valid only for the duration of the callback. Read
   * or destructure the components you need (the component instances themselves
   * are stable) — do not retain the tuple array itself across callbacks.
   *
   * @param components - Component classes to resolve from each entity.
   * @param callback - Receives the entity and a tuple of resolved component
   *   instances.
   */
  public forEach<J extends FanInjectTuple>(
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;

  /**
   * As above, but pass `Entity` first to make the entity-first signature
   * explicit. Identical behavior to the no-marker form.
   */
  public forEach<J extends FanInjectTuple>(
    cursor: typeof Entity,
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;

  /**
   * As above, but pass `Iter` first to receive a reused {@link Iter}
   * cursor instead of the bare entity. The cursor exposes the visited entity
   * (`it.entity`) and, in `it.src`, the source entity each resolved component
   * was read from (the visited entity for direct components, the relationship
   * target for `up`-injected ones).
   */
  public forEach<J extends FanInjectTuple>(
    cursor: typeof Iter,
    components: readonly [...J],
    callback: (it: Iter, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;

  public forEach(arg0: unknown, arg1?: unknown, arg2?: unknown): void {
    this.world.beginDefer();
    try {
      // Bare `forEach(callback)`: a function that is not a cursor marker.
      if (typeof arg0 === "function" && !isCursorMarker(arg0)) {
        for (const entity of this._matchedEntities()) {
          (arg0 as (e: Entity) => void)(entity);
        }
        return;
      }
      const useIter = wantsIter(arg0);
      const components = (isCursorMarker(arg0) ? arg1 : arg0) as readonly FanInjectElement[];
      const callback = (isCursorMarker(arg0) ? arg2 : arg1) as (
        eOrIt: unknown,
        resolved: unknown
      ) => void;
      const invoke = makeInjectedInvoker(this.world, components, useIter, callback);
      for (const entity of this._matchedEntities()) {
        invoke(entity);
      }
    } finally {
      this.world.endDefer();
    }
  }

  /**
   * Register a callback invoked when an entity **enters** this query (i.e.
   * first satisfies the predicate), with injected components.
   *
   * @param inject - Ordered list of component classes to resolve from the
   *   entering entity and pass to `callback`.
   * @param callback - Receives the entity and the resolved component tuple.
   * @returns This query, for chaining.
   *
   * @example
   * ```ts
   * query.enter([Position, Sprite], (e, [pos, sprite]) => {
   *   sprite.initialize(scene);
   *   sprite.sprite.setPosition(pos.x, pos.y);
   * });
   * ```
   */
  public enter<J extends InjectTuple>(
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;

  /**
   * As above, but pass `Entity` first to make the entity-first signature
   * explicit. Identical behavior to the no-marker form.
   */
  public enter<J extends InjectTuple>(
    cursor: typeof Entity,
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;

  /**
   * As above, but pass `Iter` first to receive an {@link Iter} cursor instead
   * of the bare entity. A fresh cursor is allocated per `enter` event so
   * reentrant callbacks do not corrupt each other.
   */
  public enter<J extends InjectTuple>(
    cursor: typeof Iter,
    inject: readonly [...J],
    callback: (it: Iter, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;

  /**
   * Register an `enter` callback without component injection.
   *
   * @param callback - Receives only the entering entity.
   * @returns This query, for chaining.
   */
  public enter(callback: (e: Entity) => void): this;

  public enter<J extends InjectTuple>(
    arg0: InjectTuple | ((e: Entity) => void) | typeof Entity | typeof Iter,
    arg1?: InjectTuple | Function,
    arg2?: Function
  ): this {
    this._assertConfigurable();
    // Bare `enter(callback)`
    if (typeof arg0 === "function" && !isCursorMarker(arg0)) {
      this._enterCallback = arg0 as (e: Entity) => void;
      return this;
    }
    const useIter = wantsIter(arg0);
    const components = (isCursorMarker(arg0) ? arg1 : arg0) as readonly InjectElement[];
    const cb = (isCursorMarker(arg0) ? arg2 : arg1) as (eOrIt: unknown, injected: unknown) => void;
    const inject = mapInject(this.world, components);
    const arity = injectArity(inject);
    if (useIter) {
      this._enterCallback = (e: Entity) => {
        const injected = new Array(arity);
        const it = new Iter(arity);
        it.entity = e;
        getInjectedWithSrc(e, inject, injected, it.src, true);
        cb(it, injected as any);
      };
    } else {
      this._enterCallback = (e: Entity) => {
        const injected = new Array(arity);
        getInjected(e, inject, true, injected);
        cb(e, injected as any);
      };
    }
    return this;
  }

  /**
   * Register a callback invoked when an entity **exits** this query (its
   * archetype no longer satisfies the predicate, or it was destroyed), with
   * injected components.
   *
   * Components removed in the same frame as the exit are still resolvable
   * because the runtime snapshots them at routing time.
   *
   * @param inject - Component classes to resolve and inject.
   * @param callback - Receives the entity and the resolved component tuple.
   * @returns This query, for chaining.
   */
  public exit<J extends InjectTuple>(
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;

  /**
   * As above, but pass `Entity` first to make the entity-first signature
   * explicit. Identical behavior to the no-marker form.
   */
  public exit<J extends InjectTuple>(
    cursor: typeof Entity,
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;

  /**
   * As above, but pass `Iter` first to receive an {@link Iter} cursor instead
   * of the bare entity. A fresh cursor is allocated per `exit` event so
   * reentrant callbacks do not corrupt each other.
   */
  public exit<J extends InjectTuple>(
    cursor: typeof Iter,
    inject: readonly [...J],
    callback: (it: Iter, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;

  /**
   * Register an `exit` callback without component injection.
   *
   * @param callback - Receives only the exiting entity.
   * @returns This query, for chaining.
   */
  public exit(callback: (e: Entity) => void): this;

  public exit<J extends InjectTuple>(
    arg0: readonly [...J] | ((e: Entity) => void) | typeof Entity | typeof Iter,
    arg1?: readonly [...J] | ((...args: any[]) => void),
    arg2?: (...args: any[]) => void
  ): this {
    this._assertConfigurable();
    // Bare `exit(callback)`
    if (typeof arg0 === "function" && !isCursorMarker(arg0)) {
      this._exitCallback = arg0 as (e: Entity) => void;
      this._exitSnapshotTypes = undefined;
      return this;
    }
    const useIter = wantsIter(arg0);
    const components = (isCursorMarker(arg0) ? arg1 : arg0) as readonly InjectElement[];
    const cb = (isCursorMarker(arg0) ? arg2 : arg1) as (eOrIt: unknown, injected: unknown) => void;
    const inject = mapInject(this.world, components);
    this._exitSnapshotTypes = directInjectEids(inject);
    const arity = injectArity(inject);
    if (useIter) {
      this._exitCallback = (e: Entity, exitSnapshot?: Map<number, ComponentInstance>) => {
        const injected = new Array(arity);
        const it = new Iter(arity);
        it.entity = e;
        getInjectedWithSrc(e, inject, injected, it.src, true, exitSnapshot);
        cb(it, injected as any);
      };
    } else {
      this._exitCallback = (e: Entity, exitSnapshot?: Map<number, ComponentInstance>) => {
        const injected = new Array(arity);
        getInjected(e, inject, true, injected, exitSnapshot);
        cb(e, injected as any);
      };
    }
    return this;
  }

  /**
   * Register a callback invoked when a component of `ComponentClass` is
   * modified on a tracked entity.
   *
   * On a {@link Query} the callback fires **immediately** when the world
   * routes the corresponding `Set` / `Modified` command. On a {@link System}
   * the event is buffered in the inbox and the callback fires during the
   * system's next `_run`.
   *
   * If no other predicate has been set on this query, the watchlist
   * automatically expands so `ComponentClass` is implicitly required.
   *
   * @param ComponentClass - Component class to watch.
   * @param callback - Receives the entity and modified component instance.
   * @returns This query, for chaining.
   *
   * @example
   * ```ts
   * world.system("RenderPosition")
   *   .update(Position, (e, pos) => sprite.setPosition(pos.x, pos.y));
   * ```
   */
  public update<C extends ComponentType>(
    ComponentClass: C,
    callback: (e: Entity, c: InstanceType<C>) => void
  ): this;

  /**
   * Like {@link update}, but with extra components injected from the same
   * entity.
   *
   * @param ComponentClass - Component class to watch.
   * @param inject - Additional component classes to resolve from the entity.
   * @param callback - Receives the entity, modified component, and injected tuple.
   * @returns This query, for chaining.
   */
  public update<C extends ComponentType, J extends InjectTuple>(
    ComponentClass: C,
    inject: readonly [...J],
    callback: (e: Entity, c: InstanceType<C>, injected: MaybeResolvedInjectTuple<J, R>) => void
  ): this;

  /**
   * As above, but pass `Entity` first to make the entity-first signature
   * explicit. Identical behavior to the no-marker form.
   */
  public update<C extends ComponentType, J extends InjectTuple>(
    cursor: typeof Entity,
    ComponentClass: C,
    inject: readonly [...J],
    callback: (e: Entity, c: InstanceType<C>, injected: MaybeResolvedInjectTuple<J, R>) => void
  ): this;

  /**
   * As above, but pass `Entity` and omit the injection tuple for the
   * no-injection form. Identical behavior to the no-marker form.
   */
  public update<C extends ComponentType>(
    cursor: typeof Entity,
    ComponentClass: C,
    callback: (e: Entity, c: InstanceType<C>) => void
  ): this;

  /**
   * As above, but pass `Iter` first to receive a reused {@link Iter} cursor
   * instead of the bare entity. The cursor exposes the visited entity
   * (`it.entity`) and, in `it.src`, the source entity each resolved component
   * was read from.
   */
  public update<C extends ComponentType, J extends InjectTuple>(
    cursor: typeof Iter,
    ComponentClass: C,
    inject: readonly [...J],
    callback: (it: Iter, c: InstanceType<C>, injected: MaybeResolvedInjectTuple<J, R>) => void
  ): this;

  public update<C extends ComponentType>(
    arg0: C | typeof Entity | typeof Iter,
    arg1: C | readonly InjectElement[] | ((...args: any[]) => void),
    arg2?: readonly InjectElement[] | ((...args: any[]) => void),
    arg3?: (...args: any[]) => void
  ): this {
    this._assertConfigurable();
    const useIter = wantsIter(arg0);
    if (isCursorMarker(arg0)) {
      arg0 = arg1 as C;
      arg1 = arg2 as readonly InjectElement[];
      arg2 = arg3 as (...args: any[]) => void;
    }
    const ComponentClass = arg0 as C;
    const componentEid = this.world.entity(ComponentClass).eid;
    if (typeof arg1 === "function") {
      const callback = arg1 as (...args: any[]) => void;
      this._componentUpdateCallbacks.set(componentEid, callback);
    } else {
      const components = arg1 as readonly InjectElement[];
      const callback = arg2 as (...args: any[]) => void;
      const inject = mapInject(this.world, components);
      const arity = injectArity(inject);
      // One tuple (and one cursor) reused across invocations; the callback
      // consumes them synchronously and must not retain them (see doc).
      const injected = new Array(arity);
      if (useIter) {
        const it = new Iter(arity);
        const cb = (e: Entity, c: ComponentInstance) => {
          it.entity = e;
          getInjectedWithSrc(e, inject, injected, it.src);
          callback(it, c as InstanceType<C>, injected as any);
        };
        this._componentUpdateCallbacks.set(componentEid, cb);
      } else {
        const cb = (e: Entity, c: ComponentInstance) => {
          getInjected(e, inject, false, injected);
          callback(e, c as InstanceType<C>, injected as any);
        };
        this._componentUpdateCallbacks.set(componentEid, cb);
      }
    }
    this._watchlistBitmask.add(componentEid);
    if (!this._hasExplicitQuery) {
      this._dsl = this._watchlistBitmask.indices();
    }
    return this;
  }

  /**
   * Switch the tracked set to a sorted ordering: matched entities are stored
   * in the position determined by `compare`, which receives each entity and a
   * tuple of resolved component instances for each pair being ordered.
   *
   * Implies {@link track}.
   *
   * @param components - Component classes to resolve and pass to `compare`.
   * @param compare - Negative when `entityA` should sort before `entityB`, zero
   *   for equality, positive when `entityA` should sort after `entityB`.
   * @returns This query, for chaining.
   *
   * @example
   * ```ts
   * world.system("Render")
   *   .requires(Position, Sprite)
   *   .sort([Position], (_entityA, [posA], _entityB, [posB]) => posA.z - posB.z);
   * ```
   */
  public sort<J extends InjectTuple>(
    components: readonly [...J],
    compare: (
      entityA: Entity,
      a: MaybeResolvedInjectTuple<J, R>,
      entityB: Entity,
      b: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;

  /**
   * As above, but pass `Entity` first to make the entity-first signature
   * explicit. Identical behavior to the no-marker form.
   */
  public sort<J extends InjectTuple>(
    cursor: typeof Entity,
    components: readonly [...J],
    compare: (
      entityA: Entity,
      a: MaybeResolvedInjectTuple<J, R>,
      entityB: Entity,
      b: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;

  /**
   * As above, but pass `Iter` first. The comparator receives two reused
   * {@link Iter} cursors with `.entity` and `.src` populated per side, plus
   * the resolved component tuples.
   */
  public sort<J extends InjectTuple>(
    cursor: typeof Iter,
    components: readonly [...J],
    compare: (
      a: Iter,
      aResolved: MaybeResolvedInjectTuple<J, R>,
      b: Iter,
      bResolved: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;

  public sort(
    arg0: readonly InjectElement[] | typeof Entity | typeof Iter,
    arg1?: readonly InjectElement[] | Function,
    arg2?: Function
  ): this {
    this._assertConfigurable();
    const useIter = wantsIter(arg0);
    const components = (isCursorMarker(arg0) ? arg1 : arg0) as readonly InjectElement[];
    const cb = (isCursorMarker(arg0) ? arg2 : arg1) as (...args: unknown[]) => number;
    const inject = mapInject(this.world, components);
    const arity = injectArity(inject);
    this._tracking = true;
    if (useIter) {
      const itA = new Iter(arity);
      const itB = new Iter(arity);
      const resolvedA = new Array(arity);
      const resolvedB = new Array(arity);
      this._entities = new OrderedSet<Entity>((a, b) => {
        itA.entity = a;
        itB.entity = b;
        getInjectedWithSrc(a, inject, resolvedA, itA.src);
        getInjectedWithSrc(b, inject, resolvedB, itB.src);
        return cb(itA, resolvedA, itB, resolvedB);
      });
    } else {
      const resolvedA = new Array(arity);
      const resolvedB = new Array(arity);
      this._entities = new OrderedSet<Entity>((a, b) => {
        getInjected(a, inject, false, resolvedA);
        getInjected(b, inject, false, resolvedB);
        return cb(a, resolvedA, b, resolvedB);
      });
    }
    return this;
  }

  /**
   * Set the entity-membership predicate using a {@link QueryDSL} expression.
   *
   * Replaces any previous predicate. The optional `_guaranteed` tuple is a
   * pure type-level hint: it tells {@link sort} / {@link forEach} /
   * {@link update} callbacks which components are guaranteed present on every
   * matched entity, eliminating `| undefined` from those positions. It has no
   * effect at runtime.
   *
   * @param q - Query expression.
   * @param _guaranteed - Component classes guaranteed present on every matched
   *   entity (type hint only — not validated at runtime).
   * @returns This query, retyped with the guaranteed tuple as its `R`.
   *
   * @example
   * ```ts
   * world.system("Move")
   *   .query({ all: [Position, Velocity] }, [Position, Velocity])
   *   .each([Position, Velocity], (e, [pos, vel]) => {
   *     pos.x += vel.vx;  // no ! needed
   *   });
   * ```
   */
  public query<T extends ComponentType[] = []>(
    q: QueryDSL,
    _guaranteed?: readonly [...T]
  ): Query<T> {
    this._assertConfigurable();
    this._dsl = q;
    this._hasExplicitQuery = true;
    return this as unknown as Query<T>;
  }

  /**
   * Shorthand for `query([...components])`: track entities that have **all**
   * of the listed component types.
   *
   * Equivalent to `query(components)`. Unlike `query`, the listed
   * components are also recorded in the type parameter `R`, so {@link sort}
   * and {@link forEach} callbacks see them as non-nullable.
   *
   * @param components - Component classes to require.
   * @returns This query, retyped with the required tuple as its `R`.
   */
  public requires<T extends ComponentType[]>(...components: [...T]): Query<T> {
    this.query(components);
    return this as unknown as Query<T>;
  }

  /**
   * Permanently remove this query from the world.
   *
   * Every entity that currently belongs to this query has the membership
   * silently purged (no `exit` callbacks fire), the tracked set is cleared,
   * and the backing entity is destroyed. Calling any method on the query
   * afterwards is **undefined behavior**.
   */
  public destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this.world._removeQuery(this);
    this._entities?.clear();
    this._entities = undefined;
    this._tracking = false;
    if (!this.entity._destroyed && this.entity.get(Query) === this) {
      this.entity.destroy();
    }
  }

  private _matchedEntities(): ReadonlySet<Entity> | Term {
    if (!this._tracking) {
      return EMPTY_ENTITIES;
    }
    return this._entities ?? this.rootTerm ?? EMPTY_ENTITIES;
  }
}
