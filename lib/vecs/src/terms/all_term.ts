import type { QueryDSL } from "../dsl.js";
import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";
import { MergedPredicateTerm, type MergedInfo } from "./merged_predicate_term.js";
import type { getTerm as GetTermFn } from "./build.js";

export class AllTerm extends Term {
  public constructor(
    world: World,
    key: string,
    children: readonly Term[],
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "all", false, onDestroy);
    this._setChildren(children);
    this._initializeFromWorld();
  }

  public static build(
    world: World,
    terms: readonly QueryDSL[],
    key: string,
    originalDSL: QueryDSL,
    getTerm: typeof GetTermFn,
    precheck: (terms: readonly QueryDSL[]) => { hasDiamond: boolean; containsTarget: boolean; info: MergedInfo },
    onDestroy: (term: Term) => void
  ): Term {
    const checked = precheck(terms);
    if (checked.hasDiamond && !checked.containsTarget) {
      return MergedPredicateTerm.build(world, originalDSL, key, checked.info, getTerm, onDestroy);
    }
    const children = terms.map((dsl) => getTerm(world, dsl));
    return new AllTerm(world, key, children, onDestroy);
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return this._children.every((child) => child.has(entity));
  }
}
