/**
 * A `Map<number, T>` backed by a sparse JavaScript array.
 *
 * For small, dense integer key spaces this is significantly faster than
 * `Map` because array index access avoids the hash-table overhead. Used
 * internally to store per-entity component instances and per-type component
 * metadata.
 *
 * Keys must be non-negative integers. Gaps in the key space are represented
 * as `undefined` slots and do not count toward `size`.
 *
 * @typeParam T - The value type stored in the map.
 */
export class ArrayMap<T> {
  private backend: (T | undefined)[];
  private _size: number;

  constructor() {
    this.backend = [];
    this._size = 0;
  }

  /**
   * Store `value` at `key`, replacing any existing value.
   *
   * @param key - Non-negative integer key.
   * @param value - Value to store.
   */
  set(key: number, value: T): void {
    if (this.backend[key] === undefined) {
      this._size++;
    }
    this.backend[key] = value;
  }

  /**
   * Return the value stored at `key`, or `undefined` if not present.
   *
   * @param key - Non-negative integer key.
   */
  get(key: number): T | undefined {
    return this.backend[key];
  }

  /**
   * Remove the entry at `key`. Does nothing if `key` is not present.
   *
   * @param key - Non-negative integer key.
   */
  delete(key: number): void {
    if (this.backend[key] !== undefined) {
      this.backend[key] = undefined;
      this._size--;
    }
  }

  /**
   * Return `true` if an entry exists at `key`.
   *
   * @param key - Non-negative integer key.
   */
  has(key: number): boolean {
    return this.backend[key] !== undefined;
  }

  /**
   * Iterate over all present entries.
   *
   * Undefined slots are skipped; the callback is only called for keys that
   * have an associated value.
   *
   * @param callback - Called with `(value, key, map)` for each entry.
   */
  forEach(callback: (value: T, key: number, map: ArrayMap<T>) => void): void {
    this.backend.forEach((value, index) => {
      if (value !== undefined) {
        callback(value, index, this);
      }
    });
  }

  /**
   * Remove all entries and reset the size to zero.
   */
  clear() {
    this.backend.length = 0;
  }

  /** The number of entries currently in the map. */
  get size(): number {
    return this._size;
  }
}
