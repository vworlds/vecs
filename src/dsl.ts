import {
  Component,
  ComponentClassArray,
  ComponentClassOrType,
  calculateComponentBitmask,
} from "./component.js";
import type { Entity } from "./entity.js";
import type { World } from "./world.js";

/** A function that tests whether a given entity belongs to a query. */
export type EntityTestFunc = (e: Entity) => boolean;

/**
 * A composable query expression used to declare which entities a
 * {@link Query} or {@link System} should track.
 *
 * Queries can be nested arbitrarily:
 *
 * ```ts
 * // Entities that have Position AND (Sprite OR Container):
 * world.system("render").query({
 *   AND: [Position, { OR: [Sprite, Container] }]
 * });
 *
 * // Entities that have a parent with Player AND Container:
 * world.system("attach").query({
 *   PARENT: { AND: [Player, Container] }
 * });
 * ```
 *
 * Short forms:
 * - A single class or type id is equivalent to `{ HAS: [C] }`.
 * - An array `[A, B]` is equivalent to `{ HAS: [A, B] }`.
 * - Pass an {@link EntityTestFunc} directly for fully custom membership logic.
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

export function HAS(world: World, ...components: ComponentClassArray): EntityTestFunc {
  const testBitmask = calculateComponentBitmask(components, world);
  return (e: Entity) => e.componentBitmask.hasBitset(testBitmask);
}

function HAS_ONLY(world: World, ...components: ComponentClassArray): EntityTestFunc {
  const testBitmask = calculateComponentBitmask(components, world);
  return (e: Entity) => e.componentBitmask.equal(testBitmask);
}

function NOT(func: EntityTestFunc): EntityTestFunc {
  return (e: Entity) => !func(e);
}

function AND(...funcs: EntityTestFunc[]): EntityTestFunc {
  return (e: Entity) => funcs.every((f) => f(e));
}

function OR(...funcs: EntityTestFunc[]): EntityTestFunc {
  return (e: Entity) => funcs.some((f) => f(e));
}

function PARENT(func: EntityTestFunc) {
  return (e: Entity) => (e.parent && func(e.parent)) || false;
}

/**
 * Resolves component nullability based on what was declared in `requires` (or
 * the `_guaranteed` hint). Components in `R` are non-nullable; others are
 * `InstanceType<C> | undefined`.
 */
export type MaybeRequired<C, R extends (typeof Component)[]> = C extends typeof Component
  ? C extends R[number]
    ? InstanceType<C>
    : InstanceType<C> | undefined
  : never;

/**
 * Statically extracts the component classes that are **guaranteed present** on
 * every entity matched by a {@link QueryDSL} expression.
 *
 * Rules:
 * - Plain class `C` → `[C]`
 * - Plain array `[A, B]` → `[A, B]`
 * - `{HAS: ...}` / `{HAS_ONLY: ...}` → recurse into the payload
 * - `{AND: [q1, q2, ...]}` → concatenation of each branch's extraction
 * - `{OR: ...}` / `{NOT: ...}` / `{PARENT: ...}` → `[]` (no guarantee)
 * - `EntityTestFunc` / numeric type id → `[]` (opaque)
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
          ? ExtractAndChain<A>
          : [];

type ExtractAndChain<A extends readonly QueryDSL[]> = A extends readonly [
  infer First,
  ...infer Rest extends readonly QueryDSL[],
]
  ? [...ExtractRequired<First>, ...ExtractAndChain<Rest>]
  : [];

/** Convert a {@link QueryDSL} expression into a runtime entity-test predicate. */
export function buildEntityTest(world: World, q: QueryDSL): EntityTestFunc {
  if (typeof q === "number" || (typeof q === "function" && q.prototype instanceof Component)) {
    return HAS(world, q as typeof Component);
  } else if (typeof q === "function") {
    return q as EntityTestFunc;
  }

  if (q instanceof Array) {
    return HAS(world, ...q);
  }

  if ("HAS" in q) {
    return buildEntityTest(world, q.HAS);
  }

  if ("HAS_ONLY" in q) {
    const v = q.HAS_ONLY;
    if (v instanceof Array) {
      return HAS_ONLY(world, ...v);
    }
    return HAS_ONLY(world, v);
  }

  if ("AND" in q) {
    return AND(...q.AND.map((sq) => buildEntityTest(world, sq)));
  }

  if ("OR" in q) {
    return OR(...q.OR.map((sq) => buildEntityTest(world, sq)));
  }

  if ("NOT" in q) {
    return NOT(buildEntityTest(world, q.NOT));
  }

  if ("PARENT" in q) {
    return PARENT(buildEntityTest(world, q.PARENT));
  }

  throw "Unrecognized query term";
}
