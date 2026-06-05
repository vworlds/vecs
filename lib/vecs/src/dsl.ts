import { type ComponentClass, type ComponentRef, type ComponentType } from "./component.js";
import { Entity } from "./entity/index.js";
import { ChildOf } from "./modules/relationships.js";
import type { World } from "./world/index.js";
import { Bitset } from "./util/bitset.js";

/**
 * A predicate that decides whether a given entity belongs to a query.
 *
 * Use `{ test: fn }` inside {@link QueryDSL} to express membership rules that
 * the structured operators cannot reach.
 */
export type EntityTestFunc = (e: Entity) => boolean;

/**
 * A composable expression describing which entities a {@link Query},
 * {@link System}, or {@link Filter} should match.
 *
 * Operators can be nested arbitrarily:
 *
 * ```ts
 * // Position and either Sprite or Container:
 * world.system("render").query({
 *   all: [Position, { any: [Sprite, Container] }],
 * });
 *
 * Short forms recognized by `query` / `filter`:
 * - `true` matches all entities; `false` matches no entities.
 * - A registered component class or numeric type id matches entities with that component.
 * - An array `[A, B]` matches entities with all listed components.
 * - An empty array `[]` is shorthand for `true`.
 * - `{ test: fn, watch: refs }` invokes an arbitrary predicate, rechecked for watched refs.
 *
 * Function values are component classes. Register component classes before using
 * them in query DSL expressions.
 */
export type QueryDSL =
  | true
  | false
  | readonly ComponentRef[]
  | ComponentRef
  | { all: readonly QueryDSL[] }
  | { any: readonly QueryDSL[] }
  | { not: QueryDSL }
  | { only: readonly ComponentRef[] | ComponentRef }
  | { target: readonly [ComponentRef, QueryDSL] }
  | { source: readonly [ComponentRef, QueryDSL] }
  | { parent: QueryDSL }
  | { children: QueryDSL }
  | { test: EntityTestFunc; watch?: readonly ComponentRef[] | ComponentRef };

/**
 * Resolve component nullability based on what was declared in `requires` (or
 * the `_guaranteed` hint).
 *
 * Components in `R` resolve to `InstanceType<C>`; every other component class
 * resolves to `InstanceType<C> | undefined`.
 *
 * @typeParam C - Component class being injected.
 * @typeParam R - Tuple of component classes guaranteed present.
 */
export type MaybeRequired<C, R extends ComponentType[]> = C extends ComponentType
  ? C extends R[number]
    ? InstanceType<C>
    : InstanceType<C> | undefined
  : never;

/**
 * Statically extract the component classes that are **guaranteed present** on
 * every entity matched by a {@link QueryDSL} expression.
 *
 * Rules:
 * - Plain component class `C` → `[C]`
 * - Plain array `[A, B]` → `[A, B]`
 * - `true` / `false` / `[]` → `[]` (no guarantee)
 * - `{ only: ... }` → recurse into the payload
 * - `{ all: [q1, q2, ...] }` → concatenate each branch's extraction
 * - `{ any: ... }` / `{ not: ... }` / `{ test: ... }` → `[]` (no guarantee)
 * - numeric type id → `[]` (opaque)
 *
 * @typeParam Q - Query expression to analyse.
 */
export type ExtractRequired<Q> = Q extends ComponentType
  ? [Q]
  : Q extends readonly ComponentType[]
    ? [...Q]
    : Q extends { only: infer H }
      ? ExtractRequired<H>
      : Q extends { all: infer A extends readonly QueryDSL[] }
        ? _ExtractAndChain<A>
        : [];

type _ExtractAndChain<A extends readonly QueryDSL[]> = A extends readonly [
  infer First,
  ...infer Rest extends readonly QueryDSL[],
]
  ? [...ExtractRequired<First>, ..._ExtractAndChain<Rest>]
  : [];

function _isClassConstructor(value: QueryDSL): value is ComponentClass {
  return (
    typeof value === "function" && Function.prototype.toString.call(value).startsWith("class ")
  );
}

function _componentRequirements(q: QueryDSL): readonly ComponentRef[] | undefined {
  if (typeof q === "number" || q instanceof Entity) {
    return [q];
  }

  if (_isClassConstructor(q)) {
    return [q];
  }

  if (q instanceof Array) {
    return q;
  }

  return undefined;
}

function _asShortestComponentRequirement(components: readonly ComponentRef[]): QueryDSL {
  if (components.length === 0) {
    return true;
  }
  return components.length === 1 ? components[0] : components;
}

function _calculateComponentBitmask(types: readonly number[]): Bitset {
  const bitmask = new Bitset();
  types.forEach((type) => {
    bitmask.add(type);
  });
  return bitmask;
}

function _resolveComponentRequirement(component: ComponentRef, world: World): number {
  return world.entity(component).eid;
}

export function _resolveRelationship(ref: ComponentRef, world: World): number {
  const entity = world.entity(ref);
  const relMeta = entity.meta;
  if (!relMeta.isRelationship) {
    throw new Error(`Component ${relMeta.Class.name} is not a Relationship`);
  }
  return entity.eid;
}

function _resolveChildOfRelationship(world: World): number {
  return _resolveRelationship(ChildOf, world);
}

function _resolveBareComponent(component: ComponentRef, world: World): QueryDSL {
  if (typeof component === "number") {
    return component;
  }
  if (component instanceof Entity) {
    return component.eid;
  }

  return world.entity(component).eid;
}

function _sortComponentRequirements(components: readonly ComponentRef[]): ComponentRef[] {
  return [...components].sort((a, b) => {
    const aEid = typeof a === "number" ? a : a instanceof Entity ? a.eid : undefined;
    const bEid = typeof b === "number" ? b : b instanceof Entity ? b.eid : undefined;
    if (aEid !== undefined && bEid !== undefined) {
      return aEid - bEid;
    }
    if (aEid !== undefined) {
      return -1;
    }
    if (bEid !== undefined) {
      return 1;
    }
    return 0;
  });
}

function _asShortestHasOnlyRequirement(
  components: readonly ComponentRef[]
): readonly ComponentRef[] | ComponentRef {
  return components.length === 1 ? components[0] : components;
}

function _asCanonicalComponentRequirement(
  components: readonly ComponentRef[],
  world: World
): QueryDSL {
  return _asShortestComponentRequirement(
    _sortComponentRequirements(
      components.map((component) => _resolveComponentRequirement(component, world))
    )
  );
}

function _componentSortKey(q: QueryDSL): number | undefined {
  if (typeof q === "number") {
    return q;
  }
  if (q instanceof Entity) {
    return q.eid;
  }
  if (q instanceof Array && q.length > 0 && q.every((term) => typeof term === "number")) {
    return q[0] as number;
  }
  return undefined;
}

function _termSortKey(q: QueryDSL): string {
  if (typeof q === "boolean") {
    return q ? "0:true" : "0:false";
  }
  const componentSortKey = _componentSortKey(q);
  if (componentSortKey !== undefined) {
    return `0:${componentSortKey.toString().padStart(12, "0")}`;
  }
  if (typeof q === "number") {
    return `0:${q.toString().padStart(12, "0")}`;
  }
  if (q instanceof Array) {
    return `1:${q.map(_termSortKey).join(",")}`;
  }
  if (q instanceof Entity) {
    return `0:${q.eid.toString().padStart(12, "0")}`;
  }
  if (typeof q === "function") {
    return "5";
  }
  if ("all" in q) {
    return `2:${q.all.map(_termSortKey).join(",")}`;
  }
  if ("any" in q) {
    return `3:${q.any.map(_termSortKey).join(",")}`;
  }
  if ("not" in q) {
    return `4:${_termSortKey(q.not)}`;
  }
  if ("target" in q) {
    const rel = q.target[0] instanceof Entity ? q.target[0].eid : q.target[0];
    return `4:target:${String(rel).padStart(12, "0")}:${_termSortKey(q.target[1])}`;
  }
  if ("source" in q) {
    const rel = q.source[0] instanceof Entity ? q.source[0].eid : q.source[0];
    return `4:source:${String(rel).padStart(12, "0")}:${_termSortKey(q.source[1])}`;
  }
  if ("parent" in q) {
    return `4:parent:${_termSortKey(q.parent)}`;
  }
  if ("children" in q) {
    return `4:children:${_termSortKey(q.children)}`;
  }
  if ("test" in q) {
    return `5:${q.watch instanceof Array ? q.watch.map(_termSortKey).join(",") : q.watch ? _termSortKey(q.watch) : ""}`;
  }
  return `4:${q.only instanceof Array ? q.only.map(_termSortKey).join(",") : _termSortKey(q.only)}`;
}

function _sortCommutativeTerms(terms: QueryDSL[]): QueryDSL[] {
  return [...terms].sort((a, b) => _termSortKey(a).localeCompare(_termSortKey(b)));
}

const _dslFunctionIds = new WeakMap<EntityTestFunc, number>();
let _nextDSLFunctionId = 1;

function _getDSLFunctionId(func: EntityTestFunc): number {
  let id = _dslFunctionIds.get(func);
  if (id === undefined) {
    id = _nextDSLFunctionId++;
    _dslFunctionIds.set(func, id);
  }
  return id;
}

function _canonicalDSLKey(q: QueryDSL): unknown {
  if (typeof q === "boolean") {
    return ["BOOL", q];
  }
  if (typeof q === "number") {
    return ["HAS", q];
  }
  if (q instanceof Entity) {
    return ["HAS", q.eid];
  }
  if (typeof q === "function") {
    return ["HAS", q];
  }
  if (q instanceof Array) {
    return ["ALL", q];
  }
  if ("only" in q) {
    return ["ONLY", q.only instanceof Array ? q.only : [q.only]];
  }
  if ("all" in q) {
    return ["ALL", q.all.map(_canonicalDSLKey)];
  }
  if ("any" in q) {
    return ["ANY", q.any.map(_canonicalDSLKey)];
  }
  if ("not" in q) {
    return ["NOT", _canonicalDSLKey(q.not)];
  }
  if ("target" in q) {
    return [
      "TARGET",
      q.target[0] instanceof Entity ? q.target[0].eid : q.target[0],
      _canonicalDSLKey(q.target[1]),
    ];
  }
  if ("source" in q) {
    return [
      "SOURCE",
      q.source[0] instanceof Entity ? q.source[0].eid : q.source[0],
      _canonicalDSLKey(q.source[1]),
    ];
  }
  if ("parent" in q) {
    return ["PARENT", _canonicalDSLKey(q.parent)];
  }
  if ("children" in q) {
    return ["CHILDREN", _canonicalDSLKey(q.children)];
  }
  if ("test" in q) {
    if (q.watch === undefined) {
      return ["FUNC", _getDSLFunctionId(q.test)];
    }
    return ["FUNC", _getDSLFunctionId(q.test), q.watch instanceof Array ? q.watch : [q.watch]];
  }
  throw new Error("Unrecognized query term");
}

function _fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Return the shortest equivalent form of a query DSL expression.
 *
 * @internal
 *
 * The simplifier resolves component classes to numeric type ids, flattens
 * associative operators, removes boolean identities, unwraps singleton
 * operators, sorts commutative expressions, and coalesces positive component
 * requirements into the DSL's array shorthand. Explicit `{ test }` predicates
 * are preserved as predicates.
 */
export function simplifyQueryDSL(q: QueryDSL, world: World): QueryDSL {
  if (typeof q === "boolean") {
    return q;
  }

  if (q instanceof Array) {
    return _asCanonicalComponentRequirement(q, world);
  }

  if (typeof q === "number") {
    return q;
  }

  if (q instanceof Entity) {
    return q.eid;
  }

  if (typeof q === "function") {
    return _resolveBareComponent(q as ComponentClass, world);
  }

  if ("only" in q) {
    const components = q.only;
    return {
      only:
        components instanceof Array
          ? _asShortestHasOnlyRequirement(
              _sortComponentRequirements(
                components.map((component) => _resolveComponentRequirement(component, world))
              )
            )
          : _resolveComponentRequirement(components, world),
    };
  }

  if ("all" in q) {
    const simplifiedTerms: QueryDSL[] = [];
    for (const term of q.all.map((term) => simplifyQueryDSL(term, world))) {
      if (term === false) {
        return false;
      }
      if (term === true) {
        continue;
      }
      if (typeof term === "object" && term !== null && !(term instanceof Array) && "all" in term) {
        simplifiedTerms.push(...term.all);
      } else {
        simplifiedTerms.push(term);
      }
    }

    const componentRequirements: ComponentRef[] = [];
    const otherTerms: QueryDSL[] = [];
    for (const term of simplifiedTerms) {
      const requirements = _componentRequirements(term);
      if (requirements) {
        componentRequirements.push(...requirements);
      } else {
        otherTerms.push(term);
      }
    }

    const terms =
      componentRequirements.length > 0
        ? [_asCanonicalComponentRequirement(componentRequirements, world), ...otherTerms]
        : otherTerms;

    if (terms.length === 0) {
      return true;
    }
    if (terms.length === 1) {
      return terms[0];
    }
    return { all: _sortCommutativeTerms(terms) };
  }

  if ("any" in q) {
    const terms: QueryDSL[] = [];
    for (const term of q.any.map((term) => simplifyQueryDSL(term, world))) {
      if (term === true) {
        return true;
      }
      if (term === false) {
        continue;
      }
      if (typeof term === "object" && term !== null && !(term instanceof Array) && "any" in term) {
        terms.push(...term.any);
      } else {
        terms.push(term);
      }
    }

    if (terms.length === 0) {
      return false;
    }
    if (terms.length === 1) {
      return terms[0];
    }
    return { any: _sortCommutativeTerms(terms) };
  }

  if ("not" in q) {
    const term = simplifyQueryDSL(q.not, world);
    if (typeof term === "boolean") {
      return !term;
    }
    if (typeof term === "object" && term !== null && !(term instanceof Array) && "not" in term) {
      return term.not;
    }
    return { not: term };
  }

  if ("target" in q) {
    const inner = simplifyQueryDSL(q.target[1], world);
    if (inner === false) {
      return false;
    }
    return { target: [_resolveRelationship(q.target[0], world), inner] };
  }

  if ("source" in q) {
    const inner = simplifyQueryDSL(q.source[1], world);
    if (inner === false) {
      return false;
    }
    return { source: [_resolveRelationship(q.source[0], world), inner] };
  }

  if ("parent" in q) {
    const inner = simplifyQueryDSL(q.parent, world);
    if (inner === false) {
      return false;
    }
    return { target: [_resolveChildOfRelationship(world), inner] };
  }

  if ("children" in q) {
    const inner = simplifyQueryDSL(q.children, world);
    if (inner === false) {
      return false;
    }
    return { source: [_resolveChildOfRelationship(world), inner] };
  }

  if ("test" in q) {
    if (q.watch === undefined) {
      return q;
    }
    const watch = q.watch instanceof Array ? q.watch : [q.watch];
    const resolvedWatch = [
      ...new Set(watch.map((component) => _resolveComponentRequirement(component, world))),
    ].sort((a, b) => a - b);
    return { test: q.test, watch: resolvedWatch };
  }

  return q;
}

export function containsDownTerm(q: QueryDSL): boolean {
  if (typeof q !== "object" || q === null || q instanceof Array || q instanceof Entity) {
    return false;
  }
  if ("source" in q || "children" in q) {
    return true;
  }
  if ("all" in q) {
    return q.all.some(containsDownTerm);
  }
  if ("any" in q) {
    return q.any.some(containsDownTerm);
  }
  if ("not" in q) {
    return containsDownTerm(q.not);
  }
  if ("target" in q) {
    return containsDownTerm(q.target[1]);
  }
  if ("parent" in q) {
    return containsDownTerm(q.parent);
  }
  return false;
}

/**
 * Return a deterministic FNV-1a hash for a query DSL expression.
 *
 * Equivalent expressions hash identically because the DSL is simplified before
 * hashing. Custom predicate functions are represented by process-local function
 * identity ids. Like any 32-bit hash, collisions are theoretically possible.
 */
export function getDSLKey(q: QueryDSL, world: World): number {
  return _fnv1a32(JSON.stringify(_canonicalDSLKey(simplifyQueryDSL(q, world))));
}

/** @internal Return the canonical cache key used by materialized terms. */
export function getDSLCacheKey(q: QueryDSL, world: World): string {
  return JSON.stringify(_canonicalDSLKey(simplifyQueryDSL(q, world)));
}

type _CompileContext = {
  masks: Bitset[];
  funcs: EntityTestFunc[];
};

function _compileMask(
  context: _CompileContext,
  components: number[],
  entityRef: string,
  comparison: "hasBitset" | "equal"
): string {
  const mask = _calculateComponentBitmask(components);
  if (comparison === "hasBitset") {
    // Inline the subset check against the mask's word values so the
    // generated predicate is straight-line bitwise code with no method
    // dispatch and no loop over zero words. The mask itself is not
    // closed over for this term.
    const inline = mask._compileSubsetCheck(`${entityRef}.componentBitmask._bits`);
    return inline === "true" ? "true" : `(${inline})`;
  }
  const maskIndex = context.masks.push(mask) - 1;
  return `${entityRef}.componentBitmask.${comparison}(m${maskIndex})`;
}

function _compileQueryExpression(
  world: World,
  q: QueryDSL,
  context: _CompileContext,
  entityRef: string
): string {
  if (typeof q === "boolean") {
    return q ? "true" : "false";
  }

  if (typeof q === "number") {
    return _compileMask(context, [q], entityRef, "hasBitset");
  }

  if (typeof q === "function") {
    return _compileMask(context, [world.entity(q as ComponentClass).eid], entityRef, "hasBitset");
  }

  if (q instanceof Array) {
    return _compileMask(
      context,
      q.map((component) => world.entity(component).eid),
      entityRef,
      "hasBitset"
    );
  }

  if ("only" in q) {
    const v = q.only;
    return _compileMask(
      context,
      v instanceof Array
        ? v.map((component) => world.entity(component).eid)
        : [world.entity(v).eid],
      entityRef,
      "equal"
    );
  }

  if ("all" in q) {
    if (q.all.length === 0) {
      return "true";
    }
    return q.all
      .map((sq) => `(${_compileQueryExpression(world, sq, context, entityRef)})`)
      .join("&&");
  }

  if ("any" in q) {
    if (q.any.length === 0) {
      return "false";
    }
    return q.any
      .map((sq) => `(${_compileQueryExpression(world, sq, context, entityRef)})`)
      .join("||");
  }

  if ("not" in q) {
    return `!(${_compileQueryExpression(world, q.not, context, entityRef)})`;
  }

  if ("target" in q) {
    const relEid = _resolveRelationship(q.target[0], world);
    const relMask = _compileMask(context, [relEid], entityRef, "hasBitset");
    const inner = _compileQueryExpression(world, q.target[1], context, "p");
    return `(${relMask})&&((p)=>p!==undefined&&(${inner}))(${entityRef}._get(${relEid})?.target)`;
  }

  if ("source" in q) {
    const relEid = _resolveRelationship(q.source[0], world);
    const inner = _compileQueryExpression(world, q.source[1], context, "p");
    return `((cs)=>{if(cs===undefined)return false;for(const p of cs){if(${inner})return true;}return false;})(${entityRef}._childrenByEid(${relEid}))`;
  }

  if ("test" in q) {
    const funcIndex = context.funcs.push(q.test) - 1;
    return `f${funcIndex}(${entityRef})`;
  }

  throw new Error("Unrecognized query term");
}

/**
 * Compile a {@link QueryDSL} expression into a runtime entity-test predicate.
 *
 * @internal Used by predicate-backed terms and the `Filter` fallback to
 * translate user-supplied DSL expressions into runtime tests.
 *
 * @param world - World used to resolve registered component classes to type ids.
 * @param q - Query expression.
 */
export function _compile(world: World, q: QueryDSL): EntityTestFunc {
  const context: _CompileContext = { masks: [], funcs: [] };
  const expression = _compileQueryExpression(world, simplifyQueryDSL(q, world), context, "e");
  const maskNames = context.masks.map((_mask, index) => `m${index}`);
  const funcNames = context.funcs.map((_func, index) => `f${index}`);
  const factory = new Function(
    ...maskNames,
    ...funcNames,
    `return function entityTest(e) { return ${expression}; };`
  );
  return factory(...context.masks, ...context.funcs) as EntityTestFunc;
}
