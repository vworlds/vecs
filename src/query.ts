import { OrderedSet } from "./util/ordered_set.js";
import { ArrayMap } from "./util/array_map.js";
import { Bitset } from "./util/bitset.js";
import { Component } from "./component.js";
import type { Entity } from "./entity.js";
import { type World } from "./world.js";
import {
  HAS,
  buildEntityTest,
  type EntityTestFunc,
  type QueryDSL,
  type MaybeRequired,
} from "./dsl.js";

export type { EntityTestFunc, QueryDSL, MaybeRequired };

type EntityCallback = (e: Entity) => void;
type ComponentCallback = (c: Component) => void;

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
 * via {@link requires} or {@link query}. Entry, exit, and update callbacks
 * fire automatically when the world's command queue is processed. The tracked
 * set is exposed via {@link entities} and {@link forEach}.
 *
 * {@link System} extends `Query` and queues callbacks for its next `_run`
 * rather than firing them immediately. Use `Query` directly when you want
 * synchronous reactive callbacks without pipeline integration.
 *
 * ### Type parameter `R`
 * Tracks which component classes are "required" (declared via {@link requires}
 * or the `_guaranteed` hint of {@link query}). Those components appear as
 * non-nullable in {@link sort}, {@link forEach}, and {@link update} callbacks.
 */
export class Query<R extends (typeof Component)[] = []> {
  protected _entities: Set<Entity> | undefined;
  protected _enterCallback: EntityCallback[] = [];
  protected _exitCallback: EntityCallback[] = [];
  protected _belongs: EntityTestFunc = (_e: Entity) => false;
  protected hasQuery = false;

  /** @internal Per-component-type update callbacks. */
  protected componentUpdateCallbacks = new ArrayMap<ComponentCallback>();
  /** @internal Bitmask of component types this query is watching for updates. */
  protected watchlistBitmask: Bitset = new Bitset();

  constructor(
    /** Unique name for this query, used in logs and debug output. */
    public readonly name: string,
    /** The world that owns this query. */
    public readonly world: World,
    track: boolean = true
  ) {
    world._addQuery(this);
    if (track) {
      this.track();
    }
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
    if (this._entities === undefined) {
      return;
    }
    this.world.beginDeferred();
    try {
      this.world._forEachEntity((e) => {
        if (this.belongs(e) && !e._hasQuery(this)) {
          this._enter(e);
        }
      });
    } finally {
      this.world.endDeferred();
    }
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
   * Mutations made by `callback` are buffered into the world command queue
   * (deferred mode) and only become visible after iteration finishes. Nested
   * iteration inside an already-deferred context (a system, another forEach)
   * inherits the outer deferred scope and does not drain on exit.
   *
   * @param callback - Called once per tracked entity, in insertion order
   *   (or sort order when {@link sort} is configured).
   */
  public forEach(callback: (e: Entity) => void): void;

  /**
   * Iterate over every entity currently tracked by this query, with component
   * injection.
   *
   * Components declared via {@link requires} (or the `_guaranteed` hint of
   * {@link query}) are non-nullable in the resolved tuple; any other requested
   * component may be `undefined` if the entity lacks it.
   *
   * @param components - Component classes to resolve from each entity.
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
        this._entities?.forEach(componentsOrCallback);
      } else {
        if (!this._entities || !this.world) {
          return;
        }
        const types = componentsOrCallback.map((C) => this.world.getComponentType(C));
        this._entities.forEach((e) => {
          const resolved = types.map((t) => e.get(t));
          callback!(e, resolved as any);
        });
      }
    } finally {
      this.world.endDeferred();
    }
  }

  /** Returns `true` if the entity satisfies this query's predicate. */
  public belongs(e: Entity): boolean {
    return this._belongs(e);
  }

  /**
   * @internal Called by the world during command-queue routing when a Set
   * command targets an entity that this query currently tracks. Default:
   * fires the user-registered `update` callback for the component's type.
   * `System` overrides this to push into its inbox instead.
   */
  public notifyModified(c: Component): void {
    if (!this.watchlistBitmask.hasBit(c.bitPtr)) {
      return;
    }
    const callback = this.componentUpdateCallbacks.get(c.type);
    if (callback) {
      callback(c);
    }
  }

  /**
   * @internal Adds the entity to the tracked set, registers query membership
   * on the entity, fires registered enter callbacks, then bridges any
   * already-attached watched components through `notifyModified` so that
   * `update` callbacks see the entity once on entry. `System` overrides this
   * to push inbox events (events fire later in `_run`).
   */
  public _enter(e: Entity): void {
    this._entities?.add(e);
    e._addQueryMembership(this);
    this._enterCallback.forEach((cb) => cb(e));
    // Bridge: surface the entity's already-attached watched components as
    // update events so `update` handlers fire once on entry without the user
    // having to call `modified()` explicitly.
    e.forEachComponent((c) => {
      if (this.watchlistBitmask.hasBit(c.bitPtr)) {
        this.notifyModified(c);
      }
    });
  }

  /**
   * @internal Removes the entity from the tracked set, deregisters query
   * membership, and fires registered exit callbacks. `System` overrides this
   * to also push an inbox event.
   */
  public _exit(e: Entity): void {
    this._exitCallback.forEach((cb) => cb(e));
    this._entities?.delete(e);
    e._removeQueryMembership(this);
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
    callback: (e: Entity, injected: { [K in keyof J]: ComponentInstance<J[K]> }) => void
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
    callback?: (e: Entity, injected: { [K in keyof J]: ComponentInstance<J[K]> }) => void
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
    callback: (e: Entity, injected: { [K in keyof J]: ComponentInstance<J[K]> }) => void
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
    callback?: (e: Entity, injected: { [K in keyof J]: ComponentInstance<J[K]> }) => void
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
   * Register a callback that fires when a component of type `ComponentClass`
   * is modified on any entity tracked by this query.
   *
   * On a {@link Query}, callbacks fire **immediately** when the world's
   * command queue routes the corresponding `Set` command. On a {@link System},
   * the event is buffered in the system's inbox and the callback fires during
   * the system's next `_run`.
   *
   * If no other predicate has been set on this query, the watchlist
   * automatically expands to require `ComponentClass` (equivalent to adding
   * it to a `requires` / `HAS` query).
   *
   * @param ComponentClass - The component class to watch.
   * @param callback - Receives the modified component instance.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * world.system("RenderPosition")
   *   .update(Position, (pos) => {
   *     sprite.setPosition(pos.x, pos.y);
   *   });
   * ```
   */
  public update<C extends typeof Component>(
    ComponentClass: C,
    callback: (c: InstanceType<C>) => void
  ): this;

  /**
   * Register a callback that fires when `ComponentClass` is modified, with
   * additional components injected from the same entity.
   *
   * @param ComponentClass - The component class to watch.
   * @param inject - Additional component classes to resolve from the entity.
   * @param callback - Receives the modified component and the injected tuple.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * world.system("SyncSprite")
   *   .update(Position, [Sprite], (pos, [sprite]) => {
   *     sprite.sprite.setPosition(pos.x, pos.y);
   *   });
   * ```
   */
  public update<C extends typeof Component, J extends (typeof Component)[]>(
    ComponentClass: C,
    inject: readonly [...J],
    callback: (c: InstanceType<C>, injected: { [K in keyof J]: MaybeRequired<J[K], R> }) => void
  ): this;

  public update<C extends typeof Component, J extends (typeof Component)[]>(
    ComponentClass: C,
    injectOrCallback: readonly [...J] | ((c: InstanceType<C>) => void),
    callback?: (c: InstanceType<C>, injected: { [K in keyof J]: MaybeRequired<J[K], R> }) => void
  ): this {
    const type = this.world.getComponentType(ComponentClass);
    if (typeof injectOrCallback === "function") {
      callback = injectOrCallback;
      this.componentUpdateCallbacks.set(type, callback as any);
    } else {
      const inject = injectOrCallback;
      const injectedComponentTypes = inject.map((C) => this.world.getComponentType(C));
      const cb = (c: Component) => {
        const injected: any[] = [];
        injectedComponentTypes.forEach((InjectedComponentType) => {
          injected.push(c.entity.get(InjectedComponentType));
        });

        if (callback) {
          callback(c as InstanceType<C>, injected as any);
        }
      };

      this.componentUpdateCallbacks.set(type, cb);
    }

    this.watchlistBitmask.add(type);

    if (!this.hasQuery) {
      const watchlist: number[] = this.watchlistBitmask.indices();
      this._belongs = HAS(this.world, ...watchlist);
      this.backfill();
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
      compare(types.map((t) => a.get(t, true)) as any, types.map((t) => b.get(t, true)) as any)
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

  private getComponent(e: Entity, C: ComponentOrParentType, considerDeleted: boolean) {
    let c: Component | undefined;
    if (typeof C === "number") {
      c = e.get(C, considerDeleted);
    } else {
      c = e.parent && e.parent.get(C.parent, considerDeleted);
    }
    return c;
  }

  private getInjected(e: Entity, inject: ComponentOrParentType[], considerDeleted = false) {
    const injected: Component[] = [];
    inject.forEach((C) => {
      const c = this.getComponent(e, C, considerDeleted);
      if (!c) {
        throw "query does not contain component";
      }
      injected.push(c);
    });
    return injected;
  }

  private mapInjectedClassToTypes<J extends ComponentOrParent[]>(
    inject: readonly [...J]
  ): ComponentOrParentType[] {
    return inject.map((C) => {
      if (typeof C === "function") {
        return this.world.getComponentType(C);
      }
      return { parent: this.world.getComponentType(C.parent) };
    });
  }
}
