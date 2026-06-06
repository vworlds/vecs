import type { QueryDSL } from "../dsl.js";
import type { World } from "../world/index.js";
import { Term } from "./term.js";
import { PredicateTerm, type MergedInfo } from "./predicate_term.js";
import type { getTerm as GetTermFn } from "./build.js";

/** Diamond analysis callback injected into composite builds to avoid circular imports. */
export type CompositePrecheck = (terms: readonly QueryDSL[]) => {
  hasDiamond: boolean;
  containsTarget: boolean;
  info: MergedInfo;
};

/** Constructor shape shared by {@link AllTerm} and {@link AnyTerm}. */
export type CompositeTermCtor = new (
  world: World,
  key: string,
  children: readonly Term[],
  onDestroy: (term: Term) => void
) => Term;

/**
 * Shared build logic for the `all` / `any` composite terms.
 *
 * Runs the diamond pre-check and either short-circuits to a merged
 * `PredicateTerm` (when a leaf diamond is detected and no target term is
 * involved) or constructs the requested composite node from its child terms.
 * `AllTerm` and `AnyTerm` differ only in which constructor they pass.
 *
 * @param Ctor - The composite term constructor (`AllTerm` or `AnyTerm`).
 * @param world - Owning world.
 * @param terms - Direct child DSL nodes.
 * @param key - Canonical cache key.
 * @param originalDSL - The full DSL node (used when collapsing to a merged term).
 * @param getTerm - Term canonicalizer / cache accessor.
 * @param precheck - Diamond analysis callback.
 * @param onDestroy - Called when the last consumer unsubscribes.
 * @returns The composite term or, on diamond, a merged `PredicateTerm`.
 */
export function buildCompositeTerm(
  Ctor: CompositeTermCtor,
  world: World,
  terms: readonly QueryDSL[],
  key: string,
  originalDSL: QueryDSL,
  getTerm: typeof GetTermFn,
  precheck: CompositePrecheck,
  onDestroy: (term: Term) => void
): Term {
  const checked = precheck(terms);
  if (checked.hasDiamond && !checked.containsTarget) {
    return PredicateTerm.buildMerged(world, originalDSL, key, checked.info, getTerm, onDestroy);
  }
  const children = terms.map((dsl) => getTerm(world, dsl));
  return new Ctor(world, key, children, onDestroy);
}
