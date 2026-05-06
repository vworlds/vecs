import { type World } from "./world.js";

/** A clock that the world evaluates once per frame. */
export interface ITickSource {
  /** True when this source fired during the current frame. */
  readonly didTick: boolean;
  /** Milliseconds accumulated into the most recent fire. */
  readonly lastFireDelta: number;
  /** @internal Register this source and any upstream sources with a world. */
  _register(world: World): void;
  /** @internal Evaluate this source for the given frame. */
  _evalTick(deltaMs: number, frameId: number): boolean;
}

/** Shared state and start/stop control for concrete tick sources. */
abstract class BaseTickSource implements ITickSource {
  /** @internal */
  protected _didTick = false;
  /** @internal */
  protected _running = true;
  /** @internal */
  protected _lastEvaluatedFrame = -1;
  /** @internal */
  protected _timeSinceLastTick = 0;
  /** @internal Delta accumulated into the most recent tick, in milliseconds. */
  public _lastFireDelta = 0;

  public get didTick(): boolean {
    return this._didTick;
  }

  public get lastFireDelta(): number {
    return this._lastFireDelta;
  }

  /** Resume this source without replaying time elapsed while stopped. */
  public start(): this {
    this._running = true;
    return this;
  }

  /** Pause this source, freezing accumulators and counters until `start()`. */
  public stop(): this {
    this._running = false;
    return this;
  }

  /** @internal Evaluate this source once for `frameId`. */
  public abstract _evalTick(deltaMs: number, frameId: number): boolean;

  /** @internal Register this source with `world`. */
  public _register(world: World): void {
    world._registerTickSource(this);
  }
}

/** Fires every `intervalSeconds` of accumulated wall-clock time. */
export class IntervalTickSource extends BaseTickSource {
  private readonly _intervalMs: number;
  private _accumulator = 0;

  /**
   * Create an interval source.
   *
   * Intervals are expressed in seconds, unlike `World.progress` and
   * `World.beginFrame`, which receive millisecond deltas. Large deltas produce
   * at most one tick; residual time is preserved by subtracting the interval.
   *
   * @param intervalSeconds - Positive interval duration in seconds.
   * @throws When `intervalSeconds` is less than or equal to zero.
   */
  public constructor(intervalSeconds: number) {
    super();
    if (intervalSeconds <= 0) {
      throw "interval seconds must be greater than 0";
    }
    this._intervalMs = intervalSeconds * 1000;
  }

  /** @internal */
  public _evalTick(deltaMs: number, frameId: number): boolean {
    if (this._lastEvaluatedFrame === frameId) {
      return this._didTick;
    }
    this._lastEvaluatedFrame = frameId;
    if (!this._running) {
      this._didTick = false;
      return false;
    }

    this._timeSinceLastTick += deltaMs;
    this._accumulator += deltaMs;
    let fired = false;
    if (this._accumulator >= this._intervalMs) {
      this._accumulator -= this._intervalMs;
      fired = true;
      this._lastFireDelta = this._timeSinceLastTick;
      this._timeSinceLastTick = 0;
    }
    this._didTick = fired;
    return fired;
  }
}

/** Fires every `rate` ticks of `source`, or every `rate` frames without one. */
export class RateTickSource extends BaseTickSource {
  private readonly _rate: number;
  /** @internal Upstream source for chain registration. */
  public readonly _source: ITickSource | undefined;
  private _counter = 0;

  /**
   * Create a rate filter.
   *
   * Without `source`, this counts world frames. With `source`, it counts ticks
   * from that upstream clock. The source is immutable, so cyclic source graphs
   * cannot be constructed through the public API.
   *
   * @param rate - Positive integer tick divisor.
   * @param source - Optional upstream source to divide.
   * @throws When `rate` is not a positive integer.
   */
  public constructor(rate: number, source?: ITickSource) {
    super();
    if (!Number.isInteger(rate) || rate <= 0) {
      throw "rate must be a positive integer";
    }
    this._rate = rate;
    this._source = source;
  }

  /** @internal */
  public _evalTick(deltaMs: number, frameId: number): boolean {
    if (this._lastEvaluatedFrame === frameId) {
      return this._didTick;
    }
    this._lastEvaluatedFrame = frameId;
    if (!this._running) {
      this._didTick = false;
      return false;
    }

    const upstreamFired = this._source ? this._source._evalTick(deltaMs, frameId) : true;
    const upstreamDelta = this._source ? this._source.lastFireDelta : deltaMs;

    let fired = false;
    if (upstreamFired) {
      this._timeSinceLastTick += upstreamDelta;
      this._counter++;
      if (this._counter >= this._rate) {
        this._counter = 0;
        fired = true;
        this._lastFireDelta = this._timeSinceLastTick;
        this._timeSinceLastTick = 0;
      }
    }
    this._didTick = fired;
    return fired;
  }

  /** @internal */
  public override _register(world: World): void {
    super._register(world);
    this._source?._register(world);
  }
}

/** @internal Singleton source used by systems with no explicit cadence. */
class _AlwaysTickSource implements ITickSource {
  private _lastDelta = 0;

  public get didTick(): boolean {
    return true;
  }

  public get lastFireDelta(): number {
    return this._lastDelta;
  }

  /** @internal */
  public _evalTick(deltaMs: number, _frameId: number): boolean {
    this._lastDelta = deltaMs;
    return true;
  }

  /** @internal */
  public _register(_world: World): void {}
}

/** @internal Shared default clock for unconfigured systems. */
export const ALWAYS_TICK_SOURCE: ITickSource = new _AlwaysTickSource();
