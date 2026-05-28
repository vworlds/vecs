import { _compile, type EntityTestFunc, type QueryDSL } from "../dsl.js";
import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";
import { WorldTerm } from "./world_term.js";
import type { getTerm as GetTermFn } from "./build.js";

/** @internal Analysis summary derived from a collapsed all/any subtree. */
export type MergedInfo = {
  componentEids: ReadonlySet<number>;
  dependsOnWorld: boolean;
  containsOnly: boolean;
};

export class MergedPredicateTerm extends Term {
  private readonly _predicate: EntityTestFunc;
  private readonly _worldTerm: Term | undefined;

  public constructor(
    world: World,
    key: string,
    dsl: QueryDSL,
    worldTerm: Term | undefined,
    watchedTerms: readonly Term[],
    private readonly _usesWorldRefresh: boolean,
    info: MergedInfo,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "merged", false, onDestroy);
    this._predicate = _compile(world, dsl);
    this._worldTerm = worldTerm;
    this._setChildren(worldTerm ? [worldTerm, ...watchedTerms] : watchedTerms);
    if (this._usesWorldRefresh && worldTerm instanceof WorldTerm) {
      this._addChildCleanup(worldTerm.subscribeShape(this));
    }
    this._initializeFromWorld();
  }

  public static build(
    world: World,
    dsl: QueryDSL,
    key: string,
    info: MergedInfo,
    getTerm: typeof GetTermFn,
    onDestroy: (term: Term) => void
  ): MergedPredicateTerm {
    const watchedTerms = [...info.componentEids].map((eid) => getTerm(world, eid));
    const worldTerm = info.dependsOnWorld ? getTerm(world, true) : undefined;
    return new MergedPredicateTerm(
      world,
      key,
      dsl,
      worldTerm,
      watchedTerms,
      // Shape refresh is only needed for collapsed subtrees containing `only(...)`.
      info.containsOnly,
      info,
      onDestroy
    );
  }

  public override onTermRefresh(entity: Entity): void {
    this._sync(entity);
  }

  /** @internal */
  protected override _onChildRefresh(entity: Entity, child: Term): void {
    if (child.kind === "component" || (this._usesWorldRefresh && child.kind === "world")) {
      this._sync(entity);
    }
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return !entity._destroyed && (this._worldTerm?.has(entity) ?? true) && this._predicate(entity);
  }
}
