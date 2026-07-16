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
  public _emptyTerm: EmptyTerm | undefined;
  /** @internal Pinned world term. */
  public _worldTerm: WorldTerm | undefined;
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
    this._assertStructuralMutationAllowed();
    if (this._frameInProgress && !this._buildingPendingQueries) {
      throw new Error("queries cannot be built while a frame is in progress");
    }
    this._removeUnbuiltQuery(q);
    this._queries.push(q);
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
    this._assertQueryCreationAllowed();
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

  /** @internal Drive the component leaf for a detached component. */
  public _notifyComponentRemoved(ceid: EID, entity: Entity): void {
    notifyComponentRemoved(this as unknown as World, ceid, entity);
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

  /** @internal Reject query/system construction from constructor-like add hooks. */
  protected _assertQueryCreationAllowed(): void {
    this._assertStructuralMutationAllowed();
    if (this._initializationDepth > 0) {
      throw new Error("queries cannot be built while component add hooks are initializing");
    }
  }

  /** @internal Allow cached term reads but reject materialization during guarded callbacks. */
  public _assertTermCreationAllowed(): void {
    this._assertStructuralMutationAllowed();
    if (this._initializationDepth > 0) {
      throw new Error("terms cannot be materialized while component add hooks are initializing");
    }
  }
}
