import { Component } from "./component.js";
import type { Entity } from "./entity.js";
import type { World } from "./world.js";
import { buildEntityTest, type EntityTestFunc, type MaybeRequired, type QueryDSL } from "./dsl.js";

/**
 * A non-reactive, one-shot entity filter.
 *
 * Unlike {@link Query}, a `Filter` holds no tracked entity set and registers
 * nothing with the world. Every {@link forEach} call walks all world entities
 * and invokes the callback for those that match the predicate captured at
 * construction time.
 *
 * Create via {@link World.filter}:
 *
 * ```ts
 * const f = world.filter([Position, Velocity]);
 *
 * // Entity only:
 * f.forEach((e) => console.log(e.eid));
 *
 * // With component injection:
 * f.forEach([Position, Velocity], (e, [pos, vel]) => {
 *   pos.x += vel.vx;
 * });
 * ```
 *
 * ### Type parameter `R`
 * Tracks which component classes are guaranteed present on every matched
 * entity — inferred automatically from the DSL by {@link World.filter}, or
 * supplied manually via the optional `_guaranteed` argument. Components in `R`
 * appear as non-nullable in `forEach` callback tuples.
 */
export class Filter<R extends (typeof Component)[] = []> {
  private readonly belongs: EntityTestFunc;

  constructor(
    private readonly world: World,
    dsl: QueryDSL
  ) {
    this.belongs = buildEntityTest(world, dsl);
  }

  /**
   * Iterate all world entities and call `callback` for each one that matches
   * the DSL this filter was created with.
   *
   * @param callback - Receives only the entity.
   */
  public forEach(callback: (e: Entity) => void): void;

  /**
   * Iterate all world entities and call `callback` for each one that matches
   * the DSL, with component injection.
   *
   * Components declared via {@link World.filter}'s DSL (or `_guaranteed`) are
   * non-nullable in the resolved tuple; any other requested component may be
   * `undefined` if the entity lacks it.
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
    this.world.beginDeferred();
    try {
      if (typeof componentsOrCallback === "function") {
        this.world._forEachEntity((e) => {
          if (this.belongs(e)) {
            componentsOrCallback(e);
          }
        });
      } else {
        const types = componentsOrCallback.map((C) => this.world.getComponentType(C));
        this.world._forEachEntity((e) => {
          if (!this.belongs(e)) {
            return;
          }
          const resolved = types.map((t) => e.get(t));
          callback!(e, resolved as any);
        });
      }
    } finally {
      this.world.endDeferred();
    }
  }
}
