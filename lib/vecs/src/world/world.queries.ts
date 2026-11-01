import { isQueryConfig, type ExtractSpecRequired, type QueryDSL, type QuerySpec } from "../dsl.js";
import type { EID, Entity } from "../entity/index.js";
import { Filter } from "../filter.js";
import { Query } from "../query/index.js";
import {
  getCachedTerm,
  getTerm,
  notifyComponentAdded,
  notifyComponentChanged,
  notifyComponentRemoved,
  notifyEntityCreated,
  notifyEntityDestroyed,
} from "../terms/build.js";
import { ComponentTerm, EmptyTerm, Term, WorldTerm } from "../terms/index.js";
import { ArrayMap } from "../util/array_map.js";
import { Storage } from "./world.storage.js";
import type { World } from "./world.js";

/** @internal Built queries routed one component eid's `modified` events. */
export interface UpdateWatchers {
  /** Queries whose watchlist contains the eid, in build order. */
  readonly queries: Query[];
  /** How many of {@link queries} run callbacks synchronously, i.e. are not systems. */
  synchronous: number;
}

export class Queries extends Storage {
  /** @internal All registered queries, including systems (which extend `Query`). */
  protected _queries: Query[] = [];
  /** @internal Queries created but not yet built into the world. */
  protected _unbuiltQueries = new Set<Query>();
  /** @internal Canonical DSL key -> live term. */
  public readonly _termCache = new Map<string, Term>();
  /** @internal Component eid -> pinned component leaf term. */
  public readonly _componentTerms = new ArrayMap<ComponentTerm>();
  /** @internal Pinned false term. */
  public _emptyTerm: EmptyTerm | undefined = undefined;
  /** @internal Pinned world term. */
  public _worldTerm: WorldTerm | undefined = undefined;
  /**
   * @internal Term membership events currently being delivered (see
   * `Term._add` / `Term._delete`). While it is zero, every composite term agrees
   * with its children's membership.
   */
  public _termEmitDepth = 0;
  /**
   * @internal Component eid -> built queries that watch it for updates. Read by
   * `Entity._routeModified`; maintained by {@link _addQuery} and
   * {@link _removeQuery}.
   */
  public readonly _updateWatchers: (UpdateWatchers | undefined)[] = [];
  /** @internal True while the world is driving one logical frame. */
  protected _frameInProgress = false;
  /** @internal True while the world is auto-building pending queries. */
  protected _buildingPendingQueries = false;

  /** Read-only view of every registered query (includes systems). */
  public get queries(): ReadonlyArray<Query> {
    return this._queries;
  }

  /** @internal Register and index a freshly built {@link Query}. */
  public _addQuery(this: World, q: Query): void {
    if (this._frameInProgress && !this._buildingPendingQueries) {
      throw new Error("queries cannot be built while a frame is in progress");
    }
    this._removeUnbuiltQuery(q);
    this._queries.push(q);
    this._addUpdateWatcher(q);
  }

  /** @internal Track a newly-created query until it is explicitly or automatically built. */
  public _addUnbuiltQuery(q: Query): void {
    this._unbuiltQueries.add(q);
  }

  /** @internal Unregister a query and purge its membership from every entity. */
  public _removeQuery(q: Query): void {
    this._removeUnbuiltQuery(q);
    const idx = this._queries.indexOf(q);
    if (idx !== -1) {
      this._queries.splice(idx, 1);
      this._removeUpdateWatcher(q);
    }
    q._unsubscribeRootTerm();
    this._entities.forEach((e) => e._purgeQuery(q));
  }

  /** @internal Stop tracking a pending query. */
  public _removeUnbuiltQuery(q: Query): void {
    this._unbuiltQueries.delete(q);
  }

  /** Create a non-reactive {@link Filter} that matches entities satisfying `spec`. */
  public filter<const S extends QuerySpec>(this: World, spec: S): Filter<ExtractSpecRequired<S>> {
    const dsl: QueryDSL = isQueryConfig(spec) ? spec.with : (spec as QueryDSL);
    return new Filter(this, dsl);
  }

  /** Create and return a standalone {@link Query}, ready for fluent configuration. */
  public query(this: World, name: string): Query {
    return new Query(name, this);
  }

  /** Return the shared materialized term for a reactive query DSL expression. */
  public getTerm(this: World, q: QueryDSL): Term {
    return getTerm(this, q);
  }

  /** @internal Return a cached term without creating one. */
  public _getCachedTerm(this: World, q: QueryDSL): Term | undefined {
    return getCachedTerm(this, q);
  }

  /** @internal Return a cached term for a precomputed canonical DSL key, without creating one. */
  public _getCachedTermByKey(key: string): Term | undefined {
    return this._termCache.get(key);
  }

  /** @internal Drive the component leaf for a newly attached component. */
  public _notifyComponentAdded(ceid: EID, entity: Entity): void {
    notifyComponentAdded(this as unknown as World, ceid, entity);
  }

  /** @internal Drive predicate/target refresh for changed component data. */
  public _notifyComponentChanged(ceid: EID, entity: Entity): void {
    notifyComponentChanged(this as unknown as World, ceid, entity);
  }

  /** @internal Drive detached-component leaves; `null` is an already-looked-up absent leaf. */
  public _notifyComponentRemoved(
    ceid: EID,
    entity: Entity,
    componentTerm: ComponentTerm | null = this._componentTerms.get(ceid) ?? null
  ): void {
    notifyComponentRemoved(this as unknown as World, ceid, entity, componentTerm);
  }

  /** @internal Drive the world leaf for a created entity. */
  public _notifyEntityCreated(entity: Entity): void {
    notifyEntityCreated(this as unknown as World, entity);
  }

  /** @internal Drive the world/component leaves for a destroyed entity. */
  public _notifyEntityDestroyed(entity: Entity): void {
    notifyEntityDestroyed(this as unknown as World, entity);
  }

  /** @internal Build every query that has not yet entered the world. */
  protected _buildPendingQueries(): void {
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

  /**
   * Index a built query under every component eid it watches. Only queries that
   * watch updates join entity membership sets, so only those are indexed.
   */
  private _addUpdateWatcher(q: Query): void {
    if (!q._watchesUpdates()) {
      return;
    }
    q._watchlistBitmask.forEach((ceid) => {
      let watchers = this._updateWatchers[ceid];
      if (watchers === undefined) {
        watchers = { queries: [], synchronous: 0 };
        this._updateWatchers[ceid] = watchers;
      }
      watchers.queries.push(q);
      if (!q._queuesUpdates) {
        watchers.synchronous++;
      }
    });
  }

  /** Drop a query from the watcher index; the inverse of {@link _addUpdateWatcher}. */
  private _removeUpdateWatcher(q: Query): void {
    q._watchlistBitmask.forEach((ceid) => {
      const watchers = this._updateWatchers[ceid];
      const index = watchers?.queries.indexOf(q) ?? -1;
      if (index === -1) {
        return;
      }
      watchers!.queries.splice(index, 1);
      if (!q._queuesUpdates) {
        watchers!.synchronous--;
      }
    });
  }
}
