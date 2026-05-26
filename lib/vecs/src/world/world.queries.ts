import { type ComponentType } from "../component.js";
import { type ExtractRequired, type QueryDSL } from "../dsl.js";
import { Filter } from "../filter.js";
import { Query } from "../query.js";
import { Tables } from "./world.tables.js";
import type { World } from "./world.js";

export class Queries extends Tables {
  /** @internal All registered queries, including systems (which extend `Query`). */
  protected _queries: Query[] = [];
  /** @internal Queries created but not yet built into the world. */
  protected _unbuiltQueries = new Set<Query>();
  /** @internal True while the world is driving one logical frame. */
  protected _frameInProgress = false;
  /** @internal True while the world is auto-building pending queries. */
  protected _buildingPendingQueries = false;

  /** Read-only view of every registered query (includes systems). */
  public get queries(): ReadonlyArray<Query> {
    return this._queries;
  }

  /** @internal Register a freshly built {@link Query}. */
  public _addQuery(this: World, q: Query): void {
    if (this._frameInProgress && !this._buildingPendingQueries) {
      throw "queries cannot be built while a frame is in progress";
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
    this._entities.forEach((e) => e._purgeQuery(q));
  }

  /** @internal Stop tracking a pending query. */
  public _removeUnbuiltQuery(q: Query): void {
    this._unbuiltQueries.delete(q);
  }

  /** Create a non-reactive {@link Filter} that matches entities satisfying `q`. */
  public filter<Q extends QueryDSL>(this: World, q: Q): Filter<ExtractRequired<Q>>;
  public filter<T extends ComponentType[]>(
    this: World,
    q: QueryDSL,
    _guaranteed: readonly [...T]
  ): Filter<T>;
  public filter(this: World, q: QueryDSL, _guaranteed?: readonly ComponentType[]): Filter<any> {
    return new Filter(this, q);
  }

  /** Create and return a standalone {@link Query}, ready for fluent configuration. */
  public query(this: World, name: string): Query {
    return new Query(name, this);
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
}
