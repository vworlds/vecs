import type { ComponentMeta } from "../component_meta.js";
import type { Query } from "../query.js";
import type { Entity } from "./entity.js";
import { Base } from "./entity.base.js";

export class Queries extends Base {
  /**
   * @internal Record that this entity is now tracked by `q`. Called by
   * `Query._enter`.
   */
  public _addQueryMembership(q: Query): void {
    this._queries.add(q);
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

  /**
   * @internal
   *
   * Re-evaluate queries that can be affected by `meta` for this entity,
   * firing `_enter` / `_exit` routing whenever membership flipped.
   */
  protected _updateQueries(meta: ComponentMeta): void {
    this.world._forEachQueryForComponent(meta.eid, (q) => {
      const entity = this as unknown as Entity;
      const belongs = q.belongs(entity);
      const isIn = this._queries.has(q);
      if (belongs !== isIn) {
        belongs ? q._enter(entity) : q._exit(entity);
      }
    });
  }
}
