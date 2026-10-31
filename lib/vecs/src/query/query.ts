import {
  type ComponentClass,
  type ComponentInstance,
  type ComponentRef,
  type ComponentType,
  type Relationship,
} from "../component.js";
import {
  _resolveRelationship,
  containsDownTerm,
  isQueryConfig,
  type ExtractSpecsRequired,
  type QueryDSL,
  type QuerySpec,
} from "../dsl.js";
import { Entity, type EID } from "../entity/index.js";
import {
  forEachInjected,
  getInjected,
  injectArity,
  injectWatchEids,
  Iter,
  mapInject,
  type FanInjectCallbackArg,
  type FanInjectElement,
  type FanInjectTuple,
  type InjectedCallback,
  type InjectElement,
  type InjectTuple,
  type MaybeResolvedInjectTuple,
  type RequiredResolvedInjectTuple,
  type ClockInject,
  type ComponentInjectElement,
  type ComponentInjectTuple,
  type ComponentFanInjectTuple,
  type InjectClock,
} from "../inject.js";
import { Exclusive, SilenceSource, Traversable } from "../modules/relationships.js";
import { TermConsumer, TermEventKind, type Term } from "../terms/term.js";
import { ArrayMap } from "../util/array_map.js";
import { Bitset } from "../util/bitset.js";
import { OrderedSet } from "../util/ordered_set.js";
import { type World } from "../world/index.js";
import {
  makeEnterExitCallback,
  makeSortedEntitySet,
  makeUpdateRegistration,
  type ComponentCallback,
  type EntityCallback,
  type InjectSnapshotter,
} from "./callbacks.js";
import { SOURCE_TRACKED_QUERY_ERROR } from "./constants.js";
import { type Group } from "./group.js";
import { type GroupedQuery } from "./grouped_query.js";
import { Grouping } from "./grouping.js";
import type {
  CascadeOptions,
  EntityCursorOption,
  FanInjectCallbackOptions,
  GroupByOptions,
  InjectCallbackOptions,
  IterCursorOption,
  OrderByOptions,
  UpdateCallbackOptions,
} from "./options.js";

const EMPTY_ENTITIES: ReadonlySet<Entity> = new Set();
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
 *   (declared via {@link with} or the `hint` field of a {@link QueryConfig}).
 *   Components in `R` appear as non-nullable in {@link orderBy}, {@link forEach},
 *   and {@link update} callback tuples.
 * @typeParam K - Clock tokens permitted by a System subclass; standalone queries default to none.
 */
export class Query<
  R extends ComponentType[] = [],
  K extends ClockInject = never,
> implements TermConsumer {
  /** True when membership or watched component data changed since the last reset. */
  public changed = false;
  /** @internal DSL predicate used to build the root membership term. */
  public _dsl: QueryDSL | undefined = undefined;
  /** Entity that stores this query as a component and carries query traits. */
  public readonly entity: Entity;
  /** @internal `enter` callback (already wraps any injection logic). */
  public _enterCallback: EntityCallback | undefined = undefined;
  /** @internal `exit` callback (already wraps any injection logic). */
  public _exitCallback: EntityCallback | undefined = undefined;
  /** @internal Captures exit injection values and sources before membership teardown. */
  public _exitSnapshotter: InjectSnapshotter | undefined = undefined;
  /** @internal Captures enter injection values and sources for queued System callbacks. */
  public _enterSnapshotter: InjectSnapshotter | undefined = undefined;
  /** Materialized root term that owns membership for this query. */
  public rootTerm: Term | undefined = undefined;
  /** @internal Silence-domain query cache. */
  public _silenceQuery: { has(e: Entity): boolean } | undefined = undefined;
  /** @internal Whether membership APIs are enabled for this query. */
  public _tracking = false;
  /** @internal Bitmask of component eids this query reacts to via `update`. */
  public _watchlistBitmask: Bitset = new Bitset();
  /** @internal Update callback eids opted into entry-time dispatch. */
  public _onEnterUpdateEids: EID[] = [];
  /**
   * @internal `true` when {@link _notifyModified} only queues an event and never
   * runs a callback synchronously (systems). Lets entities route `modified`
   * events through the world's per-component watcher index.
   */
  public _queuesUpdates = false;

  /** @internal `true` once this query has been registered with its world. */
  protected _built = false;
  /** @internal Guards destroy hooks against recursive removal. */
  protected _destroyed = false;
  /** @internal Sorted projection. Unsorted membership is read from `rootTerm`. */
  protected _entities: Set<Entity> | undefined = undefined;
  /** @internal Optional live bucket index configured by groupBy. */
  protected _grouping: Grouping | undefined = undefined;
  /** @internal `true` once `with` has set an explicit predicate. */
  protected _hasExplicitQuery: boolean = false;
  /** @internal Per-component-eid `update` callbacks. */
  protected _componentUpdateCallbacks = new ArrayMap<ComponentCallback>();
  /** @internal Component class for membership checks. */
  protected _queryComponentClass: ComponentType;
  /** @internal Root term subscription handle. */
  protected _unsubscribeTerm: (() => void) | undefined = undefined;
  /**
   * @internal Component eids read by the `orderBy` comparator's inject tuple
   * (plus, for `cascade`, the relationship eid). When one of these changes on
   * a tracked entity, `_entities` (an `OrderedSet`) is marked dirty so the
   * next ordered read re-sorts.
   */
  protected _orderByWatch: Set<EID> | undefined = undefined;

  constructor(name: string, world: World, track: boolean = true) {
    this._queryComponentClass = Query as ComponentType;
    this.entity = world.entity();
    this.entity.name = name;
    this.entity.attach(Query as ComponentType, this);
    world._addUnbuiltQuery(this as any);
    if (track) {
      this.track();
    }
  }

  /* -------------------------------------------------------------------------
   * Identity And Membership Views
   * -------------------------------------------------------------------------
   * Read-only accessors over the backing entity and current matched set. These
   * methods do not change query configuration or world registration state.
   */

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

  public get count(): number {
    if (!this._tracking) {
      return 0;
    }
    return this._entities?.size ?? this.rootTerm?.count ?? 0;
  }

  /** Number of live buckets. Throws with the query name when not grouped. */
  public get groupCount(): number {
    return this._requireGrouping().groups.size;
  }

  /**
   * Look up a live bucket. Use groupBy's return type for typed keys and members.
   * Throws with the query name when not grouped.
   */
  public group(key: unknown): Group<unknown, R> | undefined {
    return this._requireGrouping().get(key) as Group<unknown, R> | undefined;
  }

  /** Iterate live buckets. Throws with the query name when not grouped. */
  public groups(): IterableIterator<Group<unknown, R>> {
    return this._requireGrouping().groups.values() as IterableIterator<Group<unknown, R>>;
  }

  /** Iterate live bucket keys. Throws with the query name when not grouped. */
  public groupKeys(): IterableIterator<unknown> {
    return this._requireGrouping().keys();
  }

  public [Symbol.iterator](): IterableIterator<Entity> {
    return this._matchedEntities()[Symbol.iterator]();
  }

  public belongs(e: Entity): boolean {
    return this.rootTerm?.has(e) ?? false;
  }

  public has(e: Entity): boolean {
    if (!this._tracking) {
      return false;
    }
    return this._entities?.has(e) ?? this.rootTerm?.has(e) ?? false;
  }

  public forEach(callback: (e: Entity) => void): this;
  public forEach<const J extends ComponentFanInjectTuple>(
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public forEach<const J extends ComponentFanInjectTuple>(
    options: EntityCursorOption & FanInjectCallbackOptions<J>,
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public forEach<const J extends ComponentFanInjectTuple>(
    options: IterCursorOption & FanInjectCallbackOptions<J>,
    callback: (it: Iter, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public forEach(arg0: ((e: Entity) => void) | FanInjectCallbackArg, arg1?: Function): this {
    this.changed = false;
    this._forEach(arg0, arg1);
    return this;
  }

  /**
   * @internal Iterate the matched entities with injection, **without**
   * consuming the {@link changed} flag. Used by `System.each`, which runs every
   * tick and must not reset `changed` (that flag tracks whether membership or
   * watched data changed since the caller last read it).
   */
  protected _forEach(arg0: ((e: Entity) => void) | FanInjectCallbackArg, arg1?: Function): void {
    forEachInjected(this.world, this._matchedEntities(), arg0, arg1 as InjectedCallback);
  }

  public toString(): string {
    return this.name ?? "";
  }

  /* -------------------------------------------------------------------------
   * Predicate And Membership Configuration
   * -------------------------------------------------------------------------
   * Fluent builder methods that decide which entities belong to the query and
   * how that membership is tracked, ordered, grouped, or source-filtered.
   */

  public with<const S extends readonly QuerySpec[]>(
    ...specs: [...S]
  ): Query<[...R, ...ExtractSpecsRequired<S>], K> {
    this._assertConfigurable();
    const terms: QueryDSL[] = [];
    let cascade: ComponentRef | undefined;

    for (const spec of specs) {
      if (isQueryConfig(spec)) {
        terms.push(spec.with);
        if (spec.cascade !== undefined) {
          cascade = spec.cascade;
        }
      } else {
        terms.push(spec);
      }
    }

    this._dsl = this._dsl === undefined ? { all: terms } : { all: [this._dsl, ...terms] };
    this._hasExplicitQuery = true;
    if (cascade !== undefined) {
      this.cascade(cascade);
    }
    return this as unknown as Query<any>;
  }

  public without(dsl: QueryDSL): this {
    this.with({ not: dsl });
    return this;
  }

  public track(): this {
    this._assertConfigurable();
    this._tracking = true;
    return this;
  }

  public orderBy<const J extends ComponentInjectTuple>(
    components: readonly [...J],
    compare: (
      entityA: Entity,
      a: MaybeResolvedInjectTuple<J, R>,
      entityB: Entity,
      b: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;
  public orderBy<const J extends ComponentInjectTuple>(
    options: EntityCursorOption & OrderByOptions<J>,
    compare: (
      entityA: Entity,
      a: MaybeResolvedInjectTuple<J, R>,
      entityB: Entity,
      b: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;
  public orderBy<const J extends ComponentInjectTuple>(
    options: IterCursorOption & OrderByOptions<J>,
    compare: (
      a: Iter,
      aResolved: MaybeResolvedInjectTuple<J, R>,
      b: Iter,
      bResolved: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;
  public orderBy(
    arg0: readonly InjectElement[] | OrderByOptions<InjectTuple>,
    arg1?: Function
  ): this {
    this._assertConfigurable();
    this._tracking = true;
    const { set, watchEids } = makeSortedEntitySet(this.world, arg0, arg1);
    this._entities = set;
    this._watchOrderBy(watchEids);
    return this;
  }

  public cascade(rel: ComponentRef): this;
  public cascade(options: CascadeOptions): this;
  public cascade(rel: ComponentRef, compare: (a: Entity, b: Entity) => number): this;
  public cascade(options: CascadeOptions, compare: (a: Entity, b: Entity) => number): this;
  public cascade(
    arg0: ComponentRef | CascadeOptions,
    compare?: (a: Entity, b: Entity) => number
  ): this {
    this._assertConfigurable();
    const rel = isRelationshipOptions(arg0) ? arg0.relationship : arg0;
    const relEntity = this.world.entity(rel);
    const relMeta = relEntity.meta;
    if (!relMeta.isRelationship) {
      throw new Error(`Component ${relMeta.Class.name} is not a Relationship`);
    }

    const traversable = relEntity.get(Traversable);
    if (!traversable) {
      throw new Error(`Relationship ${relMeta.Class.name} does not have the Traversable trait`);
    }
    if (!relEntity.has(Exclusive)) {
      throw new Error(`Relationship ${relMeta.Class.name} does not have the Exclusive trait`);
    }

    const depths = traversable.depths;
    this.orderBy([], (a, _ra, b) => {
      const da = depths.get(a) ?? -1;
      const db = depths.get(b) ?? -1;
      return da - db || compare?.(a, b) || 0;
    });
    this._watchOrderBy([relMeta.eid]);
    return this;
  }

  /**
   * Partition this query into live buckets by injected values or relationship
   * targets. Returns the same object typed as GroupedQuery, and enables tracking.
   * @throws When already built or grouped. Systems do not support grouping.
   */
  public groupBy<K, const J extends ComponentFanInjectTuple>(
    components: readonly [...J],
    key: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => K
  ): GroupedQuery<K, R>;
  public groupBy<K, const J extends ComponentFanInjectTuple>(
    options: GroupByOptions<J>,
    key: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => K
  ): GroupedQuery<K, R>;
  public groupBy(relationship: ComponentRef): GroupedQuery<Entity, R>;
  public groupBy(options: { relationship: ComponentRef }): GroupedQuery<Entity, R>;
  public groupBy(
    arg0:
      | readonly FanInjectElement[]
      | ComponentRef
      | GroupByOptions<FanInjectTuple>
      | { relationship: ComponentRef },
    arg1?: (e: Entity, resolved: any) => any
  ): GroupedQuery<unknown, R> {
    this._assertConfigurable();
    if (this._grouping !== undefined) {
      throw new Error(`query '${this.name}' is already grouped`);
    }
    if (isGroupByInjectOptions(arg0)) {
      arg0 = arg0.inject;
    } else if (isRelationshipOptions(arg0)) {
      arg0 = arg0.relationship;
    }
    let keysOf: (e: Entity) => Iterable<unknown>;
    let watchEids: EID[];
    if (typeof arg1 === "function") {
      const components = arg0 as readonly FanInjectElement[];
      const inject = mapInject(this.world, components);
      const resolved = new Array(injectArity(inject));
      keysOf = (e: Entity) => {
        getInjected(e, inject, false, resolved);
        return [arg1(e, resolved)];
      };
      watchEids = injectWatchEids(inject);
      this._composeGroupMembership(components);
    } else {
      const relEid = _resolveRelationship(arg0 as ComponentRef, this.world);
      keysOf = (e: Entity) => e.targets(relEid);
      watchEids = [relEid];
      this._composeGroupMembership([arg0 as ComponentRef]);
    }
    for (const ceid of watchEids) {
      this._watchlistBitmask.add(ceid);
    }
    this.track();
    this._grouping = new Grouping(this.world, keysOf, watchEids);
    return this as GroupedQuery<unknown, R>;
  }

  /** Configure bucket creation before building; throws when not grouped. */
  public onGroupEnter(callback: (group: Group<unknown, R>) => void): this {
    const grouping = this._requireGrouping();
    this._assertConfigurable();
    grouping.setOnGroupEnter(callback as (group: Group) => void);
    return this;
  }

  /** Configure bucket removal before building; throws when not grouped. */
  public onGroupExit(callback: (key: unknown, group: Group<unknown, R>) => void): this {
    const grouping = this._requireGrouping();
    this._assertConfigurable();
    grouping.setOnGroupExit(callback as (key: unknown, group: Group) => void);
    return this;
  }

  public ignoreSource(source: QueryDSL | Query): this {
    this._assertConfigurable();
    const query =
      typeof source === "object" && !Array.isArray(source) && "entity" in source
        ? source
        : this._buildSilenceQuery(source);
    this.entity.add(SilenceSource, query.entity);
    this._silenceQuery = query;
    return this;
  }

  public add<C extends ComponentClass>(
    Class: C,
    ...target: InstanceType<C> extends Relationship ? [target: ComponentRef] : []
  ): this;
  public add(ceid: EID, target?: ComponentRef): this;
  public add(entity: Entity, target?: ComponentRef): this;
  public add(ref: ComponentRef, target?: ComponentRef): this {
    this.entity.add(ref as any, target as any);
    return this;
  }

  public remove<C extends ComponentType>(Class: C): this;
  public remove(ceid: EID): this;
  public remove(entity: Entity): this;
  public remove(ref: ComponentRef): this {
    this.entity.remove(ref as any);
    return this;
  }

  public set<C extends ComponentClass>(Class: C, props: Partial<InstanceType<C>>): this;
  public set(ceid: EID, props: Partial<ComponentInstance>): this;
  public set(entity: Entity, props: Partial<ComponentInstance>): this;
  public set(ref: ComponentRef, props: Partial<ComponentInstance>): this {
    this.entity.set(ref as any, props);
    return this;
  }

  /* -------------------------------------------------------------------------
   * Reactive Callback Configuration
   * -------------------------------------------------------------------------
   * Fluent builder methods that install user callbacks for membership entry,
   * membership exit, and watched component updates.
   * ------------------------------------------------------------------------- */

  /** Register an entry callback; clock tokens require a System processing tick. */
  public enter<const J extends readonly (ComponentInjectElement | K)[]>(
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public enter<const J extends readonly (ComponentInjectElement | K)[]>(
    options: EntityCursorOption & InjectCallbackOptions<J>,
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public enter<const J extends readonly (ComponentInjectElement | K)[]>(
    options: IterCursorOption & InjectCallbackOptions<J>,
    callback: (it: Iter, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public enter(callback: (e: Entity) => void): this;
  public enter<const J extends InjectTuple>(
    arg0: InjectTuple | InjectCallbackOptions<J> | ((e: Entity) => void),
    arg1?: Function
  ): this {
    this._assertConfigurable();
    const enter = makeEnterExitCallback(this.world, arg0, arg1, this._getInjectClock());
    this._enterCallback = enter.callback;
    this._enterSnapshotter = enter.snapshotter;
    return this;
  }

  /** Register an exit callback; components are snapshotted, system clocks are filled at replay. */
  public exit<const J extends readonly (ComponentInjectElement | K)[]>(
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public exit<const J extends readonly (ComponentInjectElement | K)[]>(
    options: EntityCursorOption & InjectCallbackOptions<J>,
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public exit<const J extends readonly (ComponentInjectElement | K)[]>(
    options: IterCursorOption & InjectCallbackOptions<J>,
    callback: (it: Iter, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public exit(callback: (e: Entity) => void): this;
  public exit<const J extends InjectTuple>(
    arg0: readonly [...J] | InjectCallbackOptions<J> | ((e: Entity) => void),
    arg1?: (...args: any[]) => void
  ): this {
    this._assertConfigurable();
    const exit = makeEnterExitCallback(this.world, arg0, arg1, this._getInjectClock());
    this._exitCallback = exit.callback;
    this._exitSnapshotter = exit.snapshotter;
    return this;
  }

  /**
   * Register one update callback for a watched component.
   *
   * `update(ComponentClass, callback)` keeps the common component-only form.
   * Use `update({ watch, inject, cursor }, callback)` when the callback
   * needs injected components or an {@link Iter} cursor.
   * System callbacks may also inject `Now` and `Delta`, both non-optional numbers
   * from the processing tick. Standalone query callbacks cannot inject clocks.
   *
   * `update` also adds the watched component to the query predicate, so the
   * callback only observes entities that carry it. The callback fires when the
   * component is set or marked modified on a matched entity. Pass
   * `{ watch: ComponentClass, onEnter: true }` when the callback should also fire
   * when a matched entity enters with the watched component already present.
   * Calling `update` more than once for the same component on one query or
   * system is rejected instead of replacing the previous callback.
   *
   * @throws When this query has already been built, when `ComponentClass`
   *   already has an update callback on this query.
   */
  public update<C extends ComponentType>(
    ComponentClass: C,
    callback: (e: Entity, c: InstanceType<C>) => void
  ): this;
  public update<C extends ComponentType, const J extends readonly (ComponentInjectElement | K)[]>(
    options: EntityCursorOption & UpdateCallbackOptions<C, J> & { inject: readonly [...J] },
    callback: (e: Entity, c: InstanceType<C>, injected: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public update<C extends ComponentType, const J extends readonly (ComponentInjectElement | K)[]>(
    options: IterCursorOption & UpdateCallbackOptions<C, J> & { inject: readonly [...J] },
    callback: (it: Iter, c: InstanceType<C>, injected: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public update<C extends ComponentType>(
    options: EntityCursorOption & UpdateCallbackOptions<C, []>,
    callback: (e: Entity, c: InstanceType<C>) => void
  ): this;
  public update<C extends ComponentType>(
    options: IterCursorOption & UpdateCallbackOptions<C, []>,
    callback: (it: Iter, c: InstanceType<C>) => void
  ): this;
  public update<C extends ComponentType>(
    arg0: C | UpdateCallbackOptions<C, readonly (ComponentInjectElement | K)[]>,
    callback: (e: Entity, c: InstanceType<C>) => void
  ): this;
  public update<C extends ComponentType>(
    arg0: C | UpdateCallbackOptions<C, InjectTuple>,
    arg1: (...args: any[]) => void
  ): this {
    this._assertConfigurable();
    const { componentEid, callback, onEnter } = makeUpdateRegistration(
      this.world,
      arg0,
      arg1,
      this._getInjectClock()
    );
    if (this._componentUpdateCallbacks.has(componentEid)) {
      const componentName = this.world.entity(componentEid).meta.Class.name;
      throw new Error(
        `query '${this.name}' already has an update callback for component ${componentName}`
      );
    }
    this._componentUpdateCallbacks.set(componentEid, callback);
    this._watchlistBitmask.add(componentEid);
    if (onEnter) {
      this._onEnterUpdateEids.push(componentEid);
    }
    return this.with(componentEid) as unknown as this;
  }

  /* -------------------------------------------------------------------------
   * World Registration And Routing Hooks
   * -------------------------------------------------------------------------
   * Public internals called by World, terms, and System subclasses to register,
   * destroy, and route membership/update events through the query.
   */

  public build(): this {
    if (this.built) {
      return this;
    }
    if (this.world.deferred) {
      this.world._addUnbuiltQuery(this as any);
      return this;
    }
    return this._build();
  }

  /** @internal */
  public _build(): this {
    if (this.built) {
      return this;
    }
    if (!this._isBuildable()) {
      this.destroy();
      return this;
    }
    this.world._removeUnbuiltQuery(this as any);
    if (this._dsl !== undefined) {
      if (this._tracking && containsDownTerm(this._dsl)) {
        this.destroy();
        throw new Error(SOURCE_TRACKED_QUERY_ERROR);
      }
      this.rootTerm = this.world.getTerm(this._dsl);
      this._unsubscribeTerm = this.rootTerm.subscribe(this);
    }
    this.world._addQuery(this as any);
    this._built = true;
    this._backfill();
    return this;
  }

  /** @internal */
  public _clearSilence(): void {
    this._silenceQuery = undefined;
  }

  /** Release membership and grouping state; subsequent group access throws. */
  public destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this._grouping?.clear();
    this._grouping = undefined;
    this.world._removeQuery(this as any);
    this._entities?.clear();
    this._entities = undefined;
    this._tracking = false;
    if (this.entity.alive && this.entity.get(this._queryComponentClass) !== undefined) {
      this.entity.destroy();
    }
  }

  /** Extension hook for subclasses that need to observe query membership entry. */
  protected _enter(e: Entity): void {
    this._grouping?.enter(e);
    this.changed = true;
    this._entities?.add(e);
    e._addQueryMembership(this as any);
    this._enterCallback?.(e);
    for (const ceid of this._onEnterUpdateEids) {
      const c = e._get(ceid);
      if (c !== undefined) {
        this._notifyModified(e, ceid, c);
      }
    }
  }

  /** Extension hook for subclasses that need to observe query membership exit. */
  protected _exit(e: Entity): void {
    this.changed = true;
    this._exitCallback?.(e);
    this._entities?.delete(e);
    e._removeQueryMembership(this as any);
    this._grouping?.exit(e);
  }

  /** @internal */
  public _notifyModified(e: Entity, ceid: EID, c: ComponentInstance): void {
    if (!this._watchlistBitmask.has(ceid)) {
      return;
    }
    if (this._orderByWatch?.has(ceid) && this._entities instanceof OrderedSet) {
      this._entities.markDirty();
    }
    if (this._isSourceSilenced()) {
      return;
    }
    this.changed = true;
    const callback = this._componentUpdateCallbacks.get(ceid);
    if (callback) {
      callback(e, c);
    }
    // Silenced writes return above, so they cannot leak through group membership.
    this._grouping?.refresh(e, ceid);
  }

  public onTermEvent(kind: TermEventKind, entity: Entity): void {
    if (kind === TermEventKind.Enter) {
      this._enter(entity);
    } else {
      this._exit(entity);
    }
  }

  /** @internal */
  public _unsubscribeRootTerm(): void {
    this._unsubscribeTerm?.();
    this._unsubscribeTerm = undefined;
    this.rootTerm = undefined;
  }

  /** @internal */
  public _watchesUpdates(): boolean {
    return (
      this._grouping !== undefined ||
      this._componentUpdateCallbacks.size > 0 ||
      (this._orderByWatch?.size ?? 0) > 0
    );
  }

  /** @internal Throw when a builder method is called after registration. */
  protected _assertConfigurable(): void {
    if (this.built) {
      throw new Error(`query '${this.name}' has already been built`);
    }
  }

  /** @internal Build-time clock provider; standalone callbacks have no processing clock. */
  protected _getInjectClock(): InjectClock | undefined {
    return undefined;
  }

  /** @internal */
  protected _backfill(): void {
    if (!this.rootTerm || !this._needsBackfill()) {
      return;
    }
    this.world.defer(() => {
      for (const e of this.rootTerm ?? EMPTY_ENTITIES) {
        this._enter(e);
      }
    });
  }

  /** @internal Whether this object has enough configuration to enter the world. */
  protected _isBuildable(): boolean {
    return this._dsl !== undefined;
  }

  /** @internal Whether build-time matches are observable and need routing. */
  protected _needsBackfill(): boolean {
    return (
      this._tracking ||
      this._enterCallback !== undefined ||
      this._exitCallback !== undefined ||
      this._watchesUpdates()
    );
  }

  /** @internal */
  protected _isSourceSilenced(): boolean {
    const source = this.entity.world._routingSource;
    return source !== undefined && this._silenceQuery?.has(source) === true;
  }

  /** @internal */
  protected _matchedEntities(): ReadonlySet<Entity> | Term {
    if (!this._tracking) {
      return EMPTY_ENTITIES;
    }
    return this._entities ?? this.rootTerm ?? EMPTY_ENTITIES;
  }

  private _buildSilenceQuery(dsl: QueryDSL): Query {
    const q = this.world.query(`${this.name}:silence`).with(dsl);
    q.entity.childOf(this.entity);
    return q;
  }

  private _composeGroupMembership(refs: readonly unknown[]): void {
    const componentRefs = refs.filter(
      (ref): ref is ComponentRef =>
        typeof ref === "number" || typeof ref === "function" || ref instanceof Entity
    );
    if (componentRefs.length === 0) {
      return;
    }
    const existing: QueryDSL = this._dsl ?? true;
    this._dsl = { all: [existing, ...componentRefs] };
    this._hasExplicitQuery = true;
  }

  private _requireGrouping(): Grouping {
    if (this._grouping === undefined) {
      throw new Error(`query '${this.name}' is not grouped`);
    }
    return this._grouping;
  }

  /**
   * @internal Register `eids` as `orderBy`-relevant: a change to any of them
   * on a tracked entity marks `_entities` (an `OrderedSet`) dirty so the next
   * ordered read re-sorts. Also adds them to `_watchlistBitmask` so
   * `_notifyModified` is reachable for them.
   */
  private _watchOrderBy(eids: readonly EID[]): void {
    if (eids.length === 0) {
      return;
    }
    this._orderByWatch ??= new Set();
    for (const eid of eids) {
      this._orderByWatch.add(eid);
      this._watchlistBitmask.add(eid);
    }
  }
}

function isOptionsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGroupByInjectOptions(value: unknown): value is GroupByOptions<FanInjectTuple> {
  return isOptionsObject(value) && "inject" in value;
}

function isRelationshipOptions(value: unknown): value is { relationship: ComponentRef } {
  return isOptionsObject(value) && "relationship" in value;
}
