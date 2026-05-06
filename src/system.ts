import { Component } from "./component.js";
import { Query } from "./query.js";
import { type QueryDSL, type MaybeRequired } from "./dsl.js";
import type { Entity } from "./entity.js";
import { Phase, type IPhase } from "./phase.js";
import { type World } from "./world.js";
import {
  ALWAYS_TICK_SOURCE,
  IntervalTickSource,
  type ITickSource,
  RateTickSource,
} from "./timer.js";

export type { QueryDSL as SystemQuery, EntityTestFunc } from "./dsl.js";

type RunCallback = (now: number, delta: number) => void;

/** Discriminator for {@link _SystemInboxEvent}. */
const enum InboxCommand {
  Enter,
  Exit,
  Update,
}

/**
 * One ordered event in a system's inbox. Routed by the world during command
 * queue processing; replayed during the system's next `_run`.
 *
 * @internal
 */
type _SystemInboxEvent =
  | { kind: InboxCommand.Enter; entity: Entity }
  | { kind: InboxCommand.Exit; entity: Entity; snapshot: Map<number, Component> | undefined }
  | { kind: InboxCommand.Update; component: Component };

/**
 * A reactive processor running over a filtered subset of world entities.
 *
 * Systems are created and configured through {@link World.system}:
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
 * Every builder method returns `this` for chaining. After registering systems
 * call {@link World.start} once, then drive the loop with
 * {@link World.runPhase} or {@link World.progress}.
 *
 * Internally each system holds a single ordered **inbox** of routed events
 * (`enter`, `exit`, `update`). The world appends to it during command-queue
 * routing; the system replays the inbox at the top of every `_run` so
 * callbacks observe events in arrival order.
 *
 * ### Component injection and type inference
 *
 * `enter`, `exit`, `update`, `each`, and `sort` accept an array of component
 * classes resolved from the entity and passed as a typed tuple to the
 * callback. Use `{ parent: SomeComponent }` to resolve from the entity's
 * parent instead of the entity itself.
 *
 * Components declared via {@link requires} (or the `_guaranteed` argument of
 * {@link query}) are tracked as the type parameter `R`. Inside `sort`,
 * `each`, and `update` injection callbacks they are non-nullable; any other
 * component remains `Type | undefined`.
 *
 * @typeParam R - Component classes guaranteed present on every matched entity.
 */
export class System<R extends (typeof Component)[] = []> extends Query<R> implements ITickSource {
  /** @internal Single inbox replayed in arrival order on every `_run`. */
  private readonly _inbox: _SystemInboxEvent[] = [];
  /** @internal Callback registered via {@link run}, fired every tick. */
  private _runCallback: RunCallback | undefined;
  /** @internal Callback registered via {@link each}, fired per tracked entity every tick. */
  protected _eachCallback: ((e: Entity) => void) | undefined;

  /** @internal Phase reference / name; resolved by `World.start`. */
  public _phase: string | Phase | undefined;

  /** @internal Whether this system processes events and runs callbacks. */
  private _enabled = true;
  /** @internal Cadence source for this system. Defaults to every frame. */
  private _tickSource: ITickSource = ALWAYS_TICK_SOURCE;

  constructor(name: string, world: World) {
    super(name, world, false);
  }

  /**
   * @internal Routing entry: register query membership for `e`, push an
   * inbox `enter` event when an `enter` callback is registered, and bridge
   * watched components through {@link _notifyModified} to surface them as
   * inbox `update` events on entry.
   */
  public override _enter(e: Entity): void {
    this._entities?.add(e);
    e._addQueryMembership(this);
    if (!this._enabled) {
      return;
    }
    if (this._enterCallback !== undefined) {
      this._inbox.push({ kind: InboxCommand.Enter, entity: e });
    }
    e.components.forEach((c) => {
      if (this._watchlistBitmask.hasBit(c.bitPtr)) {
        this._notifyModified(c);
      }
    });
  }

  /**
   * @internal Routing entry: deregister query membership for `e` and push an
   * inbox `exit` event when an `exit` callback is registered, capturing a
   * snapshot of the components the callback wants to inject so they remain
   * resolvable after the underlying components are removed.
   */
  public override _exit(e: Entity): void {
    this._entities?.delete(e);
    e._removeQueryMembership(this);
    if (!this._enabled) {
      return;
    }
    if (this._exitCallback !== undefined) {
      let snapshot: Map<number, Component> | undefined;
      if (this._exitSnapshotTypes && this._exitSnapshotTypes.length > 0) {
        snapshot = new Map<number, Component>();
        for (const type of this._exitSnapshotTypes) {
          const c = e._get(type);
          if (c) {
            snapshot.set(type, c);
          }
        }
      }
      this._inbox.push({ kind: InboxCommand.Exit, entity: e, snapshot });
    }
  }

  /**
   * @internal Routing entry: push an inbox `update` event when the modified
   * component matches the watchlist.
   */
  public override _notifyModified(c: Component): void {
    if (!this._enabled || !this._watchlistBitmask.hasBit(c.bitPtr)) {
      return;
    }
    this._inbox.push({ kind: InboxCommand.Update, component: c });
  }

  /**
   * @internal Execute one tick: drain the inbox in arrival order, then run
   * the `run` callback, then the `each` callback for every tracked entity.
   *
   * The whole body executes inside a `World.defer` scope; mutations made by
   * callbacks land in the world queue and are processed when `_run` returns.
   */
  public _run(now: number, delta: number): void {
    if (!this._enabled) {
      return;
    }
    if (!this._tickSource.didTick) {
      return;
    }
    const tickDelta = this._tickSource.lastFireDelta;
    this.world.defer(() => {
      for (let i = 0; i < this._inbox.length; i++) {
        const event = this._inbox[i];
        switch (event.kind) {
          case InboxCommand.Enter:
            this._enterCallback!(event.entity);
            break;
          case InboxCommand.Exit:
            this._exitCallback!(event.entity, event.snapshot);
            break;
          case InboxCommand.Update:
            const callback = this._componentUpdateCallbacks.get(event.component.type);
            if (callback) {
              callback(event.component);
            }
            break;
        }
      }
      this._inbox.length = 0;

      if (this._runCallback) {
        this._runCallback(now, tickDelta);
      }

      if (this._eachCallback) {
        const cb = this._eachCallback;
        this.forEach((e) => cb(e));
      }
    });
  }

  /** True when this system's cadence source fired during the current frame. */
  public get didTick(): boolean {
    return this._tickSource.didTick;
  }

  /** Milliseconds accumulated into this system's most recent fire. */
  public get lastFireDelta(): number {
    return this._tickSource.lastFireDelta;
  }

  /** @internal Evaluate this system's cadence source for a frame. */
  public _evalTick(delta: number, frameId: number): boolean {
    return this._tickSource._evalTick(delta, frameId);
  }

  /**
   * Run this system at a fixed interval, expressed in seconds.
   *
   * This is seconds, unlike `World.beginFrame`, `World.progress`, and
   * `runPhase`, which receive millisecond deltas. Calling `interval` replaces
   * the current cadence source with an {@link IntervalTickSource}. When this
   * system has a cadence source, the `delta` passed to {@link run} is the
   * accumulated milliseconds since the previous fire, not the per-frame delta.
   *
   * @param seconds - Positive interval duration in seconds.
   * @returns This system, for chaining.
   * @throws When `seconds` is less than or equal to zero.
   *
   * @example
   * ```ts
   * world.system("AI")
   *   .interval(0.5)
   *   .run((now, delta) => tickAI(delta));
   * ```
   */
  public interval(seconds: number): this {
    this._setTickSource(new IntervalTickSource(seconds));
    return this;
  }

  /**
   * Run this system every `n` ticks from the world or an upstream source.
   *
   * Without a `source`, this composes with the current cadence source. For an
   * unconfigured system, that means every `n` frames. With a `source`, it
   * replaces the current cadence with a {@link RateTickSource} over that source.
   * The `delta` passed to {@link run} is the accumulated milliseconds since
   * this system last fired.
   *
   * @param n - Positive integer tick divisor.
   * @param source - Optional upstream source to divide.
   * @returns This system, for chaining.
   * @throws When `n` is not a positive integer.
   *
   * @example
   * ```ts
   * world.system("SendSnapshots")
   *   .rate(2)
   *   .run(flushNetwork);
   * ```
   */
  public rate(n: number): this;
  public rate(n: number, source: ITickSource): this;
  public rate(n: number, source?: ITickSource): this {
    this._setTickSource(new RateTickSource(n, source ?? this._tickSource));
    return this;
  }

  /**
   * Run this system only when another timer or system ticks.
   *
   * Calling `tickSource` mirrors `source` directly; no wrapper source is
   * created. Use `.tickSource(source).rate(n)` or `.rate(n, source)` when this
   * system should divide an upstream source. The `delta` passed to {@link run}
   * is the accumulated milliseconds since this system last fired.
   *
   * @param source - Tick source or system source to mirror.
   * @returns This system, for chaining.
   *
   * @example
   * ```ts
   * const second = new IntervalTickSource(1);
   * world.system("Logger").tickSource(second).run(logStats);
   * ```
   */
  public tickSource(source: ITickSource): this {
    this._setTickSource(source);
    return this;
  }

  private _setTickSource(source: ITickSource): void {
    this._tickSource = source;
    this._registerChain(source);
  }

  private _registerChain(source: ITickSource): void {
    if (source === ALWAYS_TICK_SOURCE) {
      return;
    }
    this.world._registerTickSource(source);
    if (source instanceof RateTickSource && source._source) {
      this._registerChain(source._source);
    }
  }

  /**
   * Assign this system to a pipeline phase.
   *
   * Pass either a phase name (resolved at {@link World.start}) or an
   * {@link IPhase} reference returned from {@link World.addPhase}. Systems
   * with no explicit phase fall into the built-in `"update"` phase.
   *
   * @param p - Phase name or `IPhase` reference.
   * @returns This system, for chaining.
   * @throws When the phase reference is not a `Phase`, or belongs to a
   *   different world.
   */
  public phase(p: string | IPhase): this {
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

  /**
   * Register a per-tick callback fired every time this system's phase runs,
   * regardless of entity membership.
   *
   * Use it for logic that is not driven by component changes — polling,
   * network flushing, global timers, etc.
   *
   * @param callback - Receives `now` (absolute timestamp in ms) and `delta`
   *   (ms since the previous tick). If the system has an active interval,
   *   rate, or tick source, `delta` is the accumulated milliseconds since this
   *   system last fired.
   * @returns This system, for chaining.
   */
  public run(callback: RunCallback): this {
    this._runCallback = callback;
    return this;
  }

  /**
   * Register a callback fired **every tick** for **every tracked entity**,
   * unconditionally, with the listed components resolved from each entity.
   *
   * Unlike {@link update} (which only fires when `component.modified()` is
   * called), `each` fires every tick the system runs, once per tracked entity.
   * Components declared via {@link requires} are non-nullable in the resolved
   * tuple; any other component class may be `undefined` if the entity lacks it.
   *
   * `each` does **not** modify the system's query — define membership with
   * {@link requires} or {@link query} as usual. It does, however, implicitly
   * enable {@link track}, so matched entities are exposed via {@link entities}.
   *
   * Only one `each` callback may be registered per system; calling `each` a
   * second time throws.
   *
   * @param components - Component classes to resolve from each entity.
   * @param callback - Receives the entity and a tuple of resolved component
   *   instances (`undefined` for any not covered by {@link requires}).
   * @returns This system, for chaining.
   * @throws When `each` has already been registered on this system.
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
    if (this._eachCallback) {
      throw `each already registered for system '${this.name}'`;
    }
    this.track();
    const types = components.map((C) => this.world.getComponentType(C));
    this._eachCallback = (e: Entity) => {
      const resolved = types.map((t) => e.get(t));
      callback(e, resolved as any);
    };
    return this;
  }

  /**
   * Set the entity-membership predicate using a {@link QueryDSL} expression.
   *
   * Replaces any implicit query derived from `update` watchlists and any
   * previous `requires` call. After calling `query`, watchlist auto-expansion
   * via `update` is disabled.
   *
   * The optional `_guaranteed` tuple is a pure type-level hint — see
   * {@link Query.query} for details.
   *
   * @param q - Query expression.
   * @param _guaranteed - Component classes guaranteed present on every matched
   *   entity (type hint only — not validated at runtime).
   * @returns This system, retyped with the guaranteed tuple as its `R`.
   */
  public override query<T extends (typeof Component)[] = []>(
    q: QueryDSL,
    _guaranteed?: readonly [...T]
  ): System<T> {
    super.query(q, _guaranteed);
    return this as unknown as System<T>;
  }

  /**
   * Shorthand for `query([...components])` — tracks entities that have **all**
   * of the listed component types.
   *
   * Equivalent to `query({ HAS: components })`. The listed components are also
   * recorded in the type parameter `R`, so {@link sort}, {@link each}, and
   * {@link update} callbacks treat them as non-nullable.
   *
   * @param components - Component classes to require.
   * @returns This system, retyped with the required tuple as its `R`.
   */
  public override requires<T extends (typeof Component)[]>(...components: [...T]): System<T> {
    super.requires(...components);
    return this as unknown as System<T>;
  }

  /**
   * Disable this system.
   *
   * While disabled the system is effectively invisible: the inbox is cleared
   * immediately, any new `enter`, `exit`, or `update` events are silently
   * dropped, and {@link _run} returns without executing any callbacks. Entity
   * membership in the underlying query is still maintained so the tracked set
   * remains consistent and the system resumes correctly when
   * {@link enable} is called.
   *
   * Disabling is independent from tick-source cadence: `disable` suppresses
   * callbacks, but a disabled system used as a tick source still drives
   * downstream consumers. Use `stop()` on an external `IntervalTickSource` or
   * `RateTickSource` reference to halt that clock itself.
   *
   * Calling `disable` on an already-disabled system is a no-op.
   *
   * @returns This system, for chaining.
   *
   * @example
   * ```ts
   * const sys = world.system("AI").requires(Enemy).run(runAI);
   * // Pause AI processing during a cutscene:
   * sys.disable();
   * // Resume:
   * sys.enable();
   * ```
   */
  public disable(): this {
    this._enabled = false;
    this._inbox.length = 0;
    return this;
  }

  /**
   * Enable this system after a previous {@link disable} call.
   *
   * Once re-enabled the system resumes its normal tick behaviour: enter, exit,
   * and update events are queued, and {@link _run} processes the inbox and fires
   * all registered callbacks. Events that occurred while the system was disabled
   * are not replayed.
   *
   * Calling `enable` on an already-enabled system is a no-op.
   *
   * @returns This system, for chaining.
   */
  public enable(): this {
    this._enabled = true;
    return this;
  }

  /**
   * Not supported on `System`. Throws unconditionally.
   *
   * Systems are owned by the world for the duration of the session; if you
   * need a temporary reactive set use a standalone {@link Query} via
   * {@link World.query}.
   */
  public override destroy(): never {
    throw `destroy() is not supported on System '${this.name}'`;
  }
}
