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
import {
  AllTerm,
  AnyTerm,
  ComponentTerm,
  EmptyTerm,
  MergedPredicateTerm,
  NotTerm,
  OnlyTerm,
  PredicateTerm,
  TargetTerm,
  Term,
  WorldTerm,
} from "./term.js";

const WORLD_LEAF = "W";

type BuildInfo = {
  leafKeys: Set<string>;
  componentEids: Set<number>;
  containsLifecycleTerm: boolean;
  containsOnly: boolean;
  containsTarget: boolean;
};

type BuiltTerm = BuildInfo & {
  term: Term;
};

export function getTerm(world: World, dsl: QueryDSL): Term {
  if (containsDownTerm(dsl)) {
    throw new Error("source/children terms are filter-only; use world.filter(...)");
  }
  return buildTerm(world, simplifyQueryDSL(dsl, world)).term;
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

function buildTerm(world: World, dsl: QueryDSL): BuiltTerm {
  const key = getDSLCacheKey(dsl, world);
  const cached = world._termCache.get(key);
  if (cached) {
    return { term: cached, ...analyzeDSL(dsl) };
  }

  const built = buildUncachedTerm(world, dsl, key);
  world._termCache.set(key, built.term);
  return built;
}

function buildUncachedTerm(world: World, dsl: QueryDSL, key: string): BuiltTerm {
  if (dsl === true) {
    return withInfo(getWorldTerm(world, key), worldInfo());
  }
  if (dsl === false) {
    return withInfo(getEmptyTerm(world, key), emptyInfo());
  }
  if (typeof dsl === "number") {
    return withInfo(getComponentTerm(world, dsl, key), componentInfo(dsl));
  }
  if (dsl instanceof Array) {
    return buildAllTerm(world, dsl, key);
  }
  if ("all" in dsl) {
    return buildAllTerm(world, dsl.all, key, dsl);
  }
  if ("any" in dsl) {
    return buildAnyTerm(world, dsl.any, key, dsl);
  }
  if ("not" in dsl) {
    const worldTerm = buildTerm(world, true);
    const child = buildTerm(world, dsl.not);
    const info = mergeInfo(worldTerm, child, { containsLifecycleTerm: true });
    const term = new NotTerm(world, key, worldTerm.term, child.term, (term) =>
      destroyTerm(world, term)
    );
    return withInfo(term, info);
  }
  if ("only" in dsl) {
    return buildOnlyTerm(world, dsl.only instanceof Array ? dsl.only : [dsl.only], key);
  }
  if ("test" in dsl) {
    return buildPredicateTerm(world, dsl, key);
  }
  if ("target" in dsl) {
    return buildTargetTerm(world, dsl.target[0] as number, dsl.target[1], key);
  }
  throw new Error("Unrecognized query term");
}

function buildAllTerm(
  world: World,
  terms: readonly QueryDSL[],
  key: string,
  originalDSL: QueryDSL = terms as ComponentRefArray
): BuiltTerm {
  const childInfos = terms.map(analyzeDSL);
  if (hasDiamond(childInfos) && !childInfos.some((child) => child.containsTarget)) {
    return buildMergedTerm(world, originalDSL, key, childInfos);
  }
  const children = terms.map((term) => buildTerm(world, term));
  const term = new AllTerm(
    world,
    key,
    children.map((child) => child.term),
    (term) => destroyTerm(world, term)
  );
  return withInfo(term, mergeInfo(...children));
}

function buildAnyTerm(
  world: World,
  terms: readonly QueryDSL[],
  key: string,
  originalDSL: QueryDSL
): BuiltTerm {
  const childInfos = terms.map(analyzeDSL);
  if (hasDiamond(childInfos) && !childInfos.some((child) => child.containsTarget)) {
    return buildMergedTerm(world, originalDSL, key, childInfos);
  }
  const children = terms.map((term) => buildTerm(world, term));
  const term = new AnyTerm(
    world,
    key,
    children.map((child) => child.term),
    (term) => destroyTerm(world, term)
  );
  return withInfo(term, mergeInfo(...children));
}

function buildOnlyTerm(world: World, components: readonly QueryDSL[], key: string): BuiltTerm {
  const componentEids = components.map((component) => component as number);
  const all = buildAllTerm(world, componentEids, getDSLCacheKey(componentEids, world));
  const worldTerm = buildTerm(world, true);
  const info = mergeInfo(all, worldTerm, { containsLifecycleTerm: true, containsOnly: true });
  const term = new OnlyTerm(world, key, all.term, worldTerm.term, componentEids, (term) =>
    destroyTerm(world, term)
  );
  return withInfo(term, info);
}

function buildPredicateTerm(
  world: World,
  dsl: { test: EntityTestFunc; watch?: unknown },
  key: string
): BuiltTerm {
  const watch = normalizeWatch(dsl.watch);
  const worldTerm = buildTerm(world, true);
  const watchedTerms = watch.map((eid) => buildTerm(world, eid));
  const info = mergeInfo(worldTerm, ...watchedTerms, { containsLifecycleTerm: true });
  const term = new PredicateTerm(
    world,
    key,
    worldTerm.term,
    watchedTerms.map((watched) => watched.term),
    dsl.test,
    (term) => destroyTerm(world, term)
  );
  return withInfo(term, info);
}

function buildTargetTerm(
  world: World,
  relationshipEid: number,
  innerDSL: QueryDSL,
  key: string
): BuiltTerm {
  const relationshipTerm = buildTerm(world, relationshipEid);
  const innerTerm = buildTerm(world, innerDSL);
  const info = mergeInfo(relationshipTerm, innerTerm, { containsTarget: true });
  const term = new TargetTerm(
    world,
    key,
    relationshipEid,
    relationshipTerm.term,
    innerTerm.term,
    (term) => destroyTerm(world, term)
  );
  return withInfo(term, info);
}

function buildMergedTerm(
  world: World,
  dsl: QueryDSL,
  key: string,
  children: readonly BuildInfo[]
): BuiltTerm {
  const info = mergeInfo(...children);
  const watchedTerms = [...info.componentEids].map((eid) => buildTerm(world, eid).term);
  const worldTerm = info.containsLifecycleTerm ? buildTerm(world, true).term : undefined;
  const term = new MergedPredicateTerm(
    world,
    key,
    dsl,
    worldTerm,
    watchedTerms,
    info.containsOnly,
    (term) => destroyTerm(world, term)
  );
  return withInfo(term, info);
}

function getComponentTerm(world: World, eid: number, key: string): ComponentTerm {
  let term = world._componentTerms.get(eid);
  if (!term) {
    term = new ComponentTerm(world, key, eid, (term) => destroyTerm(world, term));
    world._componentTerms.set(eid, term);
  }
  return term;
}

function getEmptyTerm(world: World, key: string): EmptyTerm {
  if (!world._emptyTerm) {
    world._emptyTerm = new EmptyTerm(world, key, (term) => destroyTerm(world, term));
  }
  return world._emptyTerm;
}

function getWorldTerm(world: World, key: string): WorldTerm {
  if (!world._worldTerm) {
    world._worldTerm = new WorldTerm(world, key, (term) => destroyTerm(world, term));
  }
  return world._worldTerm;
}

function destroyTerm(world: World, term: Term): void {
  world._termCache.delete(term.key);
}

function analyzeDSL(dsl: QueryDSL): BuildInfo {
  if (dsl === true) {
    return worldInfo();
  }
  if (dsl === false) {
    return emptyInfo();
  }
  if (typeof dsl === "number") {
    return componentInfo(dsl);
  }
  if (dsl instanceof Array) {
    return mergeInfo(...dsl.map(analyzeDSL));
  }
  if ("all" in dsl) {
    return mergeInfo(...dsl.all.map(analyzeDSL));
  }
  if ("any" in dsl) {
    return mergeInfo(...dsl.any.map(analyzeDSL));
  }
  if ("not" in dsl) {
    return mergeInfo(worldInfo(), analyzeDSL(dsl.not), { containsLifecycleTerm: true });
  }
  if ("only" in dsl) {
    const components = dsl.only instanceof Array ? dsl.only : [dsl.only];
    return mergeInfo(...components.map((component) => componentInfo(component as number)), {
      containsLifecycleTerm: true,
      containsOnly: true,
    });
  }
  if ("test" in dsl) {
    return mergeInfo(worldInfo(), ...normalizeWatch(dsl.watch).map(componentInfo), {
      containsLifecycleTerm: true,
    });
  }
  if ("target" in dsl) {
    return mergeInfo(componentInfo(dsl.target[0] as number), analyzeDSL(dsl.target[1]), {
      containsTarget: true,
    });
  }
  return emptyInfo();
}

function componentInfo(eid: number): BuildInfo {
  return {
    leafKeys: new Set([`C:${eid}`]),
    componentEids: new Set([eid]),
    containsLifecycleTerm: false,
    containsOnly: false,
    containsTarget: false,
  };
}

function emptyInfo(): BuildInfo {
  return {
    leafKeys: new Set(),
    componentEids: new Set(),
    containsLifecycleTerm: false,
    containsOnly: false,
    containsTarget: false,
  };
}

function hasDiamond(children: readonly BuildInfo[]): boolean {
  const seen = new Set<string>();
  for (const child of children) {
    for (const leaf of child.leafKeys) {
      if (seen.has(leaf)) {
        return true;
      }
      seen.add(leaf);
    }
  }
  return false;
}

function mergeInfo(...infos: (BuildInfo | Partial<BuildInfo>)[]): BuildInfo {
  const merged = emptyInfo();
  for (const info of infos) {
    info.leafKeys?.forEach((leaf) => merged.leafKeys.add(leaf));
    info.componentEids?.forEach((eid) => merged.componentEids.add(eid));
    merged.containsLifecycleTerm ||= info.containsLifecycleTerm ?? false;
    merged.containsOnly ||= info.containsOnly ?? false;
    merged.containsTarget ||= info.containsTarget ?? false;
  }
  return merged;
}

function normalizeWatch(watch: unknown): number[] {
  if (watch === undefined) {
    return [];
  }
  return [...new Set((watch instanceof Array ? watch : [watch]) as number[])].sort((a, b) => a - b);
}

function withInfo(term: Term, info: BuildInfo): BuiltTerm {
  return { term, ...info };
}

function worldInfo(): BuildInfo {
  return {
    leafKeys: new Set([WORLD_LEAF]),
    componentEids: new Set(),
    containsLifecycleTerm: true,
    containsOnly: false,
    containsTarget: false,
  };
}
