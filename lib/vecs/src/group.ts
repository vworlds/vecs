import { type ComponentType } from "./component.js";
import { Entity } from "./entity/index.js";
import {
  forEachInjected,
  Iter,
  type FanInjectTuple,
  type MaybeResolvedInjectTuple,
} from "./inject.js";
import { type World } from "./world/index.js";

/**
 * A single live bucket of a {@link Query.groupBy} projection: the set of
 * entities that currently share one grouping key.
 *
 * A `Group` is maintained reactively by its owning query — entities are added
 * as they enter the query (or are re-keyed into this bucket) and removed as
 * they leave. The bucket exposes the same read surface as a query
 * ({@link count}, {@link has}, iteration, {@link forEach}); when it empties it
 * is dropped from the parent and an `onGroupExit` callback fires.
 *
 * @typeParam K - The grouping key type.
 * @typeParam R - Component classes guaranteed present on every member (carried
 *   over from the owning query's `requires` / `_guaranteed` hint), so
 *   {@link forEach} callbacks see them as non-nullable.
 */
export class Group<K = unknown, R extends ComponentType[] = []> {
  /** The key shared by every entity in this group. */
  public readonly key: K;
  /** @internal */
  private readonly _world: World;
  /** @internal */
  private readonly _entities = new Set<Entity>();

  /** @internal Groups are created by {@link Grouping}, not user code. */
  public constructor(world: World, key: K) {
    this._world = world;
    this.key = key;
  }

  /** Number of entities currently in this group. */
  public get count(): number {
    return this._entities.size;
  }

  /** Returns `true` when `e` is currently a member of this group. */
  public has(e: Entity): boolean {
    return this._entities.has(e);
  }

  /** Iterate every entity currently in this group. */
  public [Symbol.iterator](): IterableIterator<Entity> {
    return this._entities[Symbol.iterator]();
  }

  /**
   * Iterate every member of this group.
   *
   * Behaves exactly like {@link Query.forEach}: mutations made by `callback`
   * are buffered into the world command queue and applied after iteration
   * finishes.
   *
   * @param callback - Invoked once per member entity.
   */
  public forEach(callback: (e: Entity) => void): void;

  /**
   * Iterate every member with component injection. Components covered by the
   * owning query's `requires` are non-nullable; any other requested component
   * may be `undefined`.
   */
  public forEach<J extends FanInjectTuple>(
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;

  /** As above, but pass `Entity` first to make the entity-first form explicit. */
  public forEach<J extends FanInjectTuple>(
    cursor: typeof Entity,
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;

  /** As above, but pass `Iter` first to receive a reused {@link Iter} cursor. */
  public forEach<J extends FanInjectTuple>(
    cursor: typeof Iter,
    components: readonly [...J],
    callback: (it: Iter, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;

  public forEach(arg0: unknown, arg1?: unknown, arg2?: unknown): void {
    forEachInjected(this._world, this._entities, arg0, arg1, arg2);
  }

  /** @internal Add `e` to this group. */
  public _add(e: Entity): void {
    this._entities.add(e);
  }

  /** @internal Remove `e` from this group; returns `true` when it became empty. */
  public _remove(e: Entity): boolean {
    this._entities.delete(e);
    return this._entities.size === 0;
  }
}

/**
 * @internal Bucket-maintenance engine behind {@link Query.groupBy}.
 *
 * Grouping is a projection layered on top of a query's membership — the
 * analogue of how `sort` layers an ordering on the same root term. Membership
 * (which entities are in scope) is delivered by the owning query's
 * `_enter` / `_exit` hooks; re-keying (a member changing buckets without
 * leaving the query) rides the `_notifyModified` watchlist rail via
 * {@link refresh}. The grouping itself owns no subscriptions; it is driven
 * entirely by those three calls, so it works identically under both `Query`
 * (live) and `System` (the index stays live; only user callbacks defer).
 */
export class Grouping {
  /** Live key -> bucket map. */
  public readonly groups = new Map<unknown, Group>();
  /** @internal */
  private readonly _world: World;
  /** @internal Resolves the current key for an entity. */
  private readonly _keyOf: (e: Entity) => unknown;
  /** @internal Component eids whose change should trigger a re-key. */
  private readonly _watchEids: Set<number>;
  /** @internal Current key per member, for cheap exit / re-key. */
  private readonly _entityKeys = new Map<Entity, unknown>();
  /** @internal */
  private _onGroupEnter: ((group: Group) => void) | undefined;
  /** @internal */
  private _onGroupExit: ((key: unknown, group: Group) => void) | undefined;

  public constructor(world: World, keyOf: (e: Entity) => unknown, watchEids: Iterable<number>) {
    this._world = world;
    this._keyOf = keyOf;
    this._watchEids = new Set(watchEids);
  }

  /** Return the bucket for `key`, or `undefined` when no member holds it. */
  public get(key: unknown): Group | undefined {
    return this.groups.get(key);
  }

  /** Iterate keys with at least one member. */
  public keys(): IterableIterator<unknown> {
    return this.groups.keys();
  }

  public setOnGroupEnter(callback: (group: Group) => void): void {
    this._onGroupEnter = callback;
  }

  public setOnGroupExit(callback: (key: unknown, group: Group) => void): void {
    this._onGroupExit = callback;
  }

  /** Bucket `e` under its current key (called when it enters the query). */
  public enter(e: Entity): void {
    this._assign(e, this._keyOf(e));
  }

  /** Drop `e` from its bucket (called when it leaves the query). */
  public exit(e: Entity): void {
    const key = this._entityKeys.get(e);
    if (key !== undefined) {
      this._removeFromBucket(e, key);
    }
    this._entityKeys.delete(e);
  }

  /**
   * Re-key `e` when a watched component (`eid`) changed. No-op when `eid` is
   * not a key input or when the recomputed key is unchanged.
   */
  public refresh(e: Entity, eid: number): void {
    if (!this._watchEids.has(eid)) {
      return;
    }
    this._assign(e, this._keyOf(e));
  }

  /** Tear down every bucket. */
  public clear(): void {
    this.groups.clear();
    this._entityKeys.clear();
  }

  /** @internal Move `e` into the bucket for `newKey`, leaving its previous one. */
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

  /** @internal */
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

  /** @internal */
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
