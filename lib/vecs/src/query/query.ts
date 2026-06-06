import { type ComponentInstance, type ComponentRef, type ComponentType } from "../component.js";
import {
  containsDownTerm,
  isQueryConfig,
  type ExtractSpecsRequired,
  type QueryDSL,
  type QuerySpec,
} from "../dsl.js";
import { Entity, type EID } from "../entity/index.js";
import {
  forEachInjected,
  Iter,
  type FanInjectElement,
  type FanInjectTuple,
  type InjectElement,
  type InjectTuple,
  type MaybeResolvedInjectTuple,
  type RequiredResolvedInjectTuple,
} from "../inject.js";
import { SilenceSource, Traversable } from "../modules/relationships.js";
import { TermConsumer, TermEventKind, type Term } from "../terms/term.js";
import { ArrayMap } from "../util/array_map.js";
import { Bitset } from "../util/bitset.js";
import { OrderedSet } from "../util/ordered_set.js";
import { type World } from "../world/index.js";
import {
  makeEnterCallback,
  makeExitCallback,
  makeSortedEntitySet,
  makeUpdateRegistration,
  type ComponentCallback,
  type EntityCallback,
} from "./callbacks.js";
import { SOURCE_TRACKED_QUERY_ERROR } from "./constants.js";
import { getGroupedQueryPrototype } from "./grouped_query_registry.js";
import { type GroupedQuery } from "./grouped_query.js";

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
 *   (declared via {@link requires} or the `_guaranteed` hint of {@link where}).
 *   Components in `R` appear as non-nullable in {@link orderBy}, {@link forEach},
 *   and {@link update} callback tuples.
 */
export class Query<R extends ComponentType[] = []> implements TermConsumer {
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
  /** @internal Component eids the exit callback needs snapshotted before component removal. */
  public _exitSnapshotTypes: EID[] | undefined = undefined;
  /** Materialized root term that owns membership for this query. */
  public rootTerm: Term | undefined;
  /** @internal Silence-domain query cache. */
  public _silenceQuery: { has(e: Entity): boolean } | undefined;
  /** @internal Whether membership APIs are enabled for this query. */
  public _tracking = false;
  /** @internal Bitmask of component eids this query reacts to via `update`. */
  public _watchlistBitmask: Bitset = new Bitset();

  /** @internal `true` once this query has been registered with its world. */
  protected _built = false;
  /** @internal Guards destroy hooks against recursive removal. */
  protected _destroyed = false;
  /** @internal Sorted projection. Unsorted membership is read from `rootTerm`. */
  protected _entities: Set<Entity> | undefined;
  /** @internal `true` once `where` or `requires` has set an explicit predicate. */
  protected _hasExplicitQuery: boolean = false;
  /** @internal Per-component-eid `update` callbacks. */
  protected _componentUpdateCallbacks = new ArrayMap<ComponentCallback>();
  /** @internal Component class for membership checks. */
  protected _queryComponentClass: ComponentType;
  /** @internal Root term subscription handle. */
  protected _unsubscribeTerm: (() => void) | undefined;

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
  public forEach<J extends FanInjectTuple>(
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public forEach<J extends FanInjectTuple>(
    cursor: typeof Entity,
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public forEach<J extends FanInjectTuple>(
    cursor: typeof Iter,
    components: readonly [...J],
    callback: (it: Iter, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public forEach(arg0: unknown, arg1?: unknown, arg2?: unknown): this {
    this.changed = false;
    forEachInjected(this.world, this._matchedEntities(), arg0, arg1, arg2);
    return this;
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

  public where<const S extends readonly QuerySpec[]>(
    ...specs: [...S]
  ): Query<[...R, ...ExtractSpecsRequired<S>]> {
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

  public requires<const T extends ComponentType[]>(...components: [...T]): Query<[...R, ...T]> {
    this.where(components);
    return this as unknown as Query<[...R, ...T]>;
  }

  public track(): this {
    this._assertConfigurable();
    this._tracking = true;
    return this;
  }

  public orderBy<J extends InjectTuple>(
    components: readonly [...J],
    compare: (
      entityA: Entity,
      a: MaybeResolvedInjectTuple<J, R>,
      entityB: Entity,
      b: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;
  public orderBy<J extends InjectTuple>(
    cursor: typeof Entity,
    components: readonly [...J],
    compare: (
      entityA: Entity,
      a: MaybeResolvedInjectTuple<J, R>,
      entityB: Entity,
      b: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;
  public orderBy<J extends InjectTuple>(
    cursor: typeof Iter,
    components: readonly [...J],
    compare: (
      a: Iter,
      aResolved: MaybeResolvedInjectTuple<J, R>,
      b: Iter,
      bResolved: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;
  public orderBy(
    arg0: readonly InjectElement[] | typeof Entity | typeof Iter,
    arg1?: readonly InjectElement[] | Function,
    arg2?: Function
  ): this {
    this._assertConfigurable();
    this._tracking = true;
    this._entities = makeSortedEntitySet(this.world, arg0, arg1, arg2);
    return this;
  }

  public cascade(rel: ComponentRef): this;
  public cascade(rel: ComponentRef, compare: (a: Entity, b: Entity) => number): this;
  public cascade(rel: ComponentRef, compare?: (a: Entity, b: Entity) => number): this {
    this._assertConfigurable();
    const relEntity = this.world.entity(rel);
    const relMeta = relEntity.meta;
    if (!relMeta.isRelationship) {
      throw new Error(`Component ${relMeta.Class.name} is not a Relationship`);
    }

    const traversable = relEntity.get(Traversable);
    if (!traversable) {
      throw new Error(`Relationship ${relMeta.Class.name} does not have the Traversable trait`);
    }

    const depths = traversable.depths;
    this.orderBy([], (a, _ra, b) => {
      const da = depths.get(a) ?? -1;
      const db = depths.get(b) ?? -1;
      return da - db || compare?.(a, b) || 0;
    });
    this.update(relMeta.Class, (entity) => {
      this._reSortCascade(entity, relMeta.eid);
    });
    return this;
  }

  public groupBy<K, J extends FanInjectTuple>(
    components: readonly [...J],
    key: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => K
  ): GroupedQuery<K, R>;
  public groupBy(relationship: ComponentRef): GroupedQuery<Entity, R>;
  public groupBy(
    arg0: readonly FanInjectElement[] | ComponentRef,
    arg1?: (e: Entity, resolved: any) => any
  ): GroupedQuery<unknown, R> {
    this._assertConfigurable();
    Object.setPrototypeOf(this, getGroupedQueryPrototype());
    return (this as any)._initialize(arg0, arg1);
  }

  public ignoreSource(source: QueryDSL | Query): this {
    this._assertConfigurable();
    const query =
      typeof source === "object" && !Array.isArray(source) && "entity" in source
        ? source
        : this._buildSilenceQuery(source);
    this.entity.set(SilenceSource, { target: query.entity });
    this._silenceQuery = query;
    return this;
  }

  /* -------------------------------------------------------------------------
   * Reactive Callback Configuration
   * -------------------------------------------------------------------------
   * Fluent builder methods that install user callbacks for membership entry,
   * membership exit, and watched component updates.
   */

  public enter<J extends InjectTuple>(
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public enter<J extends InjectTuple>(
    cursor: typeof Entity,
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public enter<J extends InjectTuple>(
    cursor: typeof Iter,
    inject: readonly [...J],
    callback: (it: Iter, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public enter(callback: (e: Entity) => void): this;
  public enter<J extends InjectTuple>(
    arg0: InjectTuple | ((e: Entity) => void) | typeof Entity | typeof Iter,
    arg1?: InjectTuple | Function,
    arg2?: Function
  ): this {
    this._assertConfigurable();
    this._enterCallback = makeEnterCallback(this.world, arg0, arg1, arg2);
    return this;
  }

  public exit<J extends InjectTuple>(
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public exit<J extends InjectTuple>(
    cursor: typeof Entity,
    inject: readonly [...J],
    callback: (e: Entity, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public exit<J extends InjectTuple>(
    cursor: typeof Iter,
    inject: readonly [...J],
    callback: (it: Iter, injected: RequiredResolvedInjectTuple<J>) => void
  ): this;
  public exit(callback: (e: Entity) => void): this;
  public exit<J extends InjectTuple>(
    arg0: readonly [...J] | ((e: Entity) => void) | typeof Entity | typeof Iter,
    arg1?: readonly [...J] | ((...args: any[]) => void),
    arg2?: (...args: any[]) => void
  ): this {
    this._assertConfigurable();
    const exit = makeExitCallback(this.world, arg0, arg1, arg2);
    this._exitCallback = exit.callback;
    this._exitSnapshotTypes = exit.snapshotTypes;
    return this;
  }

  public update<C extends ComponentType>(
    ComponentClass: C,
    callback: (e: Entity, c: InstanceType<C>) => void
  ): this;
  public update<C extends ComponentType, J extends InjectTuple>(
    ComponentClass: C,
    inject: readonly [...J],
    callback: (e: Entity, c: InstanceType<C>, injected: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public update<C extends ComponentType, J extends InjectTuple>(
    cursor: typeof Entity,
    ComponentClass: C,
    inject: readonly [...J],
    callback: (e: Entity, c: InstanceType<C>, injected: MaybeResolvedInjectTuple<J, R>) => void
  ): this;
  public update<C extends ComponentType>(
    cursor: typeof Entity,
    ComponentClass: C,
    callback: (e: Entity, c: InstanceType<C>) => void
  ): this;
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
    const { componentEid, callback } = makeUpdateRegistration(this.world, arg0, arg1, arg2, arg3);
    this._componentUpdateCallbacks.set(componentEid, callback);
    this._watchlistBitmask.add(componentEid);
    if (!this._hasExplicitQuery) {
      this._dsl = this._watchlistBitmask.indices();
    }
    return this;
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

  public destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this.world._removeQuery(this as any);
    this._entities?.clear();
    this._entities = undefined;
    this._tracking = false;
    if (!this.entity._destroyed && this.entity.get(this._queryComponentClass) !== undefined) {
      this.entity.destroy();
    }
  }

  /** @internal */
  public _enter(e: Entity): void {
    this.changed = true;
    this._entities?.add(e);
    e._addQueryMembership(this as any);
    this._enterCallback?.(e);
    e.components.forEach((c, ceid) => {
      if (!this._watchlistBitmask.has(ceid)) {
        return;
      }
      this._notifyModified(e, ceid, c);
    });
  }

  /** @internal */
  public _exit(e: Entity): void {
    this.changed = true;
    this._exitCallback?.(e);
    this._entities?.delete(e);
    e._removeQueryMembership(this as any);
  }

  /** @internal */
  public _notifyModified(e: Entity, ceid: EID, c: ComponentInstance): void {
    if (!this._watchlistBitmask.has(ceid)) {
      return;
    }
    if (this._isSourceSilenced()) {
      return;
    }
    this.changed = true;
    const callback = this._componentUpdateCallbacks.get(ceid);
    if (callback) {
      callback(e, c);
    }
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
    return this._componentUpdateCallbacks.size > 0;
  }

  /** @internal Throw when a builder method is called after registration. */
  protected _assertConfigurable(): void {
    if (this.built) {
      throw new Error(`query '${this.name}' has already been built`);
    }
  }

  /** @internal */
  protected _backfill(): void {
    if (!this._tracking || !this.rootTerm) {
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
    const q = this.world.query(`${this.name}:silence`).where(dsl);
    q.entity.childOf(this.entity);
    return q;
  }

  private _reSortCascade(entity: Entity, relEid: EID): void {
    const entities = this._entities;
    if (entities instanceof OrderedSet) {
      entities.reSort(entity);
    }
    for (const child of entity._childrenByEid(relEid) ?? []) {
      this._reSortCascade(child, relEid);
    }
  }
}
