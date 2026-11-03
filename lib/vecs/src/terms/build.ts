/**
 * Term graph construction, canonicalization, and world notification routing.
 *
 * ## Architecture
 *
 * The term graph is a reactive tree of **materialized entity sets**. Each node
 * holds the live set of entities currently satisfying its sub-predicate and
 * propagates enter/exit events up to its consumers whenever the set changes.
 *
 * **Leaf terms** (`WorldTerm`, `ComponentTerm`, `EmptyTerm`) act as global
 * indexes. They are world-pinned singletons that persist at zero consumers so
 * the cost of maintaining them is paid once, not once per query.
 *
 * **Composite terms** (`AllTerm`, `AnyTerm`, `NotTerm`, `OnlyTerm`,
 * `PredicateTerm`, `TargetTerm`) are cached under a canonical DSL key so
 * equivalent queries deduplicate to the same node in the graph. Lifetime
 * follows consumer count: the last `unsubscribe` call destroys the term and
 * cascades destruction to any children whose consumer count also reaches zero.
 *
 * **`getTerm`** is the single entry point: it canonicalizes the DSL
 * (`simplifyQueryDSL` + `getDSLCacheKey`), looks up the term cache, and on a
 * miss calls `_dispatch` to instantiate the right class, then stores the
 * result. The key is the term's only stable identity — the term registers its
 * own destructor to remove itself from the cache when it is destroyed.
 *
 * **Diamond detection and collapsing.** A diamond occurs when a single leaf is
 * reachable by two or more paths inside one `all`/`any` subtree (e.g.
 * `any(Position, { all: [Position, Velocity] })`). Without collapsing, one
 * entity transition on the shared leaf would propagate up two subtrees and the
 * composite would emit two spurious enter/exit pairs. The solution is a
 * DSL-level pre-analysis pass (`_analyzeDSL` → `_hasDiamond`) that runs
 * *before* any children are built. If a diamond is found the entire subtree is
 * collapsed into a single `PredicateTerm` (kind `"merged"`) backed by a
 * compiled predicate, so the live graph stays a strict tree and propagation is
 * plain recursive pull-recompute — no glitch scheduler needed.
 *
 * The analysis **must** precede child construction because child terms may
 * already have live consumers from other queries; building them just to tear
 * them down would leave stale subscription counts on shared leaves.
 */
import { type ComponentRef, type ComponentRefArray } from "../component.js";
import {
  containsDownTerm,
  getDSLCacheKey,
  simplifyQueryDSL,
  type EntityTestFunc,
  type QueryDSL,
} from "../dsl.js";
import type { World } from "../world/index.js";
import type { EID, Entity } from "../entity/index.js";
import { AllTerm } from "./all_term.js";
import { AnyTerm } from "./any_term.js";
import { ComponentTerm } from "./component_term.js";
import { EmptyTerm } from "./empty_term.js";
import { NotTerm } from "./not_term.js";
import { OnlyTerm } from "./only_term.js";
import { normalizeWatch, PredicateTerm, type MergedInfo } from "./predicate_term.js";
import { TargetTerm } from "./target_term.js";
import { Term } from "./term.js";
import { WorldTerm } from "./world_term.js";

const WORLD_LEAF = "W";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Canonicalize `dsl`, look up or create its term in the world cache, and
 * return it.
 *
 * This is the primary entry point for all query and filter construction.
 * Throws if `dsl` contains a `source`/`children`/`parent` down-term, which
 * is filter-only and cannot be represented as a cached term.
 *
 * @param world - Owning world.
 * @param dsl - Query DSL expression to resolve.
 * @returns The canonical `Term` for `dsl` in this world.
 */
export function getTerm(world: World, dsl: QueryDSL): Term {
  if (containsDownTerm(dsl)) {
    throw new Error("source/children terms are filter-only; use world.filter(...)");
  }
  const simplified = simplifyQueryDSL(dsl, world);
  const key = getDSLCacheKey(simplified, world);
  const cached = world._termCache.get(key);
  if (cached) {
    return cached;
  }
  const term = _dispatch(world, simplified, key);
  world._termCache.set(key, term);
  return term;
}

/**
 * Return the cached term for `dsl` without creating one if absent.
 *
 * Useful for introspection and testing. It canonicalizes `dsl` (via the same
 * simplify + cache-key path as {@link getTerm}) to look the term up, but never
 * creates one.
 *
 * @param world - Owning world.
 * @param dsl - Query DSL expression to look up.
 * @returns The cached `Term`, or `undefined` if none exists.
 */
export function getCachedTerm(world: World, dsl: QueryDSL): Term | undefined {
  return world._termCache.get(getDSLCacheKey(dsl, world));
}

/**
 * Notify the term graph that `componentEid` was added to `entity`.
 *
 * Routes to the corresponding `ComponentTerm` (membership enter) and to the
 * world term (shape change, needed by `only` and merged predicate terms).
 */
export function notifyComponentAdded(world: World, componentEid: EID, entity: Entity): void {
  world._componentTerms.get(componentEid)?.componentAdded(entity);
  world._worldTerm?.entityShapeChanged(entity);
}

/**
 * Notify the term graph that a component of `componentEid` changed value on
 * `entity` without a membership change.
 *
 * Routes only to the `ComponentTerm`'s refresh channel (not shape), which
 * wakes predicate terms watching this component.
 */
export function notifyComponentChanged(world: World, componentEid: EID, entity: Entity): void {
  world._componentTerms.get(componentEid)?.componentChanged(entity);
}

/**
 * Notify the term graph that `componentEid` was removed from `entity`.
 *
 * Routes to the `ComponentTerm` (membership exit) and world term (shape).
 * Pass an already-resolved `componentTerm` to avoid another leaf lookup;
 * `null` explicitly means the lookup found no component leaf. Omitting it
 * preserves the ordinary lookup by `componentEid`.
 */
export function notifyComponentRemoved(
  world: World,
  componentEid: EID,
  entity: Entity,
  componentTerm: ComponentTerm | null = world._componentTerms.get(componentEid) ?? null
): void {
  componentTerm?.componentRemoved(entity);
  world._worldTerm?.entityShapeChanged(entity);
}

/**
 * Notify the term graph that a new entity was created.
 *
 * The world term evaluates the entity immediately and emits an enter event if
 * it qualifies (any live, non-destroyed entity — component-definition entities
 * included, so they are picked up reactively like ordinary entities).
 */
export function notifyEntityCreated(world: World, entity: Entity): void {
  world._worldTerm?.entityCreated(entity);
}

/**
 * Notify the term graph that `entity` was destroyed.
 *
 * The world term removes the entity from its set unconditionally, propagating
 * exit events up the tree.
 */
export function notifyEntityDestroyed(world: World, entity: Entity): void {
  world._worldTerm?.entityDestroyed(entity);
}

// ---------------------------------------------------------------------------
// Central dispatch — the only place that maps DSL shape → class
// ---------------------------------------------------------------------------

/**
 * Map a simplified, canonical DSL node to the appropriate `Term` subclass.
 *
 * This is the single place where DSL structure is translated to a live term.
 * Every branch either returns a world-singleton leaf (world / component /
 * empty) or constructs a new composite term. The `AllTerm` and `AnyTerm`
 * branches delegate to their respective static builders, which perform the
 * diamond pre-check before constructing any children.
 */
function _dispatch(world: World, dsl: QueryDSL, key: string): Term {
  const onDestroy = (term: Term) => destroyTerm(world, term);

  if (dsl === true) {
    return getWorldTerm(world, key);
  }
  if (dsl === false) {
    return getEmptyTerm(world, key);
  }
  if (typeof dsl === "number") {
    return getComponentTerm(world, dsl, key);
  }
  if (dsl instanceof Array) {
    return AllTerm.build(
      world,
      dsl,
      key,
      dsl as ComponentRefArray,
      getTerm,
      _allAnyPrecheck,
      onDestroy
    );
  }
  if ("all" in dsl) {
    return AllTerm.build(world, dsl.all, key, dsl, getTerm, _allAnyPrecheck, onDestroy);
  }
  if ("any" in dsl) {
    return AnyTerm.build(world, dsl.any, key, dsl, getTerm, _allAnyPrecheck, onDestroy);
  }
  if ("not" in dsl) {
    return NotTerm.build(world, dsl.not, key, getTerm, onDestroy);
  }
  if ("only" in dsl) {
    const components = dsl.only instanceof Array ? dsl.only : [dsl.only];
    return OnlyTerm.build(world, components as EID[], key, getTerm, onDestroy);
  }
  if ("test" in dsl) {
    return PredicateTerm.buildPredicate(
      world,
      dsl as { test: EntityTestFunc; watch?: unknown },
      key,
      getTerm,
      onDestroy
    );
  }
  if ("target" in dsl && Array.isArray((dsl as any).target)) {
    const d = dsl as { target: readonly [ComponentRef, QueryDSL] };
    return TargetTerm.build(world, d.target[0] as EID, d.target[1], key, getTerm, onDestroy);
  }
  throw new Error("Unrecognized query term");
}

// ---------------------------------------------------------------------------
// World-singleton leaf getters
// ---------------------------------------------------------------------------

/**
 * Return the world's singleton `ComponentTerm` for `ceid`, creating it if
 * absent.
 */
function getComponentTerm(world: World, ceid: EID, key: string): ComponentTerm {
  let term = world._componentTerms.get(ceid);
  if (!term) {
    term = new ComponentTerm(world, key, ceid, (t) => destroyTerm(world, t));
    world._componentTerms.set(ceid, term);
  }
  return term;
}

/** Return the world's singleton `EmptyTerm`, creating it if absent. */
function getEmptyTerm(world: World, key: string): EmptyTerm {
  if (!world._emptyTerm) {
    world._emptyTerm = new EmptyTerm(world, key, (t) => destroyTerm(world, t));
  }
  return world._emptyTerm;
}

/** Return the world's singleton `WorldTerm`, creating it if absent. */
function getWorldTerm(world: World, key: string): WorldTerm {
  if (!world._worldTerm) {
    world._worldTerm = new WorldTerm(world, key, (t) => destroyTerm(world, t));
  }
  return world._worldTerm;
}

/**
 * Remove `term` from the world term cache.
 *
 * Called by a term's `_onDestroy` hook when its consumer count reaches zero.
 */
function destroyTerm(world: World, term: Term): void {
  world._termCache.delete(term.key);
}

// ---------------------------------------------------------------------------
// Diamond pre-check — DSL-level analysis to avoid building then destroying
// composite children
// ---------------------------------------------------------------------------

/**
 * Per-node analysis produced by `_analyzeDSL`.
 *
 * Collects the set of unique leaf keys, component eids, and boolean flags used
 * to detect diamonds and configure a potential merged term.
 */
type DslAnalysis = {
  leafKeys: Set<string>;
  componentEids: Set<EID>;
  dependsOnWorld: boolean;
  containsOnly: boolean;
  containsTarget: boolean;
};

/**
 * Recursively collect leaf metadata from a DSL subtree.
 *
 * This walk runs **before** any child terms are constructed. That is the
 * whole point: `all`/`any` can decide to collapse the entire subtree into a
 * single merged predicate term *without* first building — and then having to
 * tear down — composite children that may already be cached with live
 * consumers. Tearing down such nodes would incorrectly decrement their
 * consumer counts and could destroy them while other queries still hold
 * subscriptions.
 *
 * @param dsl - The DSL node to analyze.
 * @returns Aggregated analysis for this subtree.
 */
function _analyzeDSL(dsl: QueryDSL): DslAnalysis {
  if (dsl === true) {
    return {
      leafKeys: new Set([WORLD_LEAF]),
      componentEids: new Set(),
      dependsOnWorld: true,
      containsOnly: false,
      containsTarget: false,
    };
  }
  if (dsl === false) {
    return {
      leafKeys: new Set(),
      componentEids: new Set(),
      dependsOnWorld: false,
      containsOnly: false,
      containsTarget: false,
    };
  }
  if (typeof dsl === "number") {
    return {
      leafKeys: new Set([`C:${dsl}`]),
      componentEids: new Set([dsl]),
      dependsOnWorld: false,
      containsOnly: false,
      containsTarget: false,
    };
  }
  if (dsl instanceof Array) {
    return _mergeAnalyses(dsl.map(_analyzeDSL));
  }
  if ("all" in dsl) {
    return _mergeAnalyses(dsl.all.map(_analyzeDSL));
  }
  if ("any" in dsl) {
    return _mergeAnalyses(dsl.any.map(_analyzeDSL));
  }
  if ("not" in dsl) {
    return _mergeAnalyses([
      {
        leafKeys: new Set([WORLD_LEAF]),
        componentEids: new Set(),
        dependsOnWorld: true,
        containsOnly: false,
        containsTarget: false,
      },
      _analyzeDSL(dsl.not),
    ]);
  }
  if ("only" in dsl) {
    const components = dsl.only instanceof Array ? dsl.only : [dsl.only];
    const childAnalyses = (components as EID[]).map((ceid) => ({
      leafKeys: new Set([`C:${ceid}`]) as Set<string>,
      componentEids: new Set([ceid]),
      dependsOnWorld: false as boolean,
      containsOnly: false as boolean,
      containsTarget: false as boolean,
    }));
    return _mergeAnalyses([
      ...childAnalyses,
      {
        leafKeys: new Set([WORLD_LEAF]),
        componentEids: new Set(),
        dependsOnWorld: true,
        containsOnly: true,
        containsTarget: false,
      },
    ]);
  }
  if ("test" in dsl) {
    const watch = normalizeWatch(dsl.watch);
    return _mergeAnalyses([
      {
        leafKeys: new Set([WORLD_LEAF]),
        componentEids: new Set(),
        dependsOnWorld: true,
        containsOnly: false,
        containsTarget: false,
      },
      ...watch.map((ceid) => ({
        leafKeys: new Set([`C:${ceid}`]) as Set<string>,
        componentEids: new Set([ceid]),
        dependsOnWorld: false as boolean,
        containsOnly: false as boolean,
        containsTarget: false as boolean,
      })),
    ]);
  }
  if ("target" in dsl && Array.isArray((dsl as any).target)) {
    const d = dsl as { target: readonly [ComponentRef, QueryDSL] };
    const relEid = d.target[0] as EID;
    return _mergeAnalyses([
      {
        leafKeys: new Set([`C:${relEid}`]) as Set<string>,
        componentEids: new Set([relEid]),
        dependsOnWorld: false,
        containsOnly: false,
        containsTarget: true,
      },
      { ..._analyzeDSL(d.target[1]), containsTarget: true },
    ]);
  }
  return {
    leafKeys: new Set(),
    componentEids: new Set(),
    dependsOnWorld: false,
    containsOnly: false,
    containsTarget: false,
  };
}

/**
 * Fold an array of per-child analyses into a single aggregate.
 *
 * Leaf key sets are unioned, boolean flags are OR-ed, and component eid sets
 * are unioned. The union of `leafKeys` across children is what lets
 * `_hasDiamond` spot reconvergent leaves.
 */
function _mergeAnalyses(analyses: DslAnalysis[]): DslAnalysis {
  const merged: DslAnalysis = {
    leafKeys: new Set(),
    componentEids: new Set(),
    dependsOnWorld: false,
    containsOnly: false,
    containsTarget: false,
  };
  for (const a of analyses) {
    a.leafKeys.forEach((k) => merged.leafKeys.add(k));
    a.componentEids.forEach((ceid) => merged.componentEids.add(ceid));
    merged.dependsOnWorld ||= a.dependsOnWorld;
    merged.containsOnly ||= a.containsOnly;
    merged.containsTarget ||= a.containsTarget;
  }
  return merged;
}

/**
 * Return `true` when any leaf key appears in more than one child analysis.
 *
 * A repeated leaf key means the same `ComponentTerm` or `WorldTerm` would be
 * reachable via two paths under a single `all`/`any` parent — the definition
 * of a diamond. The leaf-key intersection test runs in O(total leaf count)
 * using the `seen` set.
 */
function _hasDiamond(analyses: DslAnalysis[]): boolean {
  const seen = new Set<string>();
  for (const a of analyses) {
    for (const leaf of a.leafKeys) {
      if (seen.has(leaf)) {
        return true;
      }
      seen.add(leaf);
    }
  }
  return false;
}

/**
 * Run the diamond pre-check for the direct children of an `all`/`any` node
 * and return results needed by the caller to decide whether to collapse.
 *
 * Called by `AllTerm.build` and `AnyTerm.build` before constructing any
 * children. When `hasDiamond` is `true` and `containsTarget` is `false` the
 * caller should invoke `PredicateTerm.buildMerged` with the returned `info`
 * instead of building the composite tree.
 *
 * `target` terms are excluded from collapsing because `TargetTerm` uses a
 * non-standard event routing strategy (it fans out from the inner term to all
 * sources) that cannot be reproduced by a plain compiled predicate.
 *
 * @param terms - Direct child DSL nodes of the `all`/`any` being analyzed.
 * @returns Diamond flag, target flag, and aggregated `MergedInfo`.
 */
function _allAnyPrecheck(terms: readonly QueryDSL[]): {
  hasDiamond: boolean;
  containsTarget: boolean;
  info: MergedInfo;
} {
  const analyses = terms.map(_analyzeDSL);
  const diamond = _hasDiamond(analyses);
  const containsTarget = analyses.some((a) => a.containsTarget);
  const merged = _mergeAnalyses(analyses);
  return {
    hasDiamond: diamond,
    containsTarget,
    info: {
      componentEids: merged.componentEids,
      dependsOnWorld: merged.dependsOnWorld,
      containsOnly: merged.containsOnly,
    },
  };
}
