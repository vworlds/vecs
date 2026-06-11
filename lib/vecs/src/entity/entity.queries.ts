import type { Query } from "../query/index.js";
import { Base } from "./entity.base.js";

export class Queries extends Base {
  /**
   * @internal Record that this entity is now tracked by `q`. Called by
   * `Query._enter`.
   */
  public _addQueryMembership(q: Query): void {
    if (q._watchesUpdates()) {
      const alreadyMember = this._queries.has(q);
      this._queries.add(q);
      if (!alreadyMember) {
        this._storeEntrants?.add(q);
      }
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
}
