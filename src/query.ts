import { OrderedSet } from "./util/ordered_set.js";
import { Component } from "./component.js";
import type { Entity } from "./entity.js";
import { type World } from "./world.js";
import {
  buildEntityTest,
  type EntityTestFunc,
  type QueryDSL,
  type MaybeRequired,
} from "./dsl.js";

export type { EntityTestFunc, QueryDSL, MaybeRequired };

type EntityCallback = (e: Entity) => void;

type ComponentOrParent = typeof Component | { parent: typeof Component };
type ComponentOrParentType = number | { parent: number };

type ComponentInstance<T> = T extends { parent: typeof Component }
  ? InstanceType<T["parent"]>
  : T extends typeof Component
  ? InstanceType<T>
  : never;

const EMPTY_ENTITIES: ReadonlySet<Entity> = new Set();

/**
 * A reactive, always-updated list of entities that match a given query
 * expression.
 *
 * `Query` tracks every entity whose component set satisfies the predicate set
 * via {@link requires} or {@link query}. Entry and exit callbacks fire
 * automatically as entities gain or lose matching components. The tracked set
 * is exposed via {@link entities} and {@link forEach}.
 *
 * {@link System} extends `Query` and adds per-tick runtime concerns
 * (`update`, `each`, `run`). Use `Query` directly when you only need the
 * reactive entity set without pipeline integration.
 *
 * ### Type parameter `R`
 * Tracks which component classes are "required" (declared via {@link requires}
 * or the `_guaranteed` hint of {@link query}). Those components appear as
 * non-nullable in {@link sort} callbacks.
 */
export class Query<R extends (typeof Component)[] = []> {
  protected _entities: Set<Entity> | undefined;
  protected _enterCallback: EntityCallback[] = [];
  protected _exitCallback: EntityCallback[] = [];
  protected _belongs: EntityTestFunc = (_e: Entity) => false;
  protected hasQuery = false;

  constructor(
    /** Unique name for this query, used in logs and debug output. */
    public readonly name: string,
    /** The world that owns this query. */
    public readonly world: World,
    track: boolean = true,
  ) {
    world._addQuery(this);
    if (track) this.track();
  }

  /** Returns the query name. */
  public toString(): string {
    return this.name;
  }

  /**
   * Enable entity tracking: matched entities are inserted into {@link entities}
   * as they enter and removed as they exit.
   *
   * Idempotent. When called after {@link World.start}, immediately backfills all
   * existing entities that currently satisfy the query predicate.
   *
   * @returns `this` for chaining.
   */
  public track(): this {
    this._entities ??= new Set<Entity>();
    this.backfill();
    return this;
  }

  private backfill(): void {
    if (this._entities === undefined) return;
    this.world._forEachEntity((e) => {
      if (this.belongs(e) && !this._entities!.has(e)) {
        e._addQuery(this);
        e._updateQueries();
      }
    });
  }

  /**
   * Read-only view of the entities currently tracked by this query.
   *
   * Populated as entities enter (and removed as they exit). Empty unless
   * tracking is enabled (default for standalone queries; requires an explicit
   * {@link track} call on {@link System | systems}).
   */
  public get entities(): ReadonlySet<Entity> {
    return this._entities ?? EMPTY_ENTITIES;
  }

  /**
   * Iterate over every entity currently tracked by this query.
   *
   * @param callback - Called once per tracked entity, in insertion order
   *   (or sort order when {@link sort} is configured).
   */
  public forEach(callback: (e: Entity) => void): void {
    this._entities?.forEach(callback);
  }

  /** Returns `true` if the entity satisfies this query's predicate. */
  public belongs(e: Entity): boolean {
    return this._belongs(e);
  }

  /** Hook for subclasses — called when a component on an entity in this query changes. */
  public notifyModified(_c: Component): void {}

  /** @internal Fires enter callbacks and adds entity to the tracked set. */
  public _enter(e: Entity): void {
    this._enterCallback.forEach((cb) => cb(e));
    this._entities?.add(e);
  }

  /** @internal Fires exit callbacks and removes entity from the tracked set. */
  public _exit(e: Entity): void {
    this._exitCallback.forEach((cb) => cb(e));
    this._entities?.delete(e);
  }

  /**
   * Register a callback that fires when an entity **enters** this query
   * (i.e. first satisfies the predicate) with injected components.
   *
   * @param inject - Ordered list of component classes (or `{ parent: C }`) to
   *   resolve from the entering entity and pass to `callback`.
   * @param callback - Receives the entity and the resolved component tuple.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * query.enter([Position, Sprite], (e, [pos, sprite]) => {
   *   sprite.initialize(scene);
   *   sprite.sprite.setPosition(pos.x, pos.y);
   * });
   * ```
   */
  public enter<J extends ComponentOrParent[]>(
    inject: readonly [...J],
    callback: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): this;

  /**
   * Register a callback that fires when an entity enters this query.
   *
   * @param callback - Receives only the entity (no injection).
   * @returns `this` for chaining.
   */
  public enter(callback: (e: Entity) => void): this;

  public enter<J extends ComponentOrParent[]>(
    injectOrCallback: readonly [...J] | ((e: Entity) => void),
    callback?: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): this {
    if (typeof injectOrCallback === "function") {
      this._enterCallback.push(injectOrCallback);
    } else {
      const inject = this.mapInjectedClassToTypes(injectOrCallback);
      this._enterCallback.push((e: Entity) => {
        callback!(e, this.getInjected(e, inject) as any);
      });
    }
    return this;
  }

  /**
   * Register a callback that fires when an entity **exits** this query
   * (its components no longer satisfy the predicate, or it was destroyed) with
   * injected components.
   *
   * Components that were just removed are still accessible via `get_deleted`
   * semantics — the injected tuple includes them even though they are no
   * longer in the entity's active component set.
   *
   * @param inject - Component classes to resolve and inject.
   * @param callback - Receives the entity and the resolved component tuple.
   * @returns `this` for chaining.
   */
  public exit<J extends ComponentOrParent[]>(
    inject: readonly [...J],
    callback: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): this;

  /**
   * Register a callback that fires when an entity exits this query.
   *
   * @param callback - Receives only the entity.
   * @returns `this` for chaining.
   */
  public exit(callback: (e: Entity) => void): this;

  public exit<J extends ComponentOrParent[]>(
    injectOrCallback: readonly [...J] | ((e: Entity) => void),
    callback?: (
      e: Entity,
      injected: { [K in keyof J]: ComponentInstance<J[K]> }
    ) => void
  ): this {
    if (typeof injectOrCallback === "function") {
      this._exitCallback.push(injectOrCallback);
    } else {
      const inject = this.mapInjectedClassToTypes(injectOrCallback);
      this._exitCallback.push((e: Entity) => {
        callback!(e, this.getInjected(e, inject, true) as any);
      });
    }
    return this;
  }

  /**
   * Enable sorted entity tracking: matched entities are stored in insertion
   * order determined by `compare`, which receives a tuple of resolved
   * component instances for each pair of entities being ordered.
   *
   * @param components - Component classes to resolve and pass to `compare`.
   * @param compare - Returns a negative number, zero, or positive number when
   *   `a` should sort before, equal to, or after `b`.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * world.system("Render")
   *   .requires(Position, Sprite)
   *   .sort([Position], ([posA], [posB]) => posA.z - posB.z);
   * ```
   */
  public sort<J extends (typeof Component)[]>(
    components: readonly [...J],
    compare: (
      a: { [K in keyof J]: MaybeRequired<J[K], R> },
      b: { [K in keyof J]: MaybeRequired<J[K], R> }
    ) => number
  ): this {
    const types = components.map((C) => this.world.getComponentType(C));
    this._entities = new OrderedSet<Entity>((a, b) =>
      compare(
        types.map((t) => a.get(t, true)) as any,
        types.map((t) => b.get(t, true)) as any
      )
    );
    this.backfill();
    return this;
  }

  /**
   * Set the entity membership predicate using the {@link QueryDSL} DSL.
   *
   * Replaces any previous predicate. The optional `guaranteed` tuple is a
   * pure type-level hint: it tells {@link sort} callbacks which components are
   * guaranteed present on every matched entity, eliminating `| undefined` from
   * those positions. It has no effect at runtime.
   *
   * @param q - A {@link QueryDSL} expression.
   * @param _guaranteed - Component classes guaranteed present on every matched
   *   entity (type hint only — not validated at runtime).
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * world.system("Move")
   *   .query({ AND: [{ HAS: Position }, { HAS: Velocity }] }, [Position, Velocity])
   *   .each([Position, Velocity], (e, [pos, vel]) => {
   *     pos.x += vel.vx;  // no ! needed
   *   });
   * ```
   */
  public query<T extends (typeof Component)[] = []>(
    q: QueryDSL,
    _guaranteed?: readonly [...T]
  ): Query<T> {
    this._belongs = buildEntityTest(this.world, q);
    this.hasQuery = true;
    this.backfill();
    return this as unknown as Query<T>;
  }

  /**
   * Remove this query from the world and all entities.
   *
   * Every entity that currently belongs to this query has the query silently
   * removed (no exit callbacks are fired). After this call the query is
   * unregistered from its world and `world` is set to `undefined` by force.
   *
   * Calling any method on the query after `destroy()` is **undefined behavior**.
   */
  public destroy(): void {
    this.world._removeQuery(this);
    this._entities?.clear();
    (this as any).world = undefined;
  }

  /**
   * Shorthand for `query([...components])` — tracks entities that have
   * **all** of the listed component types.
   *
   * Equivalent to `query({ HAS: components })`. Unlike `query`, passing
   * component classes here also informs the types of {@link sort} callbacks:
   * listed components will be non-nullable in those tuples.
   *
   * @param components - One or more component classes.
   * @returns `this` for chaining.
   */
  public requires<T extends (typeof Component)[]>(...components: [...T]): Query<T> {
    this.query(components);
    return this as unknown as Query<T>;
  }

  private getComponent(
    e: Entity,
    C: ComponentOrParentType,
    considerDeleted: boolean
  ) {
    let c: Component | undefined;
    if (typeof C === "number") {
      c = e.get(C, considerDeleted);
    } else {
      c = e.parent && e.parent.get(C.parent, considerDeleted);
    }
    return c;
  }

  private getInjected(
    e: Entity,
    inject: ComponentOrParentType[],
    considerDeleted = false
  ) {
    const injected: Component[] = [];
    inject.forEach((C) => {
      const c = this.getComponent(e, C, considerDeleted);
      if (!c) throw "query does not contain component";
      injected.push(c);
    });
    return injected;
  }

  private mapInjectedClassToTypes<J extends ComponentOrParent[]>(
    inject: readonly [...J]
  ): ComponentOrParentType[] {
    return inject.map((C) => {
      if (typeof C === "function") return this.world.getComponentType(C);
      return { parent: this.world.getComponentType(C.parent) };
    });
  }

}
