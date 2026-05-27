import { type ComponentType } from "./component.js";
import { Entity } from "./entity/index.js";
import type { World } from "./world/index.js";
import { _compile, type EntityTestFunc, type QueryDSL } from "./dsl.js";
import {
  _getInjected,
  _getInjectedWithSrc,
  _injectArity,
  _mapInjectedClassToTypes,
  Iterator,
  type InjectElement,
  type InjectTuple,
  type MaybeResolvedInjectTuple,
} from "./query.js";

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

  constructor(
    /** World this filter reads entities from. */
    public readonly world: World,
    dsl: QueryDSL
  ) {
    this._belongs = _compile(world, dsl);
  }

  /**
   * Walk all current world entities and call `callback` for each one that
   * satisfies the filter's DSL.
   *
   * @param callback - Receives only the matching entity.
   */
  public forEach(callback: (e: Entity) => void): void;

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
  public forEach<J extends InjectTuple>(
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;

  /**
   * As above, but pass `Entity` first to make the entity-first signature
   * explicit. Identical behavior to the no-marker form.
   */
  public forEach<J extends InjectTuple>(
    cursor: typeof Entity,
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;

  /**
   * As above, but pass `Iterator` first to receive a reused {@link Iterator}
   * cursor instead of the bare entity. The cursor exposes the visited entity
   * (`it.entity`) and, in `it.src`, the source entity each resolved component
   * was read from (the visited entity for direct components, the relationship
   * target for `up`-injected ones).
   */
  public forEach<J extends InjectTuple>(
    cursor: typeof Iterator,
    components: readonly [...J],
    callback: (it: Iterator, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;

  public forEach(arg0: unknown, arg1?: unknown, arg2?: unknown): void {
    // Bare `forEach(callback)`: a function that is not the Entity/Iterator marker.
    if (typeof arg0 === "function" && arg0 !== Entity && arg0 !== Iterator) {
      const callback = arg0 as (e: Entity) => void;
      this.world.defer(() => {
        this.world.entities.forEach((e) => {
          if (this._belongs(e)) {
            callback(e);
          }
        });
      });
      return;
    }
    const useIterator = arg0 === Iterator;
    const components = (
      arg0 === Entity || arg0 === Iterator ? arg1 : arg0
    ) as readonly InjectElement[];
    const callback = (arg0 === Entity || arg0 === Iterator ? arg2 : arg1) as (
      eOrIt: unknown,
      resolved: unknown
    ) => void;
    this.world.defer(() => {
      const inject = _mapInjectedClassToTypes(this.world, components);
      const arity = _injectArity(inject);
      // One tuple (and one cursor) reused across the whole pass; the callback
      // consumes them synchronously and must not retain them. A nested forEach
      // gets its own locals, so reuse here is reentrancy-safe.
      const resolved = new Array(arity);
      const it = useIterator ? new Iterator(arity) : undefined;
      this.world.entities.forEach((e) => {
        if (!this._belongs(e)) {
          return;
        }
        if (it) {
          it.entity = e;
          _getInjectedWithSrc(e, inject, resolved, it.src);
          callback(it, resolved);
        } else {
          _getInjected(e, inject, false, resolved);
          callback(e, resolved);
        }
      });
    });
  }
}
