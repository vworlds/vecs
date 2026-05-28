import { type ComponentRefArray } from "../component.js";
import {
  containsDownTerm,
  getDSLCacheKey,
  simplifyQueryDSL,
  type EntityTestFunc,
  type QueryDSL,
} from "../dsl.js";
import type { World } from "../world/index.js";
import type { Entity } from "../entity/index.js";
import { AllTerm } from "./all_term.js";
import { AnyTerm } from "./any_term.js";
import { ComponentTerm } from "./component_term.js";
import { EmptyTerm } from "./empty_term.js";
import { MergedPredicateTerm, type MergedInfo } from "./merged_predicate_term.js";
import { NotTerm } from "./not_term.js";
import { OnlyTerm } from "./only_term.js";
import { normalizeWatch, PredicateTerm } from "./predicate_term.js";
import { TargetTerm } from "./target_term.js";
import { Term } from "./term.js";
import { WorldTerm } from "./world_term.js";

const WORLD_LEAF = "W";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

export function getCachedTerm(world: World, dsl: QueryDSL): Term | undefined {
  return world._termCache.get(getDSLCacheKey(dsl, world));
}

export function notifyComponentAdded(world: World, componentEid: number, entity: Entity): void {
  world._componentTerms.get(componentEid)?.componentAdded(entity);
  world._worldTerm?.entityShapeChanged(entity);
}

export function notifyComponentChanged(world: World, componentEid: number, entity: Entity): void {
  world._componentTerms.get(componentEid)?.componentChanged(entity);
}

export function notifyComponentRemoved(world: World, componentEid: number, entity: Entity): void {
  world._componentTerms.get(componentEid)?.componentRemoved(entity);
  world._worldTerm?.entityShapeChanged(entity);
}

export function notifyEntityCreated(world: World, entity: Entity): void {
  world._worldTerm?.entityCreated(entity);
}

export function notifyEntityDestroyed(world: World, entity: Entity): void {
  world._worldTerm?.entityDestroyed(entity);
}

// ---------------------------------------------------------------------------
// Central dispatch — the only place that maps DSL shape → class
// ---------------------------------------------------------------------------

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
    return AllTerm.build(world, dsl, key, dsl as ComponentRefArray, getTerm, _allAnyPrecheck, onDestroy);
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
    return OnlyTerm.build(world, components as number[], key, getTerm, onDestroy);
  }
  if ("test" in dsl) {
    return PredicateTerm.build(world, dsl as { test: EntityTestFunc; watch?: unknown }, key, getTerm, onDestroy);
  }
  if ("target" in dsl) {
    return TargetTerm.build(world, dsl.target[0] as number, dsl.target[1], key, getTerm, onDestroy);
  }
  throw new Error("Unrecognized query term");
}

// ---------------------------------------------------------------------------
// World-singleton leaf getters
// ---------------------------------------------------------------------------

function getComponentTerm(world: World, eid: number, key: string): ComponentTerm {
  let term = world._componentTerms.get(eid);
  if (!term) {
    term = new ComponentTerm(world, key, eid, (t) => destroyTerm(world, t));
    world._componentTerms.set(eid, term);
  }
  return term;
}

function getEmptyTerm(world: World, key: string): EmptyTerm {
  if (!world._emptyTerm) {
    world._emptyTerm = new EmptyTerm(world, key, (t) => destroyTerm(world, t));
  }
  return world._emptyTerm;
}

function getWorldTerm(world: World, key: string): WorldTerm {
  if (!world._worldTerm) {
    world._worldTerm = new WorldTerm(world, key, (t) => destroyTerm(world, t));
  }
  return world._worldTerm;
}

function destroyTerm(world: World, term: Term): void {
  world._termCache.delete(term.key);
}

// ---------------------------------------------------------------------------
// Diamond pre-check — DSL-level analysis to avoid building then destroying
// ---------------------------------------------------------------------------

type DslAnalysis = {
  leafKeys: Set<string>;
  componentEids: Set<number>;
  dependsOnWorld: boolean;
  containsOnly: boolean;
  containsTarget: boolean;
};

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
    return { leafKeys: new Set(), componentEids: new Set(), dependsOnWorld: false, containsOnly: false, containsTarget: false };
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
      { leafKeys: new Set([WORLD_LEAF]), componentEids: new Set(), dependsOnWorld: true, containsOnly: false, containsTarget: false },
      _analyzeDSL(dsl.not),
    ]);
  }
  if ("only" in dsl) {
    const components = dsl.only instanceof Array ? dsl.only : [dsl.only];
    const childAnalyses = (components as number[]).map((eid) => ({
      leafKeys: new Set([`C:${eid}`]) as Set<string>,
      componentEids: new Set([eid]),
      dependsOnWorld: false as boolean,
      containsOnly: false as boolean,
      containsTarget: false as boolean,
    }));
    return _mergeAnalyses([
      ...childAnalyses,
      { leafKeys: new Set([WORLD_LEAF]), componentEids: new Set(), dependsOnWorld: true, containsOnly: true, containsTarget: false },
    ]);
  }
  if ("test" in dsl) {
    const watch = normalizeWatch(dsl.watch);
    return _mergeAnalyses([
      { leafKeys: new Set([WORLD_LEAF]), componentEids: new Set(), dependsOnWorld: true, containsOnly: false, containsTarget: false },
      ...watch.map((eid) => ({
        leafKeys: new Set([`C:${eid}`]) as Set<string>,
        componentEids: new Set([eid]),
        dependsOnWorld: false as boolean,
        containsOnly: false as boolean,
        containsTarget: false as boolean,
      })),
    ]);
  }
  if ("target" in dsl) {
    const relEid = dsl.target[0] as number;
    return _mergeAnalyses([
      {
        leafKeys: new Set([`C:${relEid}`]) as Set<string>,
        componentEids: new Set([relEid]),
        dependsOnWorld: false,
        containsOnly: false,
        containsTarget: true,
      },
      { ..._analyzeDSL(dsl.target[1]), containsTarget: true },
    ]);
  }
  return { leafKeys: new Set(), componentEids: new Set(), dependsOnWorld: false, containsOnly: false, containsTarget: false };
}

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
    a.componentEids.forEach((eid) => merged.componentEids.add(eid));
    merged.dependsOnWorld ||= a.dependsOnWorld;
    merged.containsOnly ||= a.containsOnly;
    merged.containsTarget ||= a.containsTarget;
  }
  return merged;
}

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

function _allAnyPrecheck(
  terms: readonly QueryDSL[]
): { hasDiamond: boolean; containsTarget: boolean; info: MergedInfo } {
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
