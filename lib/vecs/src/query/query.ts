import {
  type ComponentInstance,
  type ComponentMeta,
  type ComponentRef,
  type ComponentType,
} from "../component.js";
import {
  _resolveRelationship,
  containsDownTerm,
  type ExtractRequired,
  type QueryDSL,
} from "../dsl.js";
import { Entity } from "../entity/index.js";
import {
  directInjectEids,
  forEachInjected,
  getInjected,
  getInjectedWithSrc,
  injectArity,
  isCursorMarker,
  Iter,
  mapInject,
  wantsIter,
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

export const SOURCE_TRACKED_QUERY_ERROR =
  "source/children is not supported in a tracked query; use world.filter(...)";

const EMPTY_ENTITIES: ReadonlySet<Entity> = new Set();
const EMPTY_GROUPS: ReadonlyMap<unknown, Group> = new Map();

type EntityCallback = (e: Entity, snapshot?: Map<number, ComponentInstance>) => void;
type ComponentCallback = (e: Entity, c: ComponentInstance) => void;

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
  /** @internal DSL predicate used to build the root membership term. */
  public _dsl: QueryDSL | undefined = undefined;
  /** Entity that stores this query as a component and carries query traits. */
  public readonly entity: Entity;
  /** @internal `enter` callback (already wraps any injection logic). */
  public _enterCallback: EntityCallback | undefined = undefined;
  /** @internal `exit` callback (already wraps any injection logic). */
  public _exitCallback: EntityCallback | undefined = undefined;
  /** @internal Component eids the exit callback needs snapshotted before component removal. */
  public _exitSnapshotTypes: number[] | undefined = undefined;
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
  /** @internal `true` once `query` or `requires` has set an explicit predicate. */
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

  public cascade(rel: ComponentRef): this;
  public cascade(rel: ComponentRef, compare: (a: Entity, b: Entity) => number): this;
  public cascade(rel: ComponentRef, compare?: (a: Entity, b: Entity) => number): this {
    this._assertConfigurable();
    const relEntity = this.world.entity(rel);
    const relMeta = relEntity.ownMeta;
    if (!relMeta.isRelationship) {
      throw new Error(`Component ${relMeta.Class.name} is not a Relationship`);
    }

    const traversable = relEntity.get(Traversable);
    if (!traversable) {
      throw new Error(`Relationship ${relMeta.Class.name} does not have the Traversable trait`);
    }

    const depths = traversable.depths;
    this.sort([], (a, _ra, b) => {
      const da = depths.get(a) ?? -1;
      const db = depths.get(b) ?? -1;
      return da - db || compare?.(a, b) || 0;
    });
    this.update(relMeta.Class, (entity) => {
      this._reSortCascade(entity, relMeta.eid);
    });
    return this;
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
    this._entities?.add(e);
    e._addQueryMembership(this as any);
    this._enterCallback?.(e);
    e.components.forEach((c, eid) => {
      const meta = this.world.entity(eid).ownMeta;
      if (this._watchlistBitmask.hasBit(meta.bitPtr)) {
        this._notifyModified(e, meta, c);
      }
    });
  }

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

  /** @internal */
  public _exit(e: Entity): void {
    this._exitCallback?.(e);
    this._entities?.delete(e);
    e._removeQueryMembership(this as any);
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
    forEachInjected(this.world, this._matchedEntities(), arg0, arg1, arg2);
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
    Object.setPrototypeOf(this, GroupedQuery.prototype);
    return (this as any)._initialize(arg0, arg1);
  }

  public has(e: Entity): boolean {
    if (!this._tracking) {
      return false;
    }
    return this._entities?.has(e) ?? this.rootTerm?.has(e) ?? false;
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

  /** @internal */
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

  public onTermEvent(kind: TermEventKind, entity: Entity): void {
    if (kind === TermEventKind.Enter) {
      this._enter(entity);
    } else {
      this._exit(entity);
    }
  }

  public query<const Q extends QueryDSL>(q: Q): Query<ExtractRequired<Q>>;
  public query<const T extends ComponentType[]>(
    q: QueryDSL,
    _guaranteed: readonly [...T]
  ): Query<T>;
  public query(q: QueryDSL, _guaranteed?: readonly ComponentType[]): Query<any> {
    this._assertConfigurable();
    this._dsl = q;
    this._hasExplicitQuery = true;
    return this as unknown as Query<any>;
  }

  public requires<const T extends ComponentType[]>(...components: [...T]): Query<T> {
    this.query(components);
    return this as unknown as Query<T>;
  }

  public sort<J extends InjectTuple>(
    components: readonly [...J],
    compare: (
      entityA: Entity,
      a: MaybeResolvedInjectTuple<J, R>,
      entityB: Entity,
      b: MaybeResolvedInjectTuple<J, R>
    ) => number
  ): this;
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
        return cb(itA, resolvedA, itB, resolvedB) || a.eid - b.eid;
      });
    } else {
      const resolvedA = new Array(arity);
      const resolvedB = new Array(arity);
      this._entities = new OrderedSet<Entity>((a, b) => {
        getInjected(a, inject, false, resolvedA);
        getInjected(b, inject, false, resolvedB);
        return cb(a, resolvedA, b, resolvedB) || a.eid - b.eid;
      });
    }
    return this;
  }

  public toString(): string {
    return this.name ?? "";
  }

  public track(): this {
    this._assertConfigurable();
    this._tracking = true;
    return this;
  }

  /** @internal */
  public _unsubscribeRootTerm(): void {
    this._unsubscribeTerm?.();
    this._unsubscribeTerm = undefined;
    this.rootTerm = undefined;
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
    const q = this.world.query(`${this.name}:silence`).query(dsl);
    q.entity.childOf(this.entity);
    return q;
  }

  private _reSortCascade(entity: Entity, relEid: number): void {
    const entities = this._entities;
    if (entities instanceof OrderedSet) {
      entities.reSort(entity);
    }
    for (const child of entity._childrenByEid(relEid) ?? []) {
      this._reSortCascade(child, relEid);
    }
  }
}

export class Group<K = unknown, R extends ComponentType[] = []> {
  public readonly key: K;
  private readonly _entities = new Set<Entity>();
  private readonly _world: World;

  public constructor(world: World, key: K) {
    this._world = world;
    this.key = key;
  }

  public get count(): number {
    return this._entities.size;
  }

  public [Symbol.iterator](): IterableIterator<Entity> {
    return this._entities[Symbol.iterator]();
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
    forEachInjected(this._world, this._entities, arg0, arg1, arg2);
    return this;
  }

  public has(e: Entity): boolean {
    return this._entities.has(e);
  }

  /** @internal */
  public _add(e: Entity): void {
    this._entities.add(e);
  }

  /** @internal */
  public _remove(e: Entity): boolean {
    this._entities.delete(e);
    return this._entities.size === 0;
  }
}

export class Grouping {
  public readonly groups = new Map<unknown, Group>();
  private readonly _entityKeys = new Map<Entity, unknown>();
  private readonly _keyOf: (e: Entity) => unknown;
  private readonly _watchEids: Set<number>;
  private readonly _world: World;
  private _onGroupEnter: ((group: Group) => void) | undefined;
  private _onGroupExit: ((key: unknown, group: Group) => void) | undefined;

  public constructor(world: World, keyOf: (e: Entity) => unknown, watchEids: Iterable<number>) {
    this._world = world;
    this._keyOf = keyOf;
    this._watchEids = new Set(watchEids);
  }

  public clear(): void {
    this.groups.clear();
    this._entityKeys.clear();
  }

  public enter(e: Entity): void {
    this._assign(e, this._keyOf(e));
  }

  public exit(e: Entity): void {
    const key = this._entityKeys.get(e);
    if (key !== undefined) {
      this._removeFromBucket(e, key);
    }
    this._entityKeys.delete(e);
  }

  public get(key: unknown): Group | undefined {
    return this.groups.get(key);
  }

  public keys(): IterableIterator<unknown> {
    return this.groups.keys();
  }

  public refresh(e: Entity, eid: number): void {
    if (!this._watchEids.has(eid)) {
      return;
    }
    this._assign(e, this._keyOf(e));
  }

  public setOnGroupEnter(callback: (group: Group) => void): void {
    this._onGroupEnter = callback;
  }

  public setOnGroupExit(callback: (key: unknown, group: Group) => void): void {
    this._onGroupExit = callback;
  }

  private _addToBucket(e: Entity, key: unknown): void {
    let group = this.groups.get(key);
    if (group === undefined) {
      group = new Group(this._world, key);
      this.groups.set(key, group);
      group._add(e);
      this._onGroupEnter?.(group);
      return;
    }
    group._add(e);
  }

  private _assign(e: Entity, newKey: unknown): void {
    const oldKey = this._entityKeys.get(e);
    if (oldKey === newKey) {
      return;
    }
    if (oldKey !== undefined) {
      this._removeFromBucket(e, oldKey);
    }
    if (newKey === undefined) {
      this._entityKeys.delete(e);
      return;
    }
    this._addToBucket(e, newKey);
    this._entityKeys.set(e, newKey);
  }

  private _removeFromBucket(e: Entity, key: unknown): void {
    const group = this.groups.get(key);
    if (group === undefined) {
      return;
    }
    if (group._remove(e)) {
      this.groups.delete(key);
      this._onGroupExit?.(key, group);
    }
  }
}

/**
 * A {@link Query} that has been partitioned by {@link Query.groupBy}. Adds the
 * typed group-accessor surface ({@link group}, {@link groups}, etc.) on top of
 * the query's usual reactive membership.
 *
 * `GroupedQuery` lives in the query module alongside `Query`. Instances are
 * created lazily by {@link Query.groupBy} via `Object.setPrototypeOf`.
 *
 * @typeParam K - The grouping key type produced by the key function (or the
 *   relationship target entity, for the relationship form).
 * @typeParam R - Component classes guaranteed present on every matched entity.
 */
export class GroupedQuery<K = unknown, R extends ComponentType[] = []> extends Query<R> {
  private _grouping!: Grouping;

  public get groupCount(): number {
    return this._grouping?.groups.size ?? 0;
  }

  /** @internal */
  public override _enter(e: Entity): void {
    this._grouping.enter(e);
    super._enter(e);
  }

  /** @internal */
  public override _exit(e: Entity): void {
    super._exit(e);
    this._grouping.exit(e);
  }

  /** @internal */
  public _initialize(
    arg0: readonly FanInjectElement[] | ComponentRef,
    arg1?: (e: Entity, resolved: any) => any
  ): this {
    if (this._grouping !== undefined) {
      throw `query '${this.name}' is already grouped`;
    }
    let keyOf: (e: Entity) => unknown;
    let watchEids: number[];
    if (typeof arg1 === "function") {
      const components = arg0 as readonly FanInjectElement[];
      const inject = mapInject(this.world, components);
      const arity = injectArity(inject);
      const resolved = new Array(arity);
      keyOf = (e: Entity) => {
        getInjected(e, inject, false, resolved);
        return arg1(e, resolved);
      };
      watchEids = directInjectEids(inject);
      this._composeGroupMembership(components);
    } else {
      const relEid = _resolveRelationship(arg0 as ComponentRef, this.world);
      keyOf = (e: Entity) => e.parent(relEid);
      watchEids = [relEid];
      this._composeGroupMembership([arg0 as ComponentRef]);
    }
    for (const eid of watchEids) {
      this._watchlistBitmask.add(eid);
    }
    this.track();
    this._grouping = new Grouping(this.world, keyOf, watchEids);
    return this;
  }

  /** @internal */
  public override _notifyModified(e: Entity, meta: ComponentMeta, c: ComponentInstance): void {
    super._notifyModified(e, meta, c);
    this._grouping.refresh(e, meta.eid);
  }

  /** @internal */
  public override _watchesUpdates(): boolean {
    return super._watchesUpdates() || true;
  }

  public override destroy(): void {
    this._grouping?.clear();
    this._grouping = undefined!;
    super.destroy();
  }

  public group(key: K): Group<K, R> | undefined {
    return this._grouping?.get(key) as Group<K, R> | undefined;
  }

  public groups(): IterableIterator<Group<K, R>> {
    return (this._grouping?.groups.values() ?? EMPTY_GROUPS.values()) as IterableIterator<
      Group<K, R>
    >;
  }

  public groupKeys(): IterableIterator<K> {
    return (this._grouping?.keys() ?? EMPTY_GROUPS.keys()) as IterableIterator<K>;
  }

  public onGroupEnter(callback: (group: Group<K, R>) => void): this {
    this._assertConfigurable();
    this._grouping?.setOnGroupEnter(callback as (group: Group) => void);
    return this;
  }

  public onGroupExit(callback: (key: K, group: Group<K, R>) => void): this {
    this._assertConfigurable();
    this._grouping?.setOnGroupExit(callback as (key: unknown, group: Group) => void);
    return this;
  }

  private _composeGroupMembership(refs: readonly unknown[]): void {
    const componentRefs = refs.filter(
      (ref): ref is ComponentRef =>
        typeof ref === "number" || typeof ref === "function" || ref instanceof Entity
    );
    if (componentRefs.length === 0) {
      return;
    }
    const existing: any = this._dsl ?? true;
    this._dsl = { all: [existing, ...componentRefs] };
    this._hasExplicitQuery = true;
  }
}
