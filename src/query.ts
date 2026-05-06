import { OrderedSet } from "./util/ordered_set.js";
import { ArrayMap } from "./util/array_map.js";
import { Bitset } from "./util/bitset.js";
import { Component } from "./component.js";
import type { Entity } from "./entity.js";
import { type World } from "./world.js";
import {
  _HAS,
  _buildEntityTest,
  type EntityTestFunc,
  type QueryDSL,
  type MaybeRequired,
} from "./dsl.js";

export type { EntityTestFunc, QueryDSL, MaybeRequired };

type EntityCallback = (e: Entity, snapshot?: Map<number, Component>) => void;
type ComponentCallback = (c: Component) => void;

/** Component class, or `{ parent: ComponentClass }` to resolve from the entity's parent. */
type ComponentOrParent = typeof Component | { parent: typeof Component };

/** Numeric type id, or `{ parent: typeId }` to resolve from the entity's parent. */
type ComponentOrParentType = number | { parent: number };

/** Resolves the component instance type for one element of a `ComponentOrParent` tuple. */
type ComponentInstance<T> = T extends { parent: typeof Component }
  ? InstanceType<T["parent"]>
  : T extends typeof Component
    ? InstanceType<T>
    : never;

const EMPTY_ENTITIES: ReadonlySet<Entity> = new Set();

/**
 * A reactive, always-up-to-date set of entities matching a {@link QueryDSL}
 * predicate.
 *
 * `Query` listens to entity / component mutations through the world's command
 * queue and tracks which entities currently satisfy its predicate. It fires
 * `enter`, `exit`, and `update` callbacks as the matched set changes. The
 * tracked set is exposed via {@link entities} and {@link forEach}.
 *
 * Callbacks fire **synchronously** when the world routes a command — so
 * mutations made inside one of these callbacks are themselves observed
 * immediately by other queries / systems.
 *
 * {@link System} extends `Query` and queues callbacks into an inbox replayed
 * during `_run` instead of firing them immediately. Use `Query` directly when
 * you want a reactive entity set without pipeline integration.
 *
 * @typeParam R - Component classes guaranteed present on every matched entity
 *   (declared via {@link requires} or the `_guaranteed` hint of {@link query}).
 *   Components in `R` appear as non-nullable in {@link sort}, {@link forEach},
 *   and {@link update} callback tuples.
 */
export class Query<R extends (typeof Component)[] = []> {
  /** @internal Tracked entity set. Allocated by {@link track} or {@link sort}. */
  protected _entities: Set<Entity> | undefined;
  /** @internal Predicate compiled from the query DSL; defaults to "match nothing". */
  protected _belongs: EntityTestFunc = (_e: Entity) => false;
  /** @internal `true` once {@link query} or {@link requires} has set an explicit predicate. */
  protected _hasQuery: boolean = false;

  /** @internal `enter` callback (already wraps any injection logic). */
  protected _enterCallback: EntityCallback | undefined = undefined;
  /** @internal `exit` callback (already wraps any injection logic). */
  protected _exitCallback: EntityCallback | undefined = undefined;
  /** @internal Type ids the exit callback needs snapshotted before component removal. */
  protected _exitSnapshotTypes: number[] | undefined = undefined;

  /** @internal Per-component-type `update` callbacks. */
  protected _componentUpdateCallbacks = new ArrayMap<ComponentCallback>();
  /** @internal Bitmask of component types this query reacts to via `update`. */
  protected _watchlistBitmask: Bitset = new Bitset();

  constructor(
    /** Unique display name; appears in logs and debug output. */
    public readonly name: string,
    /** World that owns this query. */
    public readonly world: World,
    track: boolean = true
  ) {
    world._addQuery(this);
    if (track) {
      this.track();
    }
  }

  /**
   * @internal Backfill the tracked set with every existing entity that
   * satisfies the current predicate. Runs inside a deferred scope so the
   * caller's reentrant routing remains consistent.
   */
  private _backfill(): void {
    if (this._entities === undefined) {
      return;
    }
    this.world.defer(() => {
      this.world.entities.forEach((e) => {
        if (this.belongs(e) && !e._isInQuery(this)) {
          this._enter(e);
        }
      });
    });
  }

  /**
   * @internal Resolve one element of an `inject` tuple to a component
   * instance, falling back to `exitSnapshot` when the entity is mid-exit.
   */
  private _getComponent(
    e: Entity,
    C: ComponentOrParentType,
    exitSnapshot?: Map<number, Component>
  ): Component | undefined {
    if (typeof C === "number") {
      return exitSnapshot?.get(C) ?? e.get(C);
    } else {
      return e.parent?.get(C.parent);
    }
  }

  /**
   * @internal Resolve every element of an `inject` tuple, throwing if any
   * required component is missing on the entity (or its parent).
   */
  private _getInjected(
    e: Entity,
    inject: ComponentOrParentType[],
    exitSnapshot?: Map<number, Component>
  ): Component[] {
    const injected: Component[] = [];
    inject.forEach((C) => {
      const c = this._getComponent(e, C, exitSnapshot);
      if (!c) {
        throw "query does not contain component";
      }
      injected.push(c);
    });
    return injected;
  }

  /**
   * @internal Translate a tuple of component classes (or `{ parent: C }`
   * markers) into the corresponding type ids understood by {@link _getInjected}.
   */
  private _mapInjectedClassToTypes<J extends ComponentOrParent[]>(
    inject: readonly [...J]
  ): ComponentOrParentType[] {
    return inject.map((C) => {
      if (typeof C === "function") {
        return this.world.getComponentType(C);
      }
      return { parent: this.world.getComponentType(C.parent) };
    });
  }

  /**
   * @internal Add `e` to the tracked set, register query membership on the
   * entity, fire any registered `enter` callback, then bridge the entity's
   * already-attached watched components through {@link _notifyModified} so
   * `update` callbacks see them once on entry.
   *
   * `System` overrides this to push events into its inbox.
   */
  public _enter(e: Entity): void {
    this._entities?.add(e);
    e._addQueryMembership(this);
    this._enterCallback?.(e);
    e.components.forEach((c) => {
      if (this._watchlistBitmask.hasBit(c.bitPtr)) {
        this._notifyModified(c);
      }
    });
  }

  /**
   * @internal Remove `e` from the tracked set, deregister query membership,
   * and fire any registered `exit` callback. `System` overrides this to push
   * an inbox event.
   */
  public _exit(e: Entity): void {
    this._exitCallback?.(e);
    this._entities?.delete(e);
    e._removeQueryMembership(this);
  }

  /**
   * @internal Routing entry: when the watchlist matches, invoke the registered
   * `update` callback for the component type. `System` overrides this to push
   * an inbox event instead of firing immediately.
   */
  public _notifyModified(c: Component): void {
    if (!this._watchlistBitmask.hasBit(c.bitPtr)) {
      return;
    }
    const callback = this._componentUpdateCallbacks.get(c.type);
    if (callback) {
      callback(c);
    }
  }

  /**
   * Read-only view of the entities currently tracked by this query.
   *
   * Populated as entities enter and removed as they exit. Empty unless
   * tracking is enabled — that is the default for standalone queries created
   * via {@link World.query}, but {@link System} requires an explicit
   * {@link track}, {@link sort}, or `each` call.
   */
  public get entities(): ReadonlySet<Entity> {
    return this._entities ?? EMPTY_ENTITIES;
  }

  /** Returns the query name. */
  public toString(): string {
    return this.name;
  }

  /**
   * Enable entity tracking: matched entities are inserted into {@link entities}
   * as they enter and removed as they exit.
   *
   * Idempotent. When called after {@link World.start}, immediately backfills
   * every existing entity that satisfies the current predicate.
   *
   * @returns This query, for chaining.
   */
  public track(): this {
    this._entities ??= new Set<Entity>();
    this._backfill();
    return this;
  }

  /** Returns `true` when `e` satisfies this query's predicate. */
  public belongs(e: Entity): boolean {
    return this._belongs(e);
  }

  /**
   * Iterate every entity currently tracked by this query.
   *
   * Mutations made by `callback` are buffered into the world command queue
   * and only become visible after iteration finishes. Nested iteration inside
   * an already-deferred context (a system, an outer `forEach`) inherits the
   * outer scope and does not drain on exit.
   *
   * @param callback - Invoked once per tracked entity, in insertion order
   *   (or sort order when {@link sort} is configured).
   */
  public forEach(callback: (e: Entity) => void): void;

  /**
   * Iterate every tracked entity with component injection.
   *
   * Components covered by {@link requires} (or the `_guaranteed` hint of
   * {@link query}) are non-nullable in the resolved tuple; any other
   * requested component may be `undefined` if the entity lacks it.
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
    this.world.beginDefer();
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
      this.world.endDefer();
    }
  }

  /**
   * Register a callback invoked when an entity **enters** this query (i.e.
   * first satisfies the predicate), with injected components.
   *
   * @param inject - Ordered list of component classes (or `{ parent: C }`) to
   *   resolve from the entering entity and pass to `callback`.
   * @param callback - Receives the entity and the resolved component tuple.
   * @returns This query, for chaining.
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
   * Register an `enter` callback without component injection.
   *
   * @param callback - Receives only the entering entity.
   * @returns This query, for chaining.
   */
  public enter(callback: (e: Entity) => void): this;

  public enter<J extends ComponentOrParent[]>(
    injectOrCallback: readonly [...J] | ((e: Entity) => void),
    callback?: (e: Entity, injected: { [K in keyof J]: ComponentInstance<J[K]> }) => void
  ): this {
    if (typeof injectOrCallback === "function") {
      this._enterCallback = injectOrCallback;
    } else {
      const inject = this._mapInjectedClassToTypes(injectOrCallback);
      this._enterCallback = (e: Entity) => {
        callback!(e, this._getInjected(e, inject) as any);
      };
    }
    return this;
  }

  /**
   * Register a callback invoked when an entity **exits** this query (its
   * archetype no longer satisfies the predicate, or it was destroyed), with
   * injected components.
   *
   * Components removed in the same frame as the exit are still resolvable
   * because the runtime snapshots them at routing time.
   *
   * @param inject - Component classes to resolve and inject.
   * @param callback - Receives the entity and the resolved component tuple.
   * @returns This query, for chaining.
   */
  public exit<J extends ComponentOrParent[]>(
    inject: readonly [...J],
    callback: (e: Entity, injected: { [K in keyof J]: ComponentInstance<J[K]> }) => void
  ): this;

  /**
   * Register an `exit` callback without component injection.
   *
   * @param callback - Receives only the exiting entity.
   * @returns This query, for chaining.
   */
  public exit(callback: (e: Entity) => void): this;

  public exit<J extends ComponentOrParent[]>(
    injectOrCallback: readonly [...J] | ((e: Entity) => void),
    callback?: (e: Entity, injected: { [K in keyof J]: ComponentInstance<J[K]> }) => void
  ): this {
    if (typeof injectOrCallback === "function") {
      this._exitCallback = injectOrCallback;
      this._exitSnapshotTypes = undefined;
    } else {
      const inject = this._mapInjectedClassToTypes(injectOrCallback);
      this._exitSnapshotTypes = inject.filter((t): t is number => typeof t === "number");
      this._exitCallback = (e: Entity, exitSnapshot?: Map<number, Component>) => {
        callback!(e, this._getInjected(e, inject, exitSnapshot) as any);
      };
    }
    return this;
  }

  /**
   * Register a callback invoked when a component of `ComponentClass` is
   * modified on a tracked entity.
   *
   * On a {@link Query} the callback fires **immediately** when the world
   * routes the corresponding `Set` / `Modified` command. On a {@link System}
   * the event is buffered in the inbox and the callback fires during the
   * system's next `_run`.
   *
   * If no other predicate has been set on this query, the watchlist
   * automatically expands so `ComponentClass` is implicitly required (the
   * predicate becomes a `HAS` of every watched type).
   *
   * @param ComponentClass - Component class to watch.
   * @param callback - Receives the modified component instance.
   * @returns This query, for chaining.
   *
   * @example
   * ```ts
   * world.system("RenderPosition")
   *   .update(Position, (pos) => sprite.setPosition(pos.x, pos.y));
   * ```
   */
  public update<C extends typeof Component>(
    ComponentClass: C,
    callback: (c: InstanceType<C>) => void
  ): this;

  /**
   * Like {@link update}, but with extra components injected from the same
   * entity.
   *
   * @param ComponentClass - Component class to watch.
   * @param inject - Additional component classes to resolve from the entity.
   * @param callback - Receives the modified component and the injected tuple.
   * @returns This query, for chaining.
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
      this._componentUpdateCallbacks.set(type, callback as any);
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

      this._componentUpdateCallbacks.set(type, cb);
    }

    this._watchlistBitmask.add(type);

    if (!this._hasQuery) {
      const watchlist: number[] = this._watchlistBitmask.indices();
      this._belongs = _HAS(this.world, ...watchlist);
      this._backfill();
    }

    return this;
  }

  /**
   * Switch the tracked set to a sorted ordering: matched entities are stored
   * in the position determined by `compare`, which receives a tuple of
   * resolved component instances for each pair being ordered.
   *
   * Implies {@link track}.
   *
   * @param components - Component classes to resolve and pass to `compare`.
   * @param compare - Negative when `a` should sort before `b`, zero for
   *   equality, positive when `a` should sort after `b`.
   * @returns This query, for chaining.
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
      compare(types.map((t) => a.get(t)) as any, types.map((t) => b.get(t)) as any)
    );
    this._backfill();
    return this;
  }

  /**
   * Set the entity-membership predicate using a {@link QueryDSL} expression.
   *
   * Replaces any previous predicate. The optional `_guaranteed` tuple is a
   * pure type-level hint: it tells {@link sort} / {@link forEach} /
   * {@link update} callbacks which components are guaranteed present on every
   * matched entity, eliminating `| undefined` from those positions. It has no
   * effect at runtime.
   *
   * @param q - Query expression.
   * @param _guaranteed - Component classes guaranteed present on every matched
   *   entity (type hint only — not validated at runtime).
   * @returns This query, retyped with the guaranteed tuple as its `R`.
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
    this._belongs = _buildEntityTest(this.world, q);
    this._hasQuery = true;
    this._backfill();
    return this as unknown as Query<T>;
  }

  /**
   * Shorthand for `query([...components])`: track entities that have **all**
   * of the listed component types.
   *
   * Equivalent to `query({ HAS: components })`. Unlike `query`, the listed
   * components are also recorded in the type parameter `R`, so {@link sort}
   * and {@link forEach} callbacks see them as non-nullable.
   *
   * @param components - Component classes to require.
   * @returns This query, retyped with the required tuple as its `R`.
   */
  public requires<T extends (typeof Component)[]>(...components: [...T]): Query<T> {
    this.query(components);
    return this as unknown as Query<T>;
  }

  /**
   * Permanently remove this query from the world.
   *
   * Every entity that currently belongs to this query has the membership
   * silently purged (no `exit` callbacks fire), the tracked set is cleared,
   * and the `world` reference is forced to `undefined`. Calling any method on
   * the query afterwards is **undefined behavior**.
   *
   * Not supported on {@link System} — calling it on a system throws.
   */
  public destroy(): void {
    this.world._removeQuery(this);
    this._entities?.clear();
    (this as any).world = undefined;
  }
}
