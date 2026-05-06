import {
  Component,
  ComponentClassArray,
  ComponentClassOrType,
  _calculateComponentBitmask,
} from "./component.js";
import type { Entity } from "./entity.js";
import type { World } from "./world.js";

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
 * - A single class or numeric type id is shorthand for `{ HAS: [C] }`.
 * - An array `[A, B]` is shorthand for `{ HAS: [A, B] }`.
 * - An {@link EntityTestFunc} is invoked directly for fully custom logic.
 */
export type QueryDSL =
  | ComponentClassArray
  | ComponentClassOrType
  | EntityTestFunc
  | { HAS: ComponentClassArray | ComponentClassOrType }
  | { HAS_ONLY: ComponentClassArray | ComponentClassOrType }
  | { AND: readonly QueryDSL[] }
  | { OR: readonly QueryDSL[] }
  | { NOT: QueryDSL }
  | { PARENT: QueryDSL };

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
export type MaybeRequired<C, R extends (typeof Component)[]> = C extends typeof Component
  ? C extends R[number]
    ? InstanceType<C>
    : InstanceType<C> | undefined
  : never;

/**
 * Statically extract the component classes that are **guaranteed present** on
 * every entity matched by a {@link QueryDSL} expression.
 *
 * Rules:
 * - Plain class `C` → `[C]`
 * - Plain array `[A, B]` → `[A, B]`
 * - `{ HAS: ... }` / `{ HAS_ONLY: ... }` → recurse into the payload
 * - `{ AND: [q1, q2, ...] }` → concatenate each branch's extraction
 * - `{ OR: ... }` / `{ NOT: ... }` / `{ PARENT: ... }` → `[]` (no guarantee)
 * - `EntityTestFunc` / numeric type id → `[]` (opaque)
 *
 * @typeParam Q - Query expression to analyse.
 */
export type ExtractRequired<Q> = Q extends typeof Component
  ? [Q]
  : Q extends readonly (typeof Component)[]
    ? Q
    : Q extends { HAS: infer H }
      ? ExtractRequired<H>
      : Q extends { HAS_ONLY: infer H }
        ? ExtractRequired<H>
        : Q extends { AND: infer A extends readonly QueryDSL[] }
          ? _ExtractAndChain<A>
          : [];

type _ExtractAndChain<A extends readonly QueryDSL[]> = A extends readonly [
  infer First,
  ...infer Rest extends readonly QueryDSL[],
]
  ? [...ExtractRequired<First>, ..._ExtractAndChain<Rest>]
  : [];

/**
 * Build a predicate that returns `true` when an entity has every component
 * type in `components` set on its archetype.
 *
 * @internal Factory used by {@link _buildEntityTest} and by `Query.update`'s
 * watchlist auto-expansion.
 *
 * @param world - World used to resolve component classes to type ids.
 * @param components - Component classes or numeric type ids to require.
 */
export function _HAS(world: World, ...components: ComponentClassArray): EntityTestFunc {
  const testBitmask = _calculateComponentBitmask(components, world);
  return (e: Entity) => e.componentBitmask.hasBitset(testBitmask);
}

/**
 * Build a predicate that returns `true` only when an entity's archetype is
 * exactly the set in `components` (no other components attached).
 */
function _HAS_ONLY(world: World, ...components: ComponentClassArray): EntityTestFunc {
  const testBitmask = _calculateComponentBitmask(components, world);
  return (e: Entity) => e.componentBitmask.equal(testBitmask);
}

/** Negate a predicate. */
function _NOT(func: EntityTestFunc): EntityTestFunc {
  return (e: Entity) => !func(e);
}

/** Conjunction of multiple predicates. */
function _AND(...funcs: EntityTestFunc[]): EntityTestFunc {
  return (e: Entity) => funcs.every((f) => f(e));
}

/** Disjunction of multiple predicates. */
function _OR(...funcs: EntityTestFunc[]): EntityTestFunc {
  return (e: Entity) => funcs.some((f) => f(e));
}

/** Lift a predicate to apply to the entity's parent (false when no parent). */
function _PARENT(func: EntityTestFunc): EntityTestFunc {
  return (e: Entity) => (e.parent && func(e.parent)) || false;
}

/**
 * Compile a {@link QueryDSL} expression into a runtime entity-test predicate.
 *
 * @internal Used by `Query`, `System`, and `Filter` to translate user-supplied
 * DSL expressions into the predicate stored on `Query._belongs`.
 *
 * @param world - World used to resolve component classes to type ids.
 * @param q - Query expression.
 */
export function _buildEntityTest(world: World, q: QueryDSL): EntityTestFunc {
  if (typeof q === "number" || (typeof q === "function" && q.prototype instanceof Component)) {
    return _HAS(world, q as typeof Component);
  } else if (typeof q === "function") {
    return q as EntityTestFunc;
  }

  if (q instanceof Array) {
    return _HAS(world, ...q);
  }

  if ("HAS" in q) {
    return _buildEntityTest(world, q.HAS);
  }

  if ("HAS_ONLY" in q) {
    const v = q.HAS_ONLY;
    if (v instanceof Array) {
      return _HAS_ONLY(world, ...v);
    }
    return _HAS_ONLY(world, v);
  }

  if ("AND" in q) {
    return _AND(...q.AND.map((sq) => _buildEntityTest(world, sq)));
  }

  if ("OR" in q) {
    return _OR(...q.OR.map((sq) => _buildEntityTest(world, sq)));
  }

  if ("NOT" in q) {
    return _NOT(_buildEntityTest(world, q.NOT));
  }

  if ("PARENT" in q) {
    return _PARENT(_buildEntityTest(world, q.PARENT));
  }

  throw "Unrecognized query term";
}
