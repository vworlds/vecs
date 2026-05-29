import { type ComponentInstance, type ComponentMeta, type ComponentType } from "./component.js";
import {
  isCursorMarker,
  Iter,
  makeInjectedInvoker,
  wantsIter,
  type FanInjectElement,
  type FanInjectTuple,
  type MaybeResolvedInjectTuple,
} from "./inject.js";
import { SOURCE_TRACKED_QUERY_ERROR, Query, type MaybeRequired } from "./query.js";
import { containsDownTerm, type QueryDSL } from "./dsl.js";
import { ChildOf, SilenceSource } from "./relationship.js";
import { Entity } from "./entity/index.js";
import { Phase, type IPhase } from "./phase.js";
import { type World } from "./world/index.js";
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
  | {
      kind: InboxCommand.Exit;
      entity: Entity;
      snapshot: Map<number, ComponentInstance> | undefined;
    }
  | {
      kind: InboxCommand.Update;
      entity: Entity;
      meta: ComponentMeta;
      component: ComponentInstance;
    };

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
 *   .update(Position, (e, pos) => { pos.x += pos.vx; })
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
 * callback.
 *
 * Components declared via {@link requires} (or the `_guaranteed` argument of
 * {@link query}) are tracked as the type parameter `R`. Inside `sort`,
 * `each`, and `update` injection callbacks they are non-nullable; any other
 * component remains `Type | undefined`.
 *
 * @typeParam R - Component classes guaranteed present on every matched entity.
 */
export class System<R extends ComponentType[] = []> extends Query<R> implements ITickSource {
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
  /** @internal Silence-domain query: `update` events whose source is a member are dropped. */
  private _silenceQuery: Query | undefined;

  constructor(name: string, world: World) {
    super(name, world, false);
    this.entity.attach(System, this);
  }

  /** @internal Reject non-reactive source/children terms before registering this system. */
  public override _build(): this {
    if (this._dsl !== undefined && containsDownTerm(this._dsl)) {
      this.destroy();
      throw new Error(SOURCE_TRACKED_QUERY_ERROR);
    }
    return super._build() as this;
  }

  /** @internal Systems may be run-only processors without entity membership. */
  protected override _isBuildable(): boolean {
    return true;
  }

  /**
   * @internal Routing entry: register query membership for `e`, push an
   * inbox `enter` event when an `enter` callback is registered, and bridge
   * watched components through {@link _notifyModified} to surface them as
   * inbox `update` events on entry.
   *
   * Target relationship reactivity is handled by `TargetTerm`; systems only
   * translate root-term membership events into inbox commands here.
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
    e.components.forEach((c, eid) => {
      const meta = this.world.entity(eid).ownMeta;
      if (this._watchlistBitmask.hasBit(meta.bitPtr)) {
        // Entry-time initialization bypasses the silence filter: an entity
        // introduced by an ignored source must still initialize in this system.
        this._pushUpdate(e, meta, c);
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
      let snapshot: Map<number, ComponentInstance> | undefined;
      if (this._exitSnapshotTypes && this._exitSnapshotTypes.length > 0) {
        snapshot = new Map<number, ComponentInstance>();
        for (const eid of this._exitSnapshotTypes) {
          const c = e._get(eid);
          if (c) {
            snapshot.set(eid, c);
          }
        }
      }
      this._inbox.push({ kind: InboxCommand.Exit, entity: e, snapshot });
    }
  }

  /**
   * @internal Routing entry: push an inbox `update` event when the modified
   * component matches the watchlist and its source is not silenced.
   */
  public override _notifyModified(e: Entity, meta: ComponentMeta, c: ComponentInstance): void {
    if (!this._enabled || !this._watchlistBitmask.hasBit(meta.bitPtr)) {
      return;
    }
    const source = this.world._routingSource;
    if (source !== undefined && this._silenceQuery?.has(source)) {
      return;
    }
    this._pushUpdate(e, meta, c);
  }

  /** @internal Append an `update` event to the inbox, bypassing the silence filter. */
  private _pushUpdate(e: Entity, meta: ComponentMeta, c: ComponentInstance): void {
    this._inbox.push({ kind: InboxCommand.Update, entity: e, meta, component: c });
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
    const prevSource = this.world._currentSource;
    this.world._currentSource = this.entity;
    try {
      this._runDeferred(now, tickDelta);
    } finally {
      this.world._currentSource = prevSource;
    }
  }

  /**
   * @internal Drain the inbox and fire callbacks inside a deferred scope, with
   * this system credited as the source of any mutations made by callbacks.
   */
  private _runDeferred(now: number, tickDelta: number): void {
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
            const callback = this._componentUpdateCallbacks.get(event.meta.eid);
            if (callback) {
              callback(event.entity, event.component);
            }
            break;
        }
      }
      this._inbox.length = 0;

      if (this._runCallback) {
        this._runCallback(now, tickDelta);
      }

      if (this._eachCallback) {
        this.forEach(this._eachCallback);
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

  /** @internal Register this system source and its current cadence source. */
  public _register(world: World): void {
    world._registerTickSource(this);
    this._tickSource._register(world);
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
    this._assertConfigurable();
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
    this._assertConfigurable();
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
    this._assertConfigurable();
    this._setTickSource(source);
    return this;
  }

  private _setTickSource(source: ITickSource): void {
    this._tickSource = source;
    source._register(this.world);
  }

  /** @internal Build a tracked silence-domain query from `dsl`, tied to this system's lifetime. */
  private _buildSilenceQuery(dsl: QueryDSL): Query {
    const query = this.world.query(`${this.name}:silence`).query(dsl);
    query.entity.set(ChildOf, { target: this.entity });
    return query;
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
    this._assertConfigurable();
    if (typeof p !== "string") {
      if (!(p instanceof Phase)) {
        throw new Error("Invalid Phase object");
      }
      if (p.world !== this.world) {
        throw new Error("Phase does not belong to this system's world");
      }
    }
    this._phase = p;
    return this;
  }

  /**
   * Ignore `update` notifications produced by a set of source systems,
   * preventing read/writeback feedback loops.
   *
   * Every component mutation is credited to the entity of the system that made
   * it. `ignoreSource` declares a **silence domain** as a query over those
   * source entities: any `update` whose source is a member of the query is
   * dropped before it reaches this system's inbox. Mutations made outside any
   * system (gameplay code) have no source and always wake the system.
   *
   * Pass a {@link QueryDSL} to define the domain inline — a fresh tracked query
   * is created and tied to this system's lifetime via {@link ChildOf}. Pass an
   * existing {@link Query} to reuse its membership directly. To silence a
   * system's own writeback, include its entity in the domain (for example, tag
   * the participating system entities with a marker component and match it).
   *
   * Calling `ignoreSource` again replaces the previous domain. Entry-time
   * initialization is never silenced. Call during setup, before
   * {@link World.start}; the inline-DSL form builds a query, which cannot
   * happen while a frame is in progress.
   *
   * @param source - A {@link QueryDSL} domain expression or an existing
   *   {@link Query} whose members are the silenced sources.
   * @returns This system, for chaining.
   *
   * @example
   * ```ts
   * // Tag every physics system entity, then have the reader ignore that domain.
   * const integrate = world.system("Integrate").requires(Position, Velocity)
   *   .each([Position, Velocity], (e, [p, v]) => { p.x += v.vx; });
   * integrate.entity.add(Physics);
   *
   * world.system("PhysicsRead").requires(Position)
   *   .ignoreSource([Physics])
   *   .update(Position, reactToExternalChange);
   * ```
   */
  public ignoreSource(source: QueryDSL | Query): this {
    this._assertConfigurable();
    const query = source instanceof Query ? source : this._buildSilenceQuery(source);
    this.entity.set(SilenceSource, { target: query.entity });
    this._silenceQuery = query;
    return this;
  }

  /** @internal Drop the silence-domain query cache after the relationship is removed. */
  public _clearSilence(): void {
    this._silenceQuery = undefined;
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
    this._assertConfigurable();
    this._runCallback = callback;
    return this;
  }

  /**
   * Register a callback fired **every tick** for **every tracked entity**,
   * unconditionally, with the listed components resolved from each entity.
   *
   * Unlike {@link update} (which only fires when `entity.modified(C)` is
   * called), `each` fires every tick the system runs, once per tracked entity.
   * Components declared via {@link requires} are non-nullable in the resolved
   * tuple; any other component class may be `undefined` if the entity lacks it.
   *
   * `each` does **not** modify the system's query — define membership with
   * {@link requires} or {@link query} as usual. It does, however, implicitly
   * enable {@link track}, so matched entities are exposed via {@link count},
   * {@link has}, iteration, and {@link forEach}.
   *
   * Only one `each` callback may be registered per system; calling `each` a
   * second time throws.
   *
   * The resolved tuple is a single array reused for every entity each tick;
   * treat it as valid only for the duration of the callback. The component
   * instances it holds are stable — do not retain the tuple array itself.
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
  public each<J extends FanInjectTuple>(
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;

  /**
   * As above, but pass `Entity` first to make the entity-first signature
   * explicit. Identical behavior to the no-marker form.
   */
  public each<J extends FanInjectTuple>(
    cursor: typeof Entity,
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;

  /**
   * As above, but pass `Iter` first to receive a reused {@link Iter}
   * cursor instead of the bare entity. The cursor exposes the visited entity
   * (`it.entity`) and, in `it.src`, the source entity each resolved component
   * was read from (the visited entity for direct components, the relationship
   * target for `up`-injected ones).
   */
  public each<J extends FanInjectTuple>(
    cursor: typeof Iter,
    components: readonly [...J],
    callback: (it: Iter, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;

  public each(arg0: unknown, arg1?: unknown, arg2?: unknown): this {
    this._assertConfigurable();
    if (this._eachCallback) {
      throw new Error(`each already registered for system '${this.name}'`);
    }
    this.track();
    const useIter = wantsIter(arg0);
    const components = (isCursorMarker(arg0) ? arg1 : arg0) as readonly FanInjectElement[];
    const callback = (isCursorMarker(arg0) ? arg2 : arg1) as (
      eOrIt: unknown,
      resolved: unknown
    ) => void;
    this._eachCallback = makeInjectedInvoker(this.world, components, useIter, callback);
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
  public override query<T extends ComponentType[] = []>(
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
   * Equivalent to `query(components)`. The listed components are also
   * recorded in the type parameter `R`, so {@link sort}, {@link each}, and
   * {@link update} callbacks treat them as non-nullable.
   *
   * @param components - Component classes to require.
   * @returns This system, retyped with the required tuple as its `R`.
   */
  public override requires<T extends ComponentType[]>(...components: [...T]): System<T> {
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

  /** Permanently remove this system from the world. */
  public override destroy(): void {
    this.disable();
    super.destroy();
  }
}
