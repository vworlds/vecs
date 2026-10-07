/**
 * A deterministic discrete-event clock.
 *
 * The replication harness never waits for real time. Everything that would be
 * a timer or a network delay in production (the server tick, the client's ack
 * interval and render loop, a packet in flight) is an event on this clock, and
 * {@link SimClock.runUntil} pops them in timestamp order, setting
 * {@link SimClock.now} to each event's time before running it. Events that share
 * a timestamp run in the order they were scheduled, so a run is reproducible
 * from its seed alone.
 */
export class SimClock {
  /** Current virtual time in milliseconds. */
  public now = 0;

  private readonly _queue: ScheduledEvent[] = [];
  private _nextSequence = 0;

  /** Run `run` once when the clock reaches `atMs`. */
  public schedule(atMs: number, run: () => void): void {
    const event: ScheduledEvent = { atMs, sequence: this._nextSequence++, run };
    this._queue.push(event);
    this._siftUp(this._queue.length - 1);
  }

  /**
   * Run `run` every `periodMs`, starting at `firstAtMs`.
   *
   * Occurrences are computed as `firstAtMs + n * periodMs` rather than by
   * accumulating, so a 1000 / 30 ms period does not drift.
   *
   * @returns A function that stops the repetition.
   */
  public every(
    periodMs: number,
    run: () => void,
    firstAtMs: number = this.now + periodMs
  ): () => void {
    let cancelled = false;
    let occurrences = 0;
    const fire = (): void => {
      if (cancelled) {
        return;
      }
      run();
      occurrences++;
      this.schedule(firstAtMs + occurrences * periodMs, fire);
    };
    this.schedule(firstAtMs, fire);
    return () => {
      cancelled = true;
    };
  }

  /** Advance virtual time by `durationMs`, running every event that falls due. */
  public runFor(durationMs: number): void {
    this.runUntil(this.now + durationMs);
  }

  /** Advance virtual time to `endMs`, running every event due at or before it. */
  public runUntil(endMs: number): void {
    while (this._queue.length > 0 && this._queue[0].atMs <= endMs) {
      const next = this._queue[0];
      this._pop();
      this.now = Math.max(this.now, next.atMs);
      next.run();
    }
    this.now = Math.max(this.now, endMs);
  }

  private _pop(): void {
    const last = this._queue.pop();
    if (this._queue.length === 0 || last === undefined) {
      return;
    }
    this._queue[0] = last;
    this._siftDown(0);
  }

  private _siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!isBefore(this._queue[index], this._queue[parent])) {
        return;
      }
      this._swap(index, parent);
      index = parent;
    }
  }

  private _siftDown(start: number): void {
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let first = index;
      if (left < this._queue.length && isBefore(this._queue[left], this._queue[first])) {
        first = left;
      }
      if (right < this._queue.length && isBefore(this._queue[right], this._queue[first])) {
        first = right;
      }
      if (first === index) {
        return;
      }
      this._swap(index, first);
      index = first;
    }
  }

  private _swap(a: number, b: number): void {
    const held = this._queue[a];
    this._queue[a] = this._queue[b];
    this._queue[b] = held;
  }
}

interface ScheduledEvent {
  atMs: number;
  sequence: number;
  run: () => void;
}

function isBefore(a: ScheduledEvent, b: ScheduledEvent): boolean {
  return a.atMs < b.atMs || (a.atMs === b.atMs && a.sequence < b.sequence);
}
