import type { EntityTestFunc } from "../dsl.js";
import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";
import type { getTerm as GetTermFn } from "./build.js";

export class PredicateTerm extends Term {
  public constructor(
    world: World,
    key: string,
    worldTerm: Term,
    watchedTerms: readonly Term[],
    private readonly _predicate: EntityTestFunc,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "predicate", false, onDestroy);
    this._setChildren([worldTerm, ...watchedTerms]);
    this._initializeFromWorld();
  }

  public static build(
    world: World,
    dsl: { test: EntityTestFunc; watch?: unknown },
    key: string,
    getTerm: typeof GetTermFn,
    onDestroy: (term: Term) => void
  ): PredicateTerm {
    const watch = normalizeWatch(dsl.watch);
    const worldTerm = getTerm(world, true);
    const watchedTerms = watch.map((eid) => getTerm(world, eid));
    return new PredicateTerm(world, key, worldTerm, watchedTerms, dsl.test, onDestroy);
  }

  /** @internal */
  protected override _onChildRefresh(entity: Entity, child: Term): void {
    if (child.kind === "component") {
      this._sync(entity);
    }
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return this._children[0].has(entity) && this._predicate(entity);
  }
}

/** @internal Deduplicate and sort a `watch` list of component eids. */
export function normalizeWatch(watch: unknown): number[] {
  if (watch === undefined) {
    return [];
  }
  return [...new Set((watch instanceof Array ? watch : [watch]) as number[])].sort((a, b) => a - b);
}
