import type { ComponentInstance } from "../component_meta.js";
import type { Query } from "../query/index.js";
import { Base } from "./entity.base.js";
import type { EID, Entity } from "./entity.js";

export class Queries extends Base {
  /**
   * @internal Record that this entity is now tracked by `q`. Called by
   * `Query._enter`.
   */
  public _addQueryMembership(q: Query): void {
    if (q._tracksMembership()) {
      this._queries.add(q);
    }
  }

  /**
   * @internal Forget query `q` without firing exit callbacks. Called by
   * {@link World} when a {@link Query.destroy} sweeps every entity.
   */
  public _purgeQuery(q: Query): void {
    this._queries.delete(q);
  }

  /**
   * @internal Record that this entity is no longer tracked by `q`. Called by
   * `Query._exit`.
   */
  public _removeQueryMembership(q: Query): void {
    this._queries.delete(q);
  }

  /**
   * @internal True when `q` currently tracks this entity. Used by {@link System}
   * to drop inbox events queued for an entity that has since left the query
   * (destroyed, or lost a `.with` component in the same frame, before the inbox
   * drained). Membership is removed eagerly on exit, so a non-member here is
   * provably stale.
   */
  public _isMemberOf(q: Query): boolean {
    return this._queries.has(q);
  }

  /**
   * @internal Route a `modified` event for component `ceid` to the queries this
   * entity belongs to. Queries that do not watch `ceid` ignore it, so only the
   * watchers matter.
   *
   * When every query watching `ceid` is a system, delivery only queues inbox
   * events and the order across queries is unobservable, so the shorter of the
   * world's watcher list and this entity's membership set is walked. Otherwise
   * the membership set is walked in insertion order exactly as before: a plain
   * query's `update` callback runs synchronously and may change that set
   * mid-walk.
   */
  public _routeModified(this: Entity, ceid: EID, component: ComponentInstance): void {
    const watchers = this.world._updateWatchers[ceid];
    if (watchers === undefined) {
      return;
    }
    const queries = this._queries;
    const list = watchers.queries;
    if (watchers.synchronous === 0 && list.length < queries.size) {
      for (let i = 0; i < list.length; i++) {
        const q = list[i];
        if (queries.has(q)) {
          q._notifyModified(this, ceid, component);
        }
      }
      return;
    }
    queries.forEach((q) => q._notifyModified(this, ceid, component));
  }
}
