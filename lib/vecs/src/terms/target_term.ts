import type { QueryDSL } from "../dsl.js";
import type { EID, Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term, TermEventKind } from "./term.js";
import type { getTerm as GetTermFn } from "./build.js";

/**
 * Composite term that matches entities whose relationship target satisfies a
 * given inner predicate.
 *
 * An entity `e` matches when it carries the relationship component
 * `_relationshipEid` **and** at least one target entity satisfies `_innerTerm`.
 *
 * Children: `[relationshipTerm, innerTerm]`.
 * - `children[0]` (`relationshipTerm`): the `ComponentTerm` for the
 *   relationship eid — fires when the relationship is added/removed from `e`.
 * - `children[1]` (`innerTerm`): the term for the inner DSL — fires when the
 *   target entity transitions in or out.
 *
 * ## Non-standard event routing
 *
 * `TargetTerm` overrides `_onChildEvent` and `_onChildRefresh` to implement
 * a **fan-out** strategy: when the inner term changes (the target enters or
 * exits), all *sources* that point at that target via the relationship must be
 * re-evaluated. This reverses the normal bottom-up signal direction. The
 * fan-out is why `TargetTerm` subtrees are excluded from diamond collapsing —
 * a plain compiled predicate cannot replicate this per-source walk.
 */
export class TargetTerm extends Term {
  public constructor(
    world: World,
    key: string,
    private readonly _relationshipEid: EID,
    relationshipTerm: Term,
    private readonly _innerTerm: Term,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "target", false, onDestroy);
    this._setChildren([relationshipTerm, _innerTerm]);
    this._initializeFromWorld();
  }

  /**
   * Build a `TargetTerm` for the given relationship eid and inner DSL.
   *
   * @param world - Owning world.
   * @param relationshipEid - Numeric eid of the relationship component type.
   * @param innerDSL - DSL expression the relationship target must satisfy.
   * @param key - Canonical cache key.
   * @param getTerm - Term canonicalizer / cache accessor.
   * @param onDestroy - Called when the last consumer unsubscribes.
   */
  public static build(
    world: World,
    relationshipEid: EID,
    innerDSL: QueryDSL,
    key: string,
    getTerm: typeof GetTermFn,
    onDestroy: (term: Term) => void
  ): TargetTerm {
    const relationshipTerm = getTerm(world, relationshipEid);
    const innerTerm = getTerm(world, innerDSL);
    return new TargetTerm(world, key, relationshipEid, relationshipTerm, innerTerm, onDestroy);
  }

  /** @internal Fan-out child membership event handler. See {@link _fanOut}. */
  protected override _onChildEvent(_kind: TermEventKind, entity: Entity, child: Term): void {
    this._fanOut(entity, child);
  }

  /** @internal Fan-out child refresh handler. See {@link _fanOut}. */
  protected override _onChildRefresh(entity: Entity, child: Term): void {
    this._fanOut(entity, child);
  }

  /**
   * @internal Shared fan-out logic for child membership and refresh events.
   *
   * When the relationship component is added/removed from `entity`
   * (`child === children[0]`), re-evaluate that entity directly. When the
   * inner term changes for some target entity (`child === children[1]`), walk
   * every source entity that points at that target via the relationship and
   * re-evaluate each one.
   */
  private _fanOut(entity: Entity, child: Term): void {
    if (child === this._children[0]) {
      this._sync(entity);
      return;
    }
    entity._childrenByEid(this._relationshipEid)?.forEach((source) => this._sync(source));
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    if (entity.destroyed) {
      return false;
    }
    return entity._someTargetByEid(this._relationshipEid, (target) => this._innerTerm.has(target));
  }
}
