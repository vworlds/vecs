import { type World } from "./world.js";

/** A timer or system-like object that can provide a {@link TickSource}. */
export type TickSourceInput = TickSource | { _asTickSource(): TickSource };

/** @internal Normalize a timer or system into its underlying tick source. */
export function resolveTickSource(source: TickSourceInput): TickSource {
  return source instanceof TickSource ? source : source._asTickSource();
}

/**
 * Shared cadence source for timers and systems.
 *
 * Intervals use seconds at the public API boundary and accumulate millisecond
 * deltas internally. Rates count ticks from their upstream source.
 */
export class TickSource {
  private _intervalMs: number | undefined;
  private _rate: number | undefined;
  private _source: TickSource | undefined;
  private _running = true;
  private _accumulator = 0;
  private _counter = 0;
  private _didTick = false;
  /** @internal Delta accumulated into the most recent tick, in milliseconds. */
  public _lastFireDelta = 0;
  private _timeSinceLastTick = 0;
  private _lastEvaluatedFrame = -1;

  /**
   * Fire at a fixed interval, expressed in seconds.
   *
   * This is intentionally seconds, unlike `World.progress` and `runPhase`,
   * which receive millisecond deltas. Calling `interval` clears any configured
   * rate and upstream source; the last cadence setter wins.
   *
   * Large frame deltas produce at most one tick. Residual time is carried by
   * subtracting the interval instead of zeroing the accumulator, preserving
   * long-term cadence without replaying missed ticks.
   *
   * @param seconds - Positive interval duration in seconds.
   * @returns This tick source, for chaining.
   * @throws When `seconds` is less than or equal to zero.
   *
   * @example
   * ```ts
   * const second = world.timer("second").interval(1.0);
   * ```
   */
  public interval(seconds: number): this {
    if (seconds <= 0) {
      throw "interval seconds must be greater than 0";
    }
    this._intervalMs = seconds * 1000;
    this._rate = undefined;
    this._source = undefined;
    return this;
  }

  /**
   * Fire every `n` ticks from this source's upstream clock.
   *
   * Without a `source`, this counts world frames. With a `source`, it counts
   * ticks from that timer or system. Calling `rate` clears any fixed interval.
   * When called without `source`, it also clears the upstream source; when
   * called with `source`, that source becomes the upstream clock.
   *
   * @param n - Positive integer tick divisor.
   * @returns This tick source, for chaining.
   * @throws When `n` is not a positive integer, or when `source` would create
   *   a cyclic tick-source graph.
   *
   * @example
   * ```ts
   * const minute = world.timer("minute").rate(60, second);
   * ```
   */
  public rate(n: number): this;
  public rate(n: number, source: TickSourceInput): this;
  public rate(n: number, source?: TickSourceInput): this {
    this._validateRate(n);
    if (source) {
      const tickSource = resolveTickSource(source);
      this._assertNoCycle(tickSource);
      this._source = tickSource;
    }
    this._rate = n;
    this._intervalMs = undefined;
    return this;
  }

  /**
   * Mirror another timer or system tick source.
   *
   * Calling `tickSource` clears any fixed interval or rate; the last cadence
   * setter wins. Use `rate(n, source)` when this source should divide another
   * source rather than mirror it directly.
   *
   * @param source - Timer or system-like source to mirror.
   * @returns This tick source, for chaining.
   * @throws When `source` would create a cyclic tick-source graph.
   *
   * @example
   * ```ts
   * const shared = world.timer("network").interval(0.25);
   * world.timer("snapshot").tickSource(shared);
   * ```
   */
  public tickSource(source: TickSourceInput): this {
    const tickSource = resolveTickSource(source);
    this._assertNoCycle(tickSource);
    this._source = tickSource;
    this._intervalMs = undefined;
    this._rate = undefined;
    return this;
  }

  /**
   * Resume this source after {@link stop}.
   *
   * Accumulators and counters resume from their frozen values; elapsed wall
   * time while stopped does not create a catch-up burst.
   *
   * @returns This tick source, for chaining.
   *
   * @example
   * ```ts
   * timer.stop();
   * timer.start();
   * ```
   */
  public start(): this {
    this._running = true;
    return this;
  }

  /**
   * Pause this source's clock.
   *
   * While stopped, the accumulator and rate counter are frozen. Resuming with
   * {@link start} continues from the frozen state without catch-up ticks.
   *
   * @returns This tick source, for chaining.
   *
   * @example
   * ```ts
   * const timer = world.timer().interval(1);
   * timer.stop();
   * ```
   */
  public stop(): this {
    this._running = false;
    return this;
  }

  /** @internal Evaluate this source once per frame. */
  public _evalTick(now: number, deltaMs: number, frameId: number): boolean {
    void now;
    if (this._lastEvaluatedFrame === frameId) {
      return this._didTick;
    }
    this._lastEvaluatedFrame = frameId;

    if (!this._running) {
      this._didTick = false;
      return false;
    }

    const upstreamFired = this._source ? this._source._evalTick(now, deltaMs, frameId) : true;
    const upstreamDelta = this._source ? this._source._lastFireDelta : deltaMs;
    if (upstreamFired) {
      this._timeSinceLastTick += upstreamDelta;
    }

    let fired = false;
    if (this._intervalMs !== undefined) {
      if (upstreamFired) {
        this._accumulator += upstreamDelta;
        if (this._accumulator >= this._intervalMs) {
          this._accumulator -= this._intervalMs;
          fired = true;
        }
      }
    } else if (this._rate !== undefined) {
      if (upstreamFired) {
        this._counter++;
        if (this._counter >= this._rate) {
          this._counter = 0;
          fired = true;
        }
      }
    } else {
      fired = upstreamFired;
    }

    this._didTick = fired;
    if (fired) {
      this._lastFireDelta = this._timeSinceLastTick;
      this._timeSinceLastTick = 0;
    }
    return fired;
  }

  private _validateRate(n: number): void {
    if (!Number.isInteger(n) || n <= 0) {
      throw "rate must be a positive integer";
    }
  }

  private _assertNoCycle(source: TickSource): void {
    let current: TickSource | undefined = source;
    while (current) {
      if (current === this) {
        throw "tick source cycle detected";
      }
      current = current._source;
    }
  }
}

/**
 * A named world-owned tick source.
 *
 * Timers have no phase and no entity query. They live for the world's lifetime
 * and can drive systems or other timers through {@link tickSource} and
 * {@link rate}.
 */
export class Timer extends TickSource {
  public readonly name: string;

  /**
   * Create a timer and register it with a world.
   *
   * Prefer {@link World.timer} in user code so unnamed timers receive a useful
   * generated name.
   *
   * @param name - Display name for debugging.
   * @param world - World that owns and evaluates this timer.
   */
  public constructor(name: string, world: World) {
    super();
    this.name = name;
    world._registerTickSource(this);
  }
}
