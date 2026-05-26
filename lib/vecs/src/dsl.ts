import {
  type ComponentClass,
  type ComponentRef,
  type ComponentRefArray,
  type ComponentType,
} from "./component.js";
import { Entity } from "./entity/index.js";
import type { World } from "./world/index.js";
import { Bitset } from "./util/bitset.js";

/**
 * A predicate that decides whether a given entity belongs to a query.
 *
 * Pass one directly inside {@link QueryDSL} to express membership rules that
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
 * // Position AND (Sprite OR Container):
 * world.system("render").query({
 *   AND: [Position, { OR: [Sprite, Container] }],
 * });
 *
 * // Parent has Player AND Container:
 * world.system("attach").query({
 *   PARENT: { AND: [Player, Container] },
 * });
 * ```
 *
 * Short forms recognized by `query` / `filter`:
 * - `true` matches all entities; `false` matches no entities.
 * - A registered component class or numeric type id is shorthand for `{ HAS: [C] }`.
 * - An array `[A, B]` is shorthand for `{ HAS: [A, B] }`.
 * - An empty array `[]` is shorthand for `true`.
 * - An {@link EntityTestFunc} is invoked directly for fully custom logic.
 *
 * Function values are treated as component classes only when the world already
 * has registered metadata for that class. Register component classes before
 * using them in query DSL expressions.
 */
export type QueryDSL =
  | true
  | false
  | ComponentRefArray
  | ComponentRef
  | EntityTestFunc
  | { HAS: ComponentRefArray | ComponentRef }
  | { HAS_ONLY: ComponentRefArray | ComponentRef }
  | { AND: readonly QueryDSL[] }
  | { OR: readonly QueryDSL[] }
  | { NOT: QueryDSL }
  | { PARENT: QueryDSL }
  | { REL: readonly [ComponentRef, Entity] };

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
 * - `{ HAS: ... }` / `{ HAS_ONLY: ... }` → recurse into the payload
 * - `{ AND: [q1, q2, ...] }` → concatenate each branch's extraction
 * - `{ OR: ... }` / `{ NOT: ... }` / `{ PARENT: ... }` → `[]` (no guarantee)
 * - `EntityTestFunc` / numeric type id → `[]` (opaque)
 *
 * @typeParam Q - Query expression to analyse.
 */
export type ExtractRequired<Q> = Q extends ComponentType
  ? [Q]
  : Q extends readonly ComponentType[]
    ? Q
    : Q extends { HAS: infer H }
      ? ExtractRequired<H>
      : Q extends { HAS_ONLY: infer H }
        ? ExtractRequired<H>
        : Q extends { REL: readonly [infer C, Entity] }
          ? C extends ComponentType
            ? [C]
            : []
          : Q extends { AND: infer A extends readonly QueryDSL[] }
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

function _componentRequirements(q: QueryDSL): ComponentRefArray | undefined {
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

function _asShortestComponentRequirement(components: ComponentRefArray): QueryDSL {
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

function _resolveRelationshipRequirement(component: ComponentRef, world: World): number {
  const componentEntity = world.entity(component);
  if (!componentEntity.ownMeta.isRelationship) {
    throw new Error(`Component ${componentEntity.eid} is not a Relationship`);
  }
  return componentEntity.eid;
}

function _resolveBareComponent(component: ComponentRef, world: World): QueryDSL {
  if (typeof component === "number") {
    return component;
  }
  if (component instanceof Entity) {
    return component.eid;
  }

  return world.getEntity(component as ComponentClass)?.eid ?? component;
}

function _sortComponentRequirements(components: ComponentRefArray): ComponentRefArray {
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
  components: ComponentRefArray
): ComponentRefArray | ComponentRef {
  return components.length === 1 ? components[0] : components;
}

function _asCanonicalComponentRequirement(components: ComponentRefArray, world: World): QueryDSL {
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
  if ("AND" in q) {
    return `2:${q.AND.map(_termSortKey).join(",")}`;
  }
  if ("OR" in q) {
    return `3:${q.OR.map(_termSortKey).join(",")}`;
  }
  if ("NOT" in q) {
    return `4:${_termSortKey(q.NOT)}`;
  }
  if ("PARENT" in q) {
    return `4:${_termSortKey(q.PARENT)}`;
  }
  if ("REL" in q) {
    const [component, target] = q.REL;
    return `4:${_termSortKey(component)}:${target.eid}`;
  }
  if ("HAS" in q) {
    return _termSortKey(q.HAS);
  }
  return `4:${q.HAS_ONLY instanceof Array ? q.HAS_ONLY.map(_termSortKey).join(",") : _termSortKey(q.HAS_ONLY)}`;
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
    return ["FUNC", _getDSLFunctionId(q as EntityTestFunc)];
  }
  if (q instanceof Array) {
    return ["ALL", q];
  }
  if ("HAS" in q) {
    return _canonicalDSLKey(q.HAS);
  }
  if ("HAS_ONLY" in q) {
    return ["ONLY", q.HAS_ONLY instanceof Array ? q.HAS_ONLY : [q.HAS_ONLY]];
  }
  if ("AND" in q) {
    return ["AND", q.AND.map(_canonicalDSLKey)];
  }
  if ("OR" in q) {
    return ["OR", q.OR.map(_canonicalDSLKey)];
  }
  if ("NOT" in q) {
    return ["NOT", _canonicalDSLKey(q.NOT)];
  }
  if ("REL" in q) {
    const [component, target] = q.REL;
    return ["REL", component instanceof Entity ? component.eid : component, target.eid];
  }
  return ["PARENT", _canonicalDSLKey(q.PARENT)];
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
 * requirements into the DSL's array shorthand. Bare non-class functions are
 * preserved as predicates.
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

  if ("HAS" in q) {
    return simplifyQueryDSL(q.HAS, world);
  }

  if ("HAS_ONLY" in q) {
    const components = q.HAS_ONLY;
    return {
      HAS_ONLY:
        components instanceof Array
          ? _asShortestHasOnlyRequirement(
              _sortComponentRequirements(
                components.map((component) => _resolveComponentRequirement(component, world))
              )
            )
          : _resolveComponentRequirement(components, world),
    };
  }

  if ("AND" in q) {
    const simplifiedTerms: QueryDSL[] = [];
    for (const term of q.AND.map((term) => simplifyQueryDSL(term, world))) {
      if (term === false) {
        return false;
      }
      if (term === true) {
        continue;
      }
      if (typeof term === "object" && term !== null && !(term instanceof Array) && "AND" in term) {
        simplifiedTerms.push(...term.AND);
      } else {
        simplifiedTerms.push(term);
      }
    }

    const componentRequirements: ComponentRefArray = [];
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
    return { AND: _sortCommutativeTerms(terms) };
  }

  if ("OR" in q) {
    const terms: QueryDSL[] = [];
    for (const term of q.OR.map((term) => simplifyQueryDSL(term, world))) {
      if (term === true) {
        return true;
      }
      if (term === false) {
        continue;
      }
      if (typeof term === "object" && term !== null && !(term instanceof Array) && "OR" in term) {
        terms.push(...term.OR);
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
    return { OR: _sortCommutativeTerms(terms) };
  }

  if ("NOT" in q) {
    const term = simplifyQueryDSL(q.NOT, world);
    if (typeof term === "boolean") {
      return !term;
    }
    if (typeof term === "object" && term !== null && !(term instanceof Array) && "NOT" in term) {
      return term.NOT;
    }
    return { NOT: term };
  }

  if ("PARENT" in q) {
    const term = simplifyQueryDSL(q.PARENT, world);
    if (term === false) {
      return false;
    }
    return { PARENT: term };
  }

  if ("REL" in q) {
    return { REL: [_resolveRelationshipRequirement(q.REL[0], world), world.entity(q.REL[1])] };
  }

  return q;
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
    const componentEntity = world.getEntity(q as ComponentClass);
    if (componentEntity) {
      return _compileMask(context, [componentEntity.eid], entityRef, "hasBitset");
    }
    const funcIndex = context.funcs.push(q as EntityTestFunc) - 1;
    return `f${funcIndex}(${entityRef})`;
  }

  if (q instanceof Array) {
    return _compileMask(
      context,
      q.map((component) => world.entity(component).eid),
      entityRef,
      "hasBitset"
    );
  }

  if ("HAS" in q) {
    return _compileQueryExpression(world, q.HAS, context, entityRef);
  }

  if ("HAS_ONLY" in q) {
    const v = q.HAS_ONLY;
    return _compileMask(
      context,
      v instanceof Array
        ? v.map((component) => world.entity(component).eid)
        : [world.entity(v).eid],
      entityRef,
      "equal"
    );
  }

  if ("AND" in q) {
    if (q.AND.length === 0) {
      return "true";
    }
    return q.AND.map((sq) => `(${_compileQueryExpression(world, sq, context, entityRef)})`).join(
      "&&"
    );
  }

  if ("OR" in q) {
    if (q.OR.length === 0) {
      return "false";
    }
    return q.OR.map((sq) => `(${_compileQueryExpression(world, sq, context, entityRef)})`).join(
      "||"
    );
  }

  if ("NOT" in q) {
    return `!(${_compileQueryExpression(world, q.NOT, context, entityRef)})`;
  }

  if ("PARENT" in q) {
    return `(${entityRef}.parent ? (${_compileQueryExpression(world, q.PARENT, context, `${entityRef}.parent`)}) : false)`;
  }

  if ("REL" in q) {
    const relationshipEid = _resolveRelationshipRequirement(q.REL[0], world);
    const target = world.entity(q.REL[1]);
    const relationshipMask = _compileMask(context, [relationshipEid], entityRef, "hasBitset");
    const funcIndex =
      context.funcs.push((e: Entity) => {
        const relationship = e._get(relationshipEid) as { target?: Entity } | undefined;
        return !target._destroyed && relationship?.target === target;
      }) - 1;
    return `(${relationshipMask})&&(f${funcIndex}(${entityRef}))`;
  }

  throw "Unrecognized query term";
}

/**
 * Compile a {@link QueryDSL} expression into a runtime entity-test predicate.
 *
 * @internal Used by `Query`, `System`, and `Filter` to translate user-supplied
 * DSL expressions into the predicate stored on `Query._belongs`.
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

/**
 * Return the component type ids that can affect a query's membership, or
 * `undefined` when the expression is too broad to index safely.
 *
 * @internal Used by the world query index to route archetype changes only to
 * queries that may be invalidated by the changed component. Keep this
 * conservative: unsupported expressions fall back to full-scan routing.
 */
export function _extractQueryDependencies(world: World, q: QueryDSL): number[] | undefined {
  q = simplifyQueryDSL(q, world);

  if (typeof q === "boolean") {
    return [];
  }

  if (typeof q === "number") {
    return [q];
  }

  if (typeof q === "function") {
    const componentEntity = world.getEntity(q as ComponentClass);
    return componentEntity ? [componentEntity.eid] : undefined;
  }

  if (q instanceof Array) {
    return q.map((component) => world.entity(component).eid);
  }

  if ("HAS" in q) {
    return _extractQueryDependencies(world, q.HAS);
  }

  if ("REL" in q) {
    return [_resolveRelationshipRequirement(q.REL[0], world)];
  }

  if ("AND" in q) {
    const dependencies: number[] = [];
    for (const sq of q.AND) {
      const childDependencies = _extractQueryDependencies(world, sq);
      if (childDependencies === undefined) {
        return undefined;
      }
      dependencies.push(...childDependencies);
    }
    return dependencies;
  }

  return undefined;
}
