import { type ComponentType } from "./component.js";
import { Entity } from "./entity/index.js";
import type { World } from "./world/index.js";
import { _compile, getDSLCacheKey, type EntityTestFunc, type QueryDSL } from "./dsl.js";
import type { Term } from "./terms/term.js";
import {
  Iter,
  makeInjectedInvoker,
  normalizeFanInjectCallbackArgs,
  type FanInjectCallbackArg,
  type FanInjectTuple,
  type InjectedCallback,
  type MaybeResolvedInjectTuple,
} from "./inject.js";
import type {
  EntityCursorOption,
  FanInjectCallbackOptions,
  IterCursorOption,
} from "./query/options.js";

/**
 * A non-reactive, one-shot entity filter.
 *
 * Unlike {@link Query} a `Filter` keeps no tracked entity set and registers
 * nothing on the world. Each call to {@link forEach} walks all current world
 * entities and invokes the callback on those that match the predicate captured
 * at construction time.
 *
 * Create one through {@link World.filter}:
 *
 * ```ts
 * const f = world.filter([Position, Velocity]);
 *
 * // Iterate matching entities:
 * f.forEach((e) => console.log(e.eid));
 *
 * // ...or with component injection:
 * f.forEach([Position, Velocity], (e, [pos, vel]) => {
 *   pos.x += vel.vx;
 * });
 * ```
 *
 * `forEach` runs the callback inside a {@link World.defer | deferred scope}, so
 * mutations made by the callback are batched and become visible after iteration
 * finishes. Nesting a `forEach` inside an already-deferred block (a system, a
 * `Query.forEach`, an outer `defer`) inherits the outer scope and does not
 * drain on exit.
 *
 * @typeParam R - Component classes guaranteed present on every matched entity.
 *   Inferred from the DSL by {@link World.filter} when possible, or supplied
 *   manually via the `_guaranteed` argument. Components in `R` are non-nullable
 *   in `forEach` callback tuples.
 */
export class Filter<R extends ComponentType[] = []> {
  private readonly _belongs: EntityTestFunc;
  private readonly _dsl: QueryDSL;
  private readonly _termKey: string;

  constructor(
    /** World this filter reads entities from. */
    public readonly world: World,
    dsl: QueryDSL
  ) {
    this._dsl = dsl;
    this._belongs = _compile(world, dsl);
    this._termKey = getDSLCacheKey(dsl, world);
  }

  public get rootTerm(): Term | undefined {
    return this.world._getCachedTermByKey(this._termKey);
  }

  /**
   * Walk all current world entities and call `callback` for each one that
   * satisfies the filter's DSL.
   *
   * @param callback - Receives only the matching entity.
   */
  public forEach(callback: (e: Entity) => void): this;

  /**
   * Walk all current world entities, call `callback` for each one that
   * satisfies the filter's DSL, and inject the requested component instances.
   *
   * Components covered by the filter's DSL or `_guaranteed` hint are
   * non-nullable in the resolved tuple; any other component class may be
   * `undefined` if the entity does not have it.
   *
   * The resolved tuple is reused for every matching entity. Read or
   * destructure it inside the callback; do not retain the tuple array.
   *
   * @param components - Component classes to resolve from each matching entity.
   * @param callback - Receives the entity and a tuple of resolved component
   *   instances.
   */
  public forEach<J extends FanInjectTuple>(
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;

  /**
   * As above, but pass `{ cursor: Entity, inject: [...] }` to make the
   * entity-first signature explicit. Identical behavior to the array form.
   */
  public forEach<J extends FanInjectTuple>(
    options: EntityCursorOption & FanInjectCallbackOptions<J>,
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;

  /**
   * As above, but pass `{ cursor: Iter, inject: [...] }` to receive a reused
   * {@link Iter} cursor instead of the bare entity. The cursor exposes the
   * visited entity (`it.entity`) and, in `it.src`, the source entity each
   * resolved component was read from (the visited entity for direct components,
   * the relationship's target entity for ones injected via `target`).
   */
  public forEach<J extends FanInjectTuple>(
    options: IterCursorOption & FanInjectCallbackOptions<J>,
    callback: (it: Iter, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;

  public forEach(arg0: ((e: Entity) => void) | FanInjectCallbackArg, arg1?: Function): this {
    // Bare `forEach(callback)`.
    if (typeof arg0 === "function") {
      const callback = arg0 as (e: Entity) => void;
      this.world.defer(() => {
        this._forEachMatch(callback);
      });
      return this;
    }
    const { components, useIter } = normalizeFanInjectCallbackArgs(arg0);
    const callback = arg1 as InjectedCallback;
    this.world.defer(() => {
      const invoke = makeInjectedInvoker(this.world, components, useIter, callback);
      this._forEachMatch(invoke);
    });
    return this;
  }

  private _forEachMatch(callback: (e: Entity) => void): void {
    const rootTerm = this.rootTerm;
    if (rootTerm) {
      for (const entity of rootTerm) {
        callback(entity);
      }
      return;
    }
    this.world.entities.forEach((e) => {
      if (this._belongs(e)) {
        callback(e);
      }
    });
  }
}
