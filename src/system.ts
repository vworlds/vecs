import { ArrayMap } from "./util/array_map.js";
import { Bitset } from "./util/bitset.js";
import { Component } from "./component.js";
import { Query, HAS, type QueryDSL, type MaybeRequired } from "./query.js";
import type { Entity } from "./entity.js";
import { Phase, type IPhase } from "./phase.js";
import { type World } from "./world.js";

export type { QueryDSL as SystemQuery, EntityTestFunc } from "./query.js";

type ComponentCallback = (c: Component) => void;
type RunCallback = (now: number, delta: number) => void;


/**
 * A reactive processor that operates on a filtered subset of world entities.
 *
 * Systems are created and registered through {@link World.system}:
 *
 * ```ts
 * world.system("Move")
 *   .requires(Position, Velocity)       // track entities with both components
 *   .phase("update")
 *   .enter([Position], (e, [pos]) => { pos.x = 0; })
 *   .update(Position, (pos) => { pos.x += pos.vx; })
 *   .exit((e) => { console.log("entity left", e.eid); });
 * ```
 *
 * All builder methods return `this` for chaining. Call {@link World.start}
 * once all systems are registered; after that, drive the loop with
 * {@link World.runPhase}.
 *
 * ### Component injection and type inference
 *
 * `enter`, `exit`, `update`, `each`, and `sort` all accept an array of
 * component classes that are resolved from the entity and passed as a typed
 * tuple to the callback. Use `{ parent: SomeComponent }` to resolve from the
 * entity's parent instead of the entity itself.
 *
 * Components declared via {@link requires} (or the second argument of
 * {@link query}) are tracked as a type parameter `R` on the system. In
 * `sort`, `each`, and `update` inject callbacks, those components appear as
 * non-nullable; any component not in `R` remains `Type | undefined`.
 */
export class System<R extends (typeof Component)[] = []> extends Query<R> {
  protected componentUpdateCallbacks = new ArrayMap<ComponentCallback>();
  protected eachCallback: ((e: Entity) => void) | undefined;
  private _runCallback: RunCallback | undefined;
  private readonly updateQueue: (Component | undefined)[] = [];
  /** @internal */
  public _phase: string | Phase | undefined;

  protected watchlistBitmask: Bitset = new Bitset();

  constructor(name: string, world: World) {
    super(name, world, false);
  }

  /**
   * Assign this system to a pipeline phase.
   *
   * The phase can be specified by name (the world will resolve it at
   * {@link World.start | start} time) or by an {@link IPhase} reference
   * returned from {@link World.addPhase}. Systems without an explicit phase
   * are placed in the built-in `"update"` phase.
   *
   * @param p - Phase name or `IPhase` reference.
   * @returns `this` for chaining.
   */
  public phase(p: string | IPhase) {
    if (typeof p !== "string") {
      if (!(p instanceof Phase)) throw "Invalid Phase object";
      if (p.world !== this.world)
        throw "Phase does not belong to this system's world";
    }
    this._phase = p;
    return this;
  }

  /** @internal Delivers a component-modified notification to this system. */
  public override notifyModified(c: Component) {
    if (!this.watchlistBitmask.hasBit(c.bitPtr)) return;
    this.updateQueue.push(c);
  }

  /** @internal Fires enter callbacks, adds entity to tracked set, queues component updates. */
  public override _enter(e: Entity) {
    super._enter(e);
    e.forEachComponent((c) => this.notifyModified(c));
  }

  /** @internal Fires exit callbacks, removes entity from tracked set, drains update queue. */
  public override _exit(e: Entity) {
    super._exit(e);
    this.updateQueue.forEach((c, i) => {
      if (!c) return;
      if (c.entity === e) this.updateQueue[i] = undefined;
    });
  }

  /** @internal Execute one tick: run `run`, fire `each`, then drain the update queue. */
  public _run(now: number, delta: number) {
    if (this._runCallback) this._runCallback(now, delta);

    if (this.eachCallback) {
      const cb = this.eachCallback;
      this.forEach((e) => cb(e));
    }

    this.updateQueue.forEach((c) => {
      if (!c) return;
      const callback = this.componentUpdateCallbacks.get(c.type);
      if (callback) {
        callback(c);
      }
    });
    this.updateQueue.length = 0;
  }

  /**
   * Register a per-tick callback that runs every time this system's phase
   * executes, regardless of entity membership.
   *
   * Use this for logic that is not driven by component updates — polling,
   * network flushing, global timers, etc.
   *
   * @param callback - Receives `now` (absolute timestamp in ms) and `delta`
   *   (ms since the last tick).
   * @returns `this` for chaining.
   */
  public run(callback: RunCallback): this {
    this._runCallback = callback;
    return this;
  }

  /**
   * Register a callback that fires when a component of type `ComponentClass`
   * is modified on any entity in this system.
   *
   * The system will automatically begin tracking entities that have this
   * component type (equivalent to adding it to a `requires` / `HAS` query)
   * unless a custom {@link query} was already set.
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
  update<C extends typeof Component, J extends (typeof Component)[]>(
    ComponentClass: C,
    inject: readonly [...J],
    callback: (
      c: InstanceType<C>,
      injected: { [K in keyof J]: MaybeRequired<J[K], R> }
    ) => void
  ): this;

  update<C extends typeof Component, J extends (typeof Component)[]>(
    ComponentClass: C,
    injectOrCallback: readonly [...J] | ((c: InstanceType<C>) => void),
    callback?: (
      c: InstanceType<C>,
      injected: { [K in keyof J]: MaybeRequired<J[K], R> }
    ) => void
  ): this {
    const type = this.world.getComponentType(ComponentClass);
    if (typeof injectOrCallback === "function") {
      callback = injectOrCallback;
      this.componentUpdateCallbacks.set(type, callback as any);
    } else {
      const inject = injectOrCallback;
      const injectedComponentTypes = inject.map((C) =>
        this.world.getComponentType(C)
      );
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
    }

    return this;
  }

  /**
   * Register a callback that fires **every tick** for every entity currently
   * tracked by this system, with the listed components resolved from each
   * entity.
   *
   * Unlike {@link update} (which only fires when `component.modified()` is
   * called), `each` fires unconditionally on every tick the system runs,
   * once per tracked entity. Components declared via {@link requires} are
   * guaranteed non-null in the resolved tuple; any other component class
   * may be `undefined` if the entity lacks it.
   *
   * `each` does **not** modify the system's query — define membership with
   * {@link requires} or {@link query} as usual. It does, however, implicitly
   * enable {@link track}, so matched entities are exposed via {@link entities}.
   *
   * Only a single `each` callback may be registered per system; calling
   * `each` a second time throws.
   *
   * @param components - Component classes to resolve from each entity.
   * @param callback - Receives the entity and a tuple of resolved component
   *   instances (`undefined` for components not covered by {@link requires}).
   * @returns `this` for chaining.
   * @throws If `each` has already been registered on this system.
   *
   * @example
   * ```ts
   * world.system("Move")
   *   .requires(Position, Velocity)
   *   .each([Position, Velocity], (e, [pos, vel]) => {
   *     pos.x += vel.vx;
   *     pos.y += vel.vy;
   *   });
   * ```
   */
  public each<J extends (typeof Component)[]>(
    components: readonly [...J],
    callback: (
      e: Entity,
      resolved: { [K in keyof J]: MaybeRequired<J[K], R> }
    ) => void
  ): this {
    if (this.eachCallback) {
      throw `each already registered for system '${this.name}'`;
    }
    this.track();
    const types = components.map((C) => this.world.getComponentType(C));
    this.eachCallback = (e: Entity) => {
      const resolved = types.map((t) => e.get(t));
      callback(e, resolved as any);
    };
    return this;
  }

  /**
   * Not supported on `System`. Throws unconditionally.
   *
   * Systems are owned by the world for the duration of the session. If you
   * need a temporary reactive set, use a standalone {@link Query} instead.
   */
  public override destroy(): never {
    throw `destroy() is not supported on System '${this.name}'`;
  }

  /**
   * Set the entity membership predicate using the {@link QueryDSL} DSL.
   *
   * Replaces any implicit query derived from `update` watchlists and any
   * previous `requires` call. After calling `query`, auto-expanding of
   * `update` watchlists is disabled.
   *
   * The optional `guaranteed` tuple is a pure type-level hint: it tells
   * `sort`, `each`, and `update` callbacks which components are guaranteed
   * to be present on every matched entity, eliminating `| undefined` from
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
  public override query<T extends (typeof Component)[] = []>(
    q: QueryDSL,
    _guaranteed?: readonly [...T]
  ): System<T> {
    super.query(q, _guaranteed);
    return this as unknown as System<T>;
  }

  /**
   * Shorthand for `query([...components])` — the system tracks entities that
   * have **all** of the listed component types.
   *
   * Equivalent to `query({ HAS: components })`. Unlike `query`, passing
   * component classes here also informs the types of {@link sort} and
   * {@link each} callbacks: listed components will be non-nullable in those
   * tuples.
   *
   * @param components - One or more component classes.
   * @returns `this` for chaining.
   */
  public override requires<T extends (typeof Component)[]>(...components: [...T]): System<T> {
    super.requires(...components);
    return this as unknown as System<T>;
  }
}
