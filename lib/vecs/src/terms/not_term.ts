import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";
import type { QueryDSL } from "../dsl.js";
import type { getTerm as GetTermFn } from "./build.js";

export class NotTerm extends Term {
  public constructor(
    world: World,
    key: string,
    worldTerm: Term,
    child: Term,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "not", false, onDestroy);
    this._setChildren([worldTerm, child]);
    this._initializeFromWorld();
  }

  public static build(
    world: World,
    childDSL: QueryDSL,
    key: string,
    getTerm: typeof GetTermFn,
    onDestroy: (term: Term) => void
  ): NotTerm {
    const worldTerm = getTerm(world, true);
    const child = getTerm(world, childDSL);
    return new NotTerm(world, key, worldTerm, child, onDestroy);
  }

  public override onTermRefresh(_entity: Entity): void {
    // Shape/data refreshes do not affect a pure negation unless the child emits
    // a real membership event, or the world emits a lifecycle event.
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return this._children[0].has(entity) && !this._children[1].has(entity);
  }
}
