// Debug-warning de-duplication. Each (entity, code) pair warns at most once
// until it is re-armed, so a persistent structural problem logs once rather
// than every step. Re-arming lets a fixed-then-rebroken structure warn again.

/** Receives a fully formatted warning line. Defaults to `console.warn`. */
export type WarnSink = (message: string) => void;

export class WarnDedupe {
  /** entity eid -> set of issue codes already warned for that entity. */
  private readonly _warned = new Map<number, Set<string>>();

  private readonly _sink: WarnSink;

  public constructor(sink: WarnSink = (message) => console.warn(message)) {
    this._sink = sink;
  }

  /**
   * Emit a warning for `(eid, code)` unless it has already been warned.
   *
   * @returns `true` if the warning was emitted (first occurrence), `false` if
   *   it was suppressed as a duplicate.
   */
  public warnOnce(eid: number, code: string, message: string): boolean {
    let codes = this._warned.get(eid);
    if (codes === undefined) {
      codes = new Set();
      this._warned.set(eid, codes);
    }
    if (codes.has(code)) {
      return false;
    }
    codes.add(code);
    this._sink(`[vecs-physics] ${code}: ${message}`);
    return true;
  }

  /** Re-arm a `(eid, code)` pair so its next {@link warnOnce} emits again. */
  public rearm(eid: number, code: string): void {
    this._warned.get(eid)?.delete(code);
  }

  /** True when `(eid, code)` has been warned and not since re-armed. */
  public has(eid: number, code: string): boolean {
    return this._warned.get(eid)?.has(code) ?? false;
  }

  /** Forget all warnings. */
  public clear(): void {
    this._warned.clear();
  }
}
