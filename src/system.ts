import { Component } from "./component.js";
import { Query } from "./query.js";
import { type QueryDSL, type MaybeRequired } from "./dsl.js";
import type { Entity } from "./entity.js";
import { Phase, type IPhase } from "./phase.js";
import { type World } from "./world.js";

export type { QueryDSL as SystemQuery, EntityTestFunc } from "./dsl.js";

type RunCallback = (now: number, delta: number) => void;

/**
 * One ordered event in a system's inbox. Routed by the world during command
 * queue processing; replayed during the system's next `_run`.
 *
 * @internal
 */
export type SystemInboxEvent =
  | { kind: "enter"; entity: Entity }
  | { kind: "exit"; entity: Entity; snapshot: Map<number, Component> }
  | { kind: "update"; component: Component };

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
 * Internally each system holds a single ordered **inbox** of routed events
 * (`enter`, `exit`, `update`). The world appends to it during command-queue
 * routing; the system replays the inbox at the top of every `_run` so
 * callbacks observe events in arrival order.
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
  protected eachCallback: ((e: Entity) => void) | undefined;
  private _runCallback: RunCallback | undefined;
  private readonly inbox: SystemInboxEvent[] = [];
  /** @internal */
  public _phase: string | Phase | undefined;

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
      if (!(p instanceof Phase)) {
        throw "Invalid Phase object";
      }
      if (p.world !== this.world) {
        throw "Phase does not belong to this system's world";
      }
    }
    this._phase = p;
    return this;
  }

  /** @internal Routing entry: register membership and enqueue an enter event. */
  public override _enter(e: Entity): void {
    this._entities?.add(e);
    e._addQueryMembership(this);
    if (this._enterCallback !== undefined) {
      this.inbox.push({ kind: "enter", entity: e });
    }
    // Bridge: surface watched components on entry through `notifyModified`,
    // which on System pushes inbox `update` events.
    e.forEachComponent((c) => {
      if (this.watchlistBitmask.hasBit(c.bitPtr)) {
        this.notifyModified(c);
      }
    });
  }

  /** @internal Routing entry: deregister membership and enqueue an exit event. */
  public override _exit(e: Entity): void {
    this._entities?.delete(e);
    e._removeQueryMembership(this);
    if (this._exitCallback !== undefined) {
      // Snapshot components now — still installed at this call site (bitmask
      // already cleared). The snapshot is needed for exit-injection callbacks
      // which fire in the next _run.
      const snapshot = new Map<number, Component>();
      e._forEachInstalledComponent((c) => snapshot.set(c.type, c));
      this.inbox.push({ kind: "exit", entity: e, snapshot });
    }
  }

  /** @internal Routing entry: enqueue an update event if the watchlist matches. */
  public override notifyModified(c: Component): void {
    if (!this.watchlistBitmask.hasBit(c.bitPtr)) {
      return;
    }
    this.inbox.push({ kind: "update", component: c });
  }

  /**
   * @internal Execute one tick: drain the inbox in arrival order, then run
   * `runCallback` and `eachCallback`. The whole body runs in a deferred
   * scope; any mutations made by callbacks land in the world queue and are
   * processed by the world after `_run` returns.
   */
  public _run(now: number, delta: number) {
    this.world.beginDeferred();
    try {
      for (let i = 0; i < this.inbox.length; i++) {
        const event = this.inbox[i];
        switch (event.kind) {
          case "enter":
            this._enterCallback!(event.entity);
            break;
          case "exit":
            this._exitCallback!(event.entity, event.snapshot);
            break;
          case "update":
            const callback = this.componentUpdateCallbacks.get(event.component.type);
            if (callback) {
              callback(event.component);
            }
            break;
        }
      }
      this.inbox.length = 0;

      if (this._runCallback) {
        this._runCallback(now, delta);
      }

      if (this.eachCallback) {
        const cb = this.eachCallback;
        this.forEach((e) => cb(e));
      }
    } finally {
      this.world.endDeferred();
    }
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
    callback: (e: Entity, resolved: { [K in keyof J]: MaybeRequired<J[K], R> }) => void
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
