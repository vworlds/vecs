import { type ComponentInstance, type ComponentType } from "./component.js";
import {
  Iter,
  makeInjectedInvoker,
  normalizeFanInjectCallbackArgs,
  type FanInjectCallbackArg,
  type FanInjectTuple,
  type InjectedCallback,
  type InjectSnapshot,
  type MaybeResolvedInjectTuple,
  type ClockInject,
  type InjectClock,
} from "./inject.js";
import { SOURCE_TRACKED_QUERY_ERROR, Query } from "./query/index.js";
import type {
  EntityCursorOption,
  FanInjectCallbackOptions,
  IterCursorOption,
} from "./query/options.js";
import {
  containsDownTerm,
  type ExtractSpecsRequired,
  type QueryConfig,
  type QuerySpec,
} from "./dsl.js";
import { Entity, type EID } from "./entity/index.js";
import { ON_UPDATE, Phase } from "./modules/pipeline.js";
import { DependsOn } from "./modules/relationships.js";
import { OrderedSet } from "./util/ordered_set.js";
import { type World } from "./world/index.js";
import {
  ALWAYS_TICK_SOURCE,
  IntervalTickSource,
  type ITickSource,
  RateTickSource,
} from "./timer.js";

export type { QueryDSL as SystemQuery, EntityTestFunc } from "./dsl.js";

type RunCallback = (now: number, delta: number) => void;
/** A callback kind supported by a system. */
export type SystemCallbackKind = "each" | "run" | "enter" | "update" | "exit";
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
  | {
      kind: InboxCommand.Enter;
      entity: Entity;
      snapshot: InjectSnapshot | undefined;
    }
  | {
      kind: InboxCommand.Exit;
      entity: Entity;
      snapshot: InjectSnapshot | undefined;
    }
  | {
      kind: InboxCommand.Update;
      entity: Entity;
      eid: EID;
      component: ComponentInstance;
    };

/**
 * A reactive processor running over a filtered subset of world entities.
 *
 * Systems are created and configured through {@link World.system}:
 *
 * ```ts
 * world.system("Move")
 *   .with(Position, Velocity)       // track entities with both components
 *   .enter([Position], (e, [pos]) => { pos.x = 0; })
 *   .update(Position, (e, pos) => { pos.x += pos.vx; })
 *   .exit((e) => { console.log("entity left", e.eid); });
 * ```
 *
 * Every builder method returns `this` for chaining. Systems are inserted into
 * the world's pipeline the next time {@link World.progress} runs.
 *
 * Internally each system holds a single ordered **inbox** of routed events
 * (`enter`, `exit`, `update`). The world appends to it during command-queue
 * routing; the system replays the inbox at the top of every `_run` so
 * callbacks observe events in arrival order. An `enter` only dispatches when
 * the entity remains a member at drain time; its paired `exit` is suppressed
 * when that `enter` was skipped.
 *
 * ### Component injection and type inference
 *
 * `enter`, `exit`, `update`, `each`, and `orderBy` accept an array of component
 * classes resolved from the entity and passed as a typed tuple to the
 * callback.
 *
 * Components declared via {@link with} (or the `hint` field of a
 * {@link QueryConfig}) are tracked as the type parameter `R`. Inside `orderBy`,
 * `each`, and `update` injection callbacks they are non-nullable; any other
 * component remains `Type | undefined`.
 *
 * @typeParam R - Component classes guaranteed present on every matched entity.
 */
export class System<R extends ComponentType[] = []>
  extends Query<R, ClockInject>
  implements ITickSource
{
  /** @internal Processing tick timestamp; stable fields on all systems. */
  public _injectNow = 0;
  /** @internal Processing tick delta, including cadence accumulation. */
  public _injectDelta = 0;
  /** @internal Single inbox replayed in arrival order on every `_run`. */
  private readonly _inbox: _SystemInboxEvent[] = [];
  /**
   * @internal Set when any entity exits this system during the current inbox
   * window (between drains). Gates the stale-update membership probe in
   * {@link _runDeferred}: steady-state frames with no exits skip it entirely.
   * Reset alongside the inbox after each drain.
   */
  private _exitedSinceDrain = false;
  /** @internal Callback registered via {@link run}, fired every tick. */
  private _runCallback: RunCallback | undefined = undefined;
  /** @internal Callback registered via {@link each}, fired per tracked entity every tick. */
  protected _eachCallback: ((e: Entity) => void) | undefined = undefined;

  /** @internal Whether this system processes events and runs callbacks. */
  private _enabled = true;
  /** @internal Cadence source for this system. Defaults to every frame. */
  private _tickSource: ITickSource;

  constructor(name: string, world: World) {
    super(name, world, false);
    this._tickSource = world.alwaysTickSource;
    this._queuesUpdates = true;
    this.entity.attach(System, this);
    this.phase(ON_UPDATE);
  }

  /** Whether this system processes events and runs callbacks. */
  public get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Current cadence clock. Use {@link hasDefaultCadence} to recognise
   * the default every-frame cadence; interval/rate configuration replaces it.
   */
  public get cadence(): ITickSource {
    // Deprecation window: report the legacy constant for the world's default clock.
    return this.hasDefaultCadence ? ALWAYS_TICK_SOURCE : this._tickSource;
  }

  /**
   * True when this system runs on its world's every-frame clock, i.e. no
   * interval, rate or tick source was configured. Prefer this over comparing
   * {@link cadence} by identity.
   */
  public get hasDefaultCadence(): boolean {
    return this._tickSource === this.world.alwaysTickSource;
  }

  /**
   * Callback kinds registered on this system. The returned list is a frozen
   * snapshot and reflects registrations immediately, before or after build.
   */
  public get callbacks(): readonly SystemCallbackKind[] {
    const callbacks: SystemCallbackKind[] = [];
    if (this._eachCallback !== undefined) {
      callbacks.push("each");
    }
    if (this._runCallback !== undefined) {
      callbacks.push("run");
    }
    if (this._enterCallback !== undefined) {
      callbacks.push("enter");
    }
    if (this._componentUpdateCallbacks.size > 0) {
      callbacks.push("update");
    }
    if (this._exitCallback !== undefined) {
      callbacks.push("exit");
    }
    return Object.freeze(callbacks);
  }

  /** Component classes watched by registered `update` callbacks. */
  public get watched(): readonly ComponentType[] {
    const watched: ComponentType[] = [];
    this._watchlistBitmask.forEach((eid) => {
      if (this._componentUpdateCallbacks.get(eid) !== undefined) {
        watched.push(this.world.entity(eid).meta.Class as ComponentType);
      }
    });
    return Object.freeze(watched);
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
   * update callbacks that opted into entry-time dispatch into inbox `update`
   * events on entry.
   *
   * Target relationship reactivity is handled by `TargetTerm`; systems only
   * translate root-term membership events into inbox commands here.
   */
  protected override _enter(e: Entity): void {
    this.changed = true;
    this._entities?.add(e);
    e._addQueryMembership(this);
    if (!this._enabled) {
      return;
    }
    if (this._enterCallback !== undefined) {
      const enterSnapshot = this._enterSnapshotter?.(e);
      this._inbox.push({ kind: InboxCommand.Enter, entity: e, snapshot: enterSnapshot });
    }
    for (const ceid of this._onEnterUpdateEids) {
      const c = e._get(ceid);
      if (c === undefined) {
        continue;
      }
      if (this._componentUpdateCallbacks.get(ceid) === undefined) {
        continue;
      }
      // Entry-time initialization bypasses the silence filter: an entity
      // introduced by an ignored source must still initialize in this system.
      this._pushUpdate(e, ceid, c);
    }
  }

  /**
   * @internal Routing entry: deregister query membership for `e` and push an
   * inbox `exit` event when an `exit` callback is registered, capturing a
   * snapshot of the components the callback wants to inject so they remain
   * resolvable after the underlying components are removed.
   */
  protected override _exit(e: Entity): void {
    this.changed = true;
    this._entities?.delete(e);
    e._removeQueryMembership(this);
    if (!this._enabled) {
      return;
    }
    // Mark that membership shrank this window so the inbox drain knows to probe
    // updates for staleness.
    this._exitedSinceDrain = true;
    if (this._exitCallback !== undefined) {
      const exitSnapshot = this._exitSnapshotter?.(e);
      this._inbox.push({ kind: InboxCommand.Exit, entity: e, snapshot: exitSnapshot });
    }
  }

  /**
   * @internal Routing entry: push an inbox `update` event when the modified
   * component matches the watchlist and its source is not silenced.
   */
  public override _notifyModified(e: Entity, ceid: EID, c: ComponentInstance): void {
    if (!this._watchlistBitmask.has(ceid)) {
      return;
    }
    if (this._orderByWatch?.has(ceid) && this._entities instanceof OrderedSet) {
      this._entities.markDirty();
    }
    if (!this._enabled) {
      return;
    }
    if (this._isSourceSilenced()) {
      return;
    }
    this.changed = true;
    if (this._componentUpdateCallbacks.get(ceid) === undefined) {
      return;
    }
    this._pushUpdate(e, ceid, c);
  }

  /** @internal Append an `update` event to the inbox, bypassing the silence filter. */
  private _pushUpdate(e: Entity, ceid: EID, c: ComponentInstance): void {
    this._inbox.push({ kind: InboxCommand.Update, entity: e, eid: ceid, component: c });
  }

  /**
   * @internal Execute one tick: drain the inbox in arrival order, then run
   * the `run` callback, then the `each` callback for every tracked entity.
   *
   * When callbacks have work, the body executes inside a `World.defer` scope;
   * mutations land in the world queue and are processed when `_run` returns.
   * An empty inbox with no `run` callback and no populated `each` query bypasses
   * that scope, after updating the injection clock and without changing cadence.
   * Returns whether the enabled and cadence gates admitted execution, even
   * when a reactive system has no pending events or an each query is empty.
   */
  public _run(now: number, delta: number): boolean {
    if (!this._enabled) {
      return false;
    }
    if (!this._tickSource.didTick) {
      return false;
    }
    const tickDelta = this._tickSource.lastFireDelta;
    this._injectNow = now;
    this._injectDelta = tickDelta;
    if (
      this._inbox.length === 0 &&
      this._runCallback === undefined &&
      (this._eachCallback === undefined || this.count === 0)
    ) {
      return true;
    }
    const prevSource = this.world._currentSource;
    this.world._currentSource = this.entity;
    try {
      this._runDeferred(now, tickDelta);
    } finally {
      this.world._currentSource = prevSource;
    }
    return true;
  }

  /**
   * @internal Drain the inbox and fire callbacks inside a deferred scope, with
   * this system credited as the source of any mutations made by callbacks.
   */
  private _runDeferred(now: number, tickDelta: number): void {
    this.world.defer(() => {
      let suppressedEnters: Set<Entity> | undefined;
      for (let i = 0; i < this._inbox.length; i++) {
        const event = this._inbox[i];
        switch (event.kind) {
          case InboxCommand.Enter:
            // Stale-event guard: an Enter queued for an entity that has since
            // left this system (destroyed, or lost a `.with` component) before
            // this inbox drained must not dispatch. Enter callbacks commonly
            // create related state, so dispatching one for a non-member leaves
            // that state orphaned. A stale enter is only possible when something
            // exited this window, so `_exitedSinceDrain` gates the O(1)
            // membership probe and steady-state frames pay nothing. The probe is
            // `belongs()` (the root term's own O(1) membership), not
            // `_isMemberOf()`: enter/exit-only systems are not in the entity's
            // `_queries` set, and widening that set would tax every enter/exit
            // and every component-update routing pass. A re-entered
            // ("came back") entity is a member again here, so its enter still
            // fires. Suppress its paired exit because the enter never ran.
            if (this._exitedSinceDrain && !this.belongs(event.entity)) {
              (suppressedEnters ??= new Set()).add(event.entity);
              break;
            }
            this._enterCallback!(event.entity, event.snapshot);
            break;
          case InboxCommand.Exit:
            if (suppressedEnters?.delete(event.entity)) {
              break;
            }
            this._exitCallback!(event.entity, event.snapshot);
            break;
          case InboxCommand.Update:
            // Stale-event guard: an Update queued for an entity that has since
            // left this system (destroyed, or lost a `.with` component) before
            // this inbox drained must not dispatch. Its injected `.with` reads
            // are resolved lazily at dispatch time and would now resolve to
            // `undefined`, crashing callbacks that assume the guaranteed
            // components are present. A stale update is only possible when
            // something exited this window, so `_exitedSinceDrain` gates the
            // O(1) membership probe and steady-state frames pay nothing. A
            // re-entered ("came back") entity is a member again here, so its
            // update still fires. Exit events fire regardless — they carry
            // their own snapshot.
            if (this._exitedSinceDrain && !this.belongs(event.entity)) {
              break;
            }
            const callback = this._componentUpdateCallbacks.get(event.eid);
            if (callback) {
              callback(event.entity, event.component);
            }
            break;
        }
      }
      this._inbox.length = 0;
      this._exitedSinceDrain = false;

      if (this._runCallback) {
        this._runCallback(now, tickDelta);
      }

      if (this._eachCallback) {
        this._forEach(this._eachCallback);
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

  /** Place this system after a phase entity in the world pipeline. */
  public phase(phase: Entity | string): this {
    this._assertConfigurable();
    const target = (typeof phase === "string" ? this.world.entity(phase) : phase).add(Phase);
    this.entity.add(DependsOn, target);
    return this;
  }

  /**
   * Run this system at a fixed interval, expressed in seconds.
   *
   * This is seconds, unlike `World.beginFrame` and `World.progress`, which
   * receive millisecond deltas. Calling `interval` replaces
   * the current cadence source with an {@link IntervalTickSource}. When this
   * system has a cadence source, the `delta` passed to {@link run} is the
   * accumulated milliseconds since the previous fire, not the per-frame delta.
   * Interval boundaries allow a relative tolerance of 1e-9 for floating-point
   * frame-delta residue, clamping any negative remainder to zero. Large deltas
   * still produce at most one fire per frame and preserve positive residual time.
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
    this._setTickSource(
      new RateTickSource(n, source ? this._resolveSource(source) : this._tickSource)
    );
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

  /** Map the deprecated module constant to this system's world clock. */
  private _resolveSource(source: ITickSource): ITickSource {
    return source === ALWAYS_TICK_SOURCE ? this.world.alwaysTickSource : source;
  }

  private _setTickSource(source: ITickSource): void {
    this._tickSource = this._resolveSource(source);
    this._tickSource._register(this.world);
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
   * Unlike {@link update} (which fires when a watched component's data is set
   * or marked modified), `each` fires every tick the system runs, once per
   * tracked entity.
   * Components declared via {@link with} are non-nullable in the resolved
   * tuple; any other component class may be `undefined` if the entity lacks it.
   * `Now` and `Delta` tokens resolve to non-optional numbers from this processing
   * tick, with the same accumulated delta as `run`.
   *
   * `each` does **not** modify the system's query — define membership with
   * {@link with} as usual. It does, however, implicitly
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
   *   instances (`undefined` for any not covered by {@link with}).
   * @returns This system, for chaining.
   * @throws When `each` has already been registered on this system.
   *
   * @example
   * ```ts
   * world.system("Move")
   *   .with(Position, Velocity)
   *   .each([Position, Velocity], (e, [pos, vel]) => {
   *     pos.x += vel.vx;
   *     pos.y += vel.vy;
   *   });
   * ```
   */
  public each<const J extends FanInjectTuple>(
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;

  /**
   * As above, but pass `{ cursor: Entity, inject: [...] }` to make the
   * entity-first signature explicit. Identical behavior to the array form.
   */
  public each<const J extends FanInjectTuple>(
    options: EntityCursorOption & FanInjectCallbackOptions<J>,
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;

  /**
   * As above, but pass `{ cursor: Iter, inject: [...] }` to receive a reused
   * {@link Iter} cursor instead of the bare entity. The cursor exposes the
   * visited entity (`it.entity`) and, in `it.src`, the source entity each
   * resolved component was read from (the visited entity for direct components,
   * the relationship target for `target`-injected ones).
   */
  public each<const J extends FanInjectTuple>(
    options: IterCursorOption & FanInjectCallbackOptions<J>,
    callback: (it: Iter, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): this;

  public each(arg0: FanInjectCallbackArg, arg1?: Function): this {
    this._assertConfigurable();
    if (this._eachCallback) {
      throw new Error(`each already registered for system '${this.name}'`);
    }
    this.track();
    const { components, useIter } = normalizeFanInjectCallbackArgs(arg0);
    const callback = arg1 as InjectedCallback;
    this._eachCallback = makeInjectedInvoker(this.world, components, useIter, callback, this);
    return this;
  }

  /**
   * Add entity-membership predicates using {@link QuerySpec} expressions.
   *
   * Merges with any existing predicate using `all`. `update` callbacks also
   * add their watched component to the predicate.
   *
   * `hint` fields are pure type-level hints — see {@link Query.with} for details.
   *
   * @param specs - Query specifications to add.
   * @returns This system, retyped with the guaranteed components added to `R`.
   */
  public override with<const S extends readonly QuerySpec[]>(
    ...specs: [...S]
  ): System<[...R, ...ExtractSpecsRequired<S>]> {
    super.with(...specs);
    return this as unknown as System<any>;
  }

  /**
   * Systems cannot use groupBy. Use `world.query(...).groupBy(...)` instead.
   */
  public override groupBy(..._args: any[]): never {
    throw new Error("System does not support groupBy; use world.query(...).groupBy(...)");
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
   * const sys = world.system("AI").with(Enemy).run(runAI);
   * // Pause AI processing during a cutscene:
   * sys.disable();
   * // Resume:
   * sys.enable();
   * ```
   */
  public disable(): this {
    this._enabled = false;
    this._inbox.length = 0;
    this._exitedSinceDrain = false;
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

  /** @internal Used only while registering injecting callbacks. */
  protected override _getInjectClock(): InjectClock {
    return this;
  }
}
