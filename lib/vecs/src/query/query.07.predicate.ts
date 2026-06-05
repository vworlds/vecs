import { type ComponentRef, type ComponentType } from "../component.js";
import { type ExtractRequired, type QueryDSL } from "../dsl.js";
import { Entity } from "../entity/index.js";
import {
  type FanInjectElement,
  type FanInjectTuple,
  type MaybeResolvedInjectTuple,
} from "../inject.js";
import { ChildOf, SilenceSource } from "../modules/relationships.js";
import { _getGroupedQueryCtor } from "./query.00.base.js";
import { Updates } from "./query.06.updates.js";
import type { GroupedQuery, Query } from "./query.js";

export class Predicate<R extends ComponentType[] = []> extends Updates<R> {
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

  private _buildSilenceQuery(dsl: QueryDSL): Query {
    const q = this.world.query(`${this.name}:silence`).query(dsl);
    q.entity.set(ChildOf, { target: this.entity });
    return q;
  }

  /** @internal */
  public _clearSilence(): void {
    this._silenceQuery = undefined;
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
    const ctor = _getGroupedQueryCtor();
    Object.setPrototypeOf(this, ctor.prototype);
    return (this as any)._initialize(arg0, arg1);
  }
}
