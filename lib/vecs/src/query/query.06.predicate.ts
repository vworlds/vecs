import { type ComponentType } from "../component.js";
import { type QueryDSL } from "../dsl.js";
import { Entity } from "../entity/index.js";
import {
  type FanInjectElement,
  type FanInjectTuple,
  type MaybeResolvedInjectTuple,
} from "../inject.js";
import { ChildOf, SilenceSource } from "../modules/relationships.js";
import { _getGroupedQueryCtor } from "./query.00.base.js";
import { Updates } from "./query.05.updates.js";

export class Predicate<R extends ComponentType[] = []> extends Updates<R> {
  public query<T extends ComponentType[] = []>(q: QueryDSL, _guaranteed?: readonly [...T]): any {
    this._assertConfigurable();
    this._dsl = q;
    this._hasExplicitQuery = true;
    return this;
  }

  public requires<T extends ComponentType[]>(...components: [...T]): any {
    this.query(components);
    return this;
  }

  public ignoreSource(source: QueryDSL | any): this {
    this._assertConfigurable();
    const query =
      typeof source === "object" && !Array.isArray(source) && "entity" in source
        ? source
        : this._buildSilenceQuery(source);
    this.entity.set(SilenceSource, { target: query.entity });
    this._silenceQuery = query;
    return this;
  }

  private _buildSilenceQuery(dsl: QueryDSL): any {
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
  ): any;
  public groupBy(relationship: import("../component.js").ComponentRef): any;
  public groupBy(
    arg0: readonly FanInjectElement[] | import("../component.js").ComponentRef,
    arg1?: (e: Entity, resolved: any) => any
  ): any {
    this._assertConfigurable();
    const ctor = _getGroupedQueryCtor();
    Object.setPrototypeOf(this, ctor.prototype);
    return (this as any)._initialize(arg0, arg1);
  }
}
