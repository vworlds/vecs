import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";
import type { QueryDSL } from "../dsl.js";
import type { getTerm as GetTermFn } from "./build.js";

/**
 * Composite term that matches entities in the world but **not** in a child
 * term.
 *
 * Children: `[worldTerm, child]`. The world leaf provides lifecycle
 * (creation/destruction); the child provides the set to negate.
 */
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

  /**
   * Build a `NotTerm` for the given child DSL.
   *
   * @param world - Owning world.
   * @param childDSL - The DSL expression to negate.
   * @param key - Canonical cache key.
   * @param getTerm - Term canonicalizer / cache accessor.
   * @param onDestroy - Called when the last consumer unsubscribes.
   */
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

  /**
   * No-op override: a pure negation term does not need to re-evaluate on a
   * data or shape refresh.
   *
   * `NotTerm` membership flips only when the child's membership changes (a
   * real enter/exit) or when the world emits a lifecycle event — both of
   * which arrive via `onTermEvent`, not `onTermRefresh`. Reacting to refresh
   * hints would cause spurious `_sync` calls with no change in result.
   */
  public override onTermRefresh(_entity: Entity): void {
    // Shape/data refreshes do not affect a pure negation unless the child emits
    // a real membership event, or the world emits a lifecycle event.
  }

  /** @internal A negation ignores child refreshes altogether; see {@link onTermRefresh}. */
  protected override _childRefreshesOnlyInFlight(): boolean {
    return true;
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return this._children[0].has(entity) && !this._children[1].has(entity);
  }
}
