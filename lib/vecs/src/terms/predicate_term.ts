import { _compile, type EntityTestFunc, type QueryDSL } from "../dsl.js";
import type { EID, Entity } from "../entity/index.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";
import { WorldTerm } from "./world_term.js";
import type { getTerm as GetTermFn } from "./build.js";

/**
 * Analysis summary derived from a collapsed `all`/`any` subtree.
 *
 * Produced by `_allAnyPrecheck` in `build.ts` and consumed by
 * {@link PredicateTerm.buildMerged} to configure the unified class without
 * first building — and then having to tear down — the composite child terms.
 */
export type MergedInfo = {
  componentEids: ReadonlySet<EID>;
  dependsOnWorld: boolean;
  containsOnly: boolean;
};

/**
 * A reactive predicate term that covers two related use-cases under one class:
 *
 * - **Plain predicate** (`kind === "predicate"`): wraps a user-supplied
 *   `{ test, watch }` DSL node. The predicate is evaluated whenever a watched
 *   component changes; membership requires the world leaf to include the entity
 *   (i.e. it has not been destroyed).
 *
 * - **Merged / diamond-collapsed** (`kind === "merged"`): wraps a compiled
 *   predicate for an `all`/`any` subtree that was detected to contain a
 *   leaf-level diamond (the same leaf reachable via two paths). Collapsing it
 *   into a single compiled predicate keeps the live graph a strict tree and
 *   avoids glitch-inducing double propagation. The optional `_worldTerm` is
 *   present only when the subtree depends on world lifecycle, and
 *   `_usesShapeRefresh` is set when the subtree contains an `only(...)` node
 *   (which needs a shape-channel wakeup on component add/remove).
 *
 * Both variants are constructed via the static factory methods
 * {@link buildPredicate} and {@link buildMerged}; the constructor is not
 * public.
 */
export class PredicateTerm extends Term {
  private readonly _predicate: EntityTestFunc;
  private readonly _worldTerm: Term | undefined;
  private readonly _usesShapeRefresh: boolean;

  protected constructor(
    world: World,
    key: string,
    kind: "predicate" | "merged",
    predicate: EntityTestFunc,
    worldTerm: Term | undefined,
    watchedTerms: readonly Term[],
    usesShapeRefresh: boolean,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, kind, false, onDestroy);
    this._predicate = predicate;
    this._worldTerm = worldTerm;
    this._usesShapeRefresh = usesShapeRefresh;
    this._setChildren(worldTerm ? [worldTerm, ...watchedTerms] : watchedTerms);
    if (usesShapeRefresh && worldTerm instanceof WorldTerm) {
      this._addChildCleanup(worldTerm.subscribeShape(this));
    }
    this._initializeFromWorld();
  }

  /**
   * Build a plain predicate term for a `{ test, watch }` DSL node.
   *
   * Subscribes to the world leaf plus any watched component leaves so the
   * predicate is re-evaluated whenever watched component data changes.
   *
   * @param world - Owning world.
   * @param dsl - DSL node with a `test` function and optional `watch` list.
   * @param key - Canonical cache key for this term.
   * @param getTerm - Term canonicalizer / cache accessor.
   * @param onDestroy - Called when the last consumer unsubscribes.
   */
  public static buildPredicate(
    world: World,
    dsl: { test: EntityTestFunc; watch?: unknown },
    key: string,
    getTerm: typeof GetTermFn,
    onDestroy: (term: Term) => void
  ): PredicateTerm {
    const watch = normalizeWatch(dsl.watch);
    const worldTerm = getTerm(world, true);
    const watchedTerms = watch.map((ceid) => getTerm(world, ceid));
    return new PredicateTerm(
      world,
      key,
      "predicate",
      dsl.test,
      worldTerm,
      watchedTerms,
      false,
      onDestroy
    );
  }

  /**
   * Build a merged (diamond-collapsed) predicate term for an `all`/`any`
   * subtree.
   *
   * The predicate is compiled from the full subtree DSL via `_compile` so no
   * composite child terms need to be constructed and then torn down. The
   * `worldTerm` leaf is included only when the subtree depends on world
   * lifecycle; shape-refresh subscription is added only when the subtree
   * contains an `only(...)` node.
   *
   * @param world - Owning world.
   * @param dsl - The original subtree DSL to compile into a predicate.
   * @param key - Canonical cache key for this term.
   * @param info - Pre-computed analysis of the subtree (from `_allAnyPrecheck`).
   * @param getTerm - Term canonicalizer / cache accessor.
   * @param onDestroy - Called when the last consumer unsubscribes.
   */
  public static buildMerged(
    world: World,
    dsl: QueryDSL,
    key: string,
    info: MergedInfo,
    getTerm: typeof GetTermFn,
    onDestroy: (term: Term) => void
  ): PredicateTerm {
    const predicate = _compile(world, dsl);
    const worldTerm = info.dependsOnWorld ? getTerm(world, true) : undefined;
    const watchedTerms = [...info.componentEids].map((ceid) => getTerm(world, ceid));
    return new PredicateTerm(
      world,
      key,
      "merged",
      predicate,
      worldTerm,
      watchedTerms,
      info.containsOnly,
      onDestroy
    );
  }

  /** Direct shape-channel invalidation from `WorldTerm.subscribeShape`. */
  public override onTermRefresh(entity: Entity): void {
    this._sync(entity);
  }

  /**
   * @internal React to a child term refresh.
   *
   * For the plain-predicate variant (`_usesShapeRefresh === false`) only
   * component-kind children trigger a re-evaluation — shape changes on the
   * world leaf are irrelevant. For the merged variant, world-kind refreshes
   * are also relevant when the subtree contained an `only(...)` node (because
   * `only` is sensitive to which components an entity currently has, not just
   * whether a specific one is present).
   */
  protected override _onChildRefresh(entity: Entity, child: Term): void {
    if (child.kind === "component" || (this._usesShapeRefresh && child.kind === "world")) {
      this._sync(entity);
    }
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return entity.alive && (this._worldTerm?.has(entity) ?? true) && this._predicate(entity);
  }
}

/** @internal Deduplicate and sort a `watch` list of component eids. */
export function normalizeWatch(watch: unknown): EID[] {
  if (watch === undefined) {
    return [];
  }
  return [...new Set((watch instanceof Array ? watch : [watch]) as EID[])].sort((a, b) => a - b);
}
