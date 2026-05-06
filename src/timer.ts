import { type World } from "./world.js";

export type TickSourceInput = TickSource | { _asTickSource(): TickSource };

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

  public interval(seconds: number): this {
    if (seconds <= 0) {
      throw "interval seconds must be greater than 0";
    }
    this._intervalMs = seconds * 1000;
    this._rate = undefined;
    this._source = undefined;
    return this;
  }

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

  public tickSource(source: TickSourceInput): this {
    const tickSource = resolveTickSource(source);
    this._assertNoCycle(tickSource);
    this._source = tickSource;
    this._intervalMs = undefined;
    this._rate = undefined;
    return this;
  }

  public start(): this {
    this._running = true;
    return this;
  }

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

/** A named world-owned tick source. */
export class Timer extends TickSource {
  public readonly name: string;

  public constructor(name: string, world: World) {
    super();
    this.name = name;
    world._registerTickSource(this);
  }
}
