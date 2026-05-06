import { Component } from "./component.js";
import type { Entity } from "./entity.js";
import type { World } from "./world.js";
import { _buildEntityTest, type EntityTestFunc, type MaybeRequired, type QueryDSL } from "./dsl.js";

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
export class Filter<R extends (typeof Component)[] = []> {
  private readonly _belongs: EntityTestFunc;

  constructor(
    /** World this filter reads entities from. */
    public readonly world: World,
    dsl: QueryDSL
  ) {
    this._belongs = _buildEntityTest(world, dsl);
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
   * @param components - Component classes to resolve from each matching entity.
   * @param callback - Receives the entity and a tuple of resolved component
   *   instances.
   */
  public forEach<J extends (typeof Component)[]>(
    components: readonly [...J],
    callback: (e: Entity, resolved: { [K in keyof J]: MaybeRequired<J[K], R> }) => void
  ): void;

  public forEach<J extends (typeof Component)[]>(
    componentsOrCallback: readonly [...J] | ((e: Entity) => void),
    callback?: (e: Entity, resolved: { [K in keyof J]: MaybeRequired<J[K], R> }) => void
  ): void {
    this.world.defer(() => {
      if (typeof componentsOrCallback === "function") {
        this.world.entities.forEach((e) => {
          if (this._belongs(e)) {
            componentsOrCallback(e);
          }
        });
      } else {
        const types = componentsOrCallback.map((C) => this.world.getComponentType(C));
        this.world.entities.forEach((e) => {
          if (!this._belongs(e)) {
            return;
          }
          const resolved = types.map((t) => e.get(t));
          callback!(e, resolved as any);
        });
      }
    });
  }
}
