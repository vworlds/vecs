import type { QueryDSL } from "../dsl.js";
import type { Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";
import { buildCompositeTerm, type CompositePrecheck } from "./composite_build.js";
import type { getTerm as GetTermFn } from "./build.js";

/**
 * Composite term that matches entities present in **at least one** of its
 * children.
 *
 * Constructed via {@link build}, which runs the diamond pre-check first and
 * may short-circuit to a merged `PredicateTerm` instead of building this node.
 */
export class AnyTerm extends Term {
  public constructor(
    world: World,
    key: string,
    children: readonly Term[],
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "any", false, onDestroy);
    this._setChildren(children);
    this._initializeFromWorld();
  }

  /**
   * Build an `AnyTerm` for the given child DSL list, collapsing to a merged
   * predicate term if a leaf diamond is detected.
   *
   * @param world - Owning world.
   * @param terms - Direct child DSL nodes.
   * @param key - Canonical cache key.
   * @param originalDSL - The full DSL node (used when collapsing to a merged term).
   * @param getTerm - Term canonicalizer / cache accessor.
   * @param precheck - Diamond analysis callback (injected to avoid circular imports).
   * @param onDestroy - Called when the last consumer unsubscribes.
   * @returns An `AnyTerm` or, on diamond, a `PredicateTerm` with `kind === "merged"`.
   */
  public static build(
    world: World,
    terms: readonly QueryDSL[],
    key: string,
    originalDSL: QueryDSL,
    getTerm: typeof GetTermFn,
    precheck: CompositePrecheck,
    onDestroy: (term: Term) => void
  ): Term {
    return buildCompositeTerm(
      AnyTerm,
      world,
      terms,
      key,
      originalDSL,
      getTerm,
      precheck,
      onDestroy
    );
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return this._children.some((child) => child.has(entity));
  }

  /**
   * @internal React to a child's data refresh.
   *
   * Membership here is a function of the children's membership alone, and every
   * child membership change reaches this term through `onTermEvent`. With no
   * membership event in flight the term already agrees with its children, so
   * re-evaluating would be a no-op and is skipped. A refresh that arrives while
   * an event is still being delivered (user code mutating inline from a query
   * callback) is re-evaluated as before.
   */
  protected override _onChildRefresh(entity: Entity, _child: Term): void {
    if (this.world._termEmitDepth !== 0) {
      this.onTermRefresh(entity);
    }
  }

  /** @internal See {@link _onChildRefresh}. */
  protected override _childRefreshesOnlyInFlight(): boolean {
    return true;
  }
}
