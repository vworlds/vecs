import type { Query } from "../query.js";
import { Base } from "./entity.base.js";

export class Queries extends Base {
  /**
   * @internal Record that this entity is now tracked by `q`. Called by
   * `Query._enter`.
   */
  public _addQueryMembership(q: Query): void {
    if (q._watchesUpdates()) {
      this._queries.add(q);
    }
  }

  /**
   * @internal Return `true` when this entity is currently tracked by `q`.
   */
  public _isInQuery(q: Query): boolean {
    return this._queries.has(q);
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
}
