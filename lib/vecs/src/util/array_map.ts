/**
 * A cheap `Map<number, T>` substitute backed directly by a sparse JavaScript array.
 *
 * Use this when callers only need random access (`get`, `set`, `has`, `delete`)
 * by non-negative integer keys. Lookups are a single array read and memory usage
 * is one sparse backing array, so it is cheaper than {@link IterableArrayMap}.
 *
 * This does not support iteration. Sparse holes are skipped only implicitly by
 * `get`/`has`, and high key values can create a large sparse backing array.
 *
 * @typeParam T - Value type stored in the map.
 */
export class ArrayMap<T> {
  private _backend: (T | undefined)[] = [];
  private _size: number = 0;

  /** The number of entries currently in the map. */
  public get size(): number {
    return this._size;
  }

  /**
   * Insert or replace the value at `key`.
   *
   * @param key - Non-negative integer key.
   * @param value - Value to store.
   */
  public set(key: number, value: T): void {
    const backend = this._backend;
    if (backend[key] === undefined) {
      this._size++;
    }
    backend[key] = value;
  }

  /**
   * Retrieve the value stored at `key`, or `undefined` if no entry exists.
   *
   * @param key - Non-negative integer key.
   */
  public get(key: number): T | undefined {
    return this._backend[key];
  }

  /**
   * Return `true` when an entry exists at `key`.
   *
   * @param key - Non-negative integer key.
   */
  public has(key: number): boolean {
    return this._backend[key] !== undefined;
  }

  /**
   * Remove the entry at `key`. Does nothing if no entry exists there.
   *
   * @param key - Non-negative integer key.
   */
  public delete(key: number): void {
    const backend = this._backend;
    if (backend[key] !== undefined) {
      backend[key] = undefined;
      this._size--;
    }
  }

  /** Remove all entries and reset {@link size} to zero. */
  public clear(): void {
    this._backend.length = 0;
    this._size = 0;
  }
}

/**
 * An iterable `Map<number, T>` substitute backed by dense entries plus sparse indexes.
 *
 * Use this when callers need fast `forEach` or `values` over present entries.
 * Random access reads the entry's dense position from a sparse slot array
 * indexed by key, then reads the value from the dense value array; iteration
 * walks the dense key and value arrays directly.
 *
 * Deletes keep the dense arrays dense by moving the last entry into the removed
 * position and updating the moved entry's slot.
 *
 * Compared with {@link ArrayMap}, this costs extra memory for the dense arrays,
 * and `delete`/new `set` do more bookkeeping. In return, iteration is dense and
 * does not scan sparse holes.
 *
 * Trade-off: the dense arrays grow by `push`, so V8 cannot pretenure the entries
 * the way it pretenured the per-entry `[key, value]` literals of the previous
 * layout. A fresh process that creates tens of thousands of long-lived entities
 * in bulk and then destroys them is slower for it: 3–17% to create and 19–35%
 * to destroy 65,536 two-component entities. The gap comes from allocation-site
 * pretenuring, not extra work, and it reverses under
 * `node --no-allocation-site-pretenuring`. Lookups take two loads instead of
 * four, and the layout took about 9% off the steady-state tick of
 * `bench/sector-tick.ts`; `bench/README.md` has the measurements.
 *
 * @typeParam T - Value type stored in the map.
 */
export class IterableArrayMap<T> {
  /**
   * Key -> dense position + 1. Holes and `0` mean "absent", so the array only
   * ever holds small integers and lookups stay on V8's fast SMI elements path.
   */
  private readonly _slots: number[] = [];
  private readonly _keys: number[] = [];
  private readonly _values: T[] = [];

  /** The number of entries currently in the map. */
  public get size(): number {
    return this._keys.length;
  }

  /**
   * Insert or replace the value at `key`.
   *
   * @param key - Non-negative integer key.
   * @param value - Value to store.
   */
  public set(key: number, value: T): void {
    const slot = this._slots[key];
    if (slot > 0) {
      this._values[slot - 1] = value;
      return;
    }

    this._keys.push(key);
    this._values.push(value);
    this._slots[key] = this._keys.length;
  }

  /**
   * Retrieve the value stored at `key`, or `undefined` if no entry exists.
   *
   * @param key - Non-negative integer key.
   */
  public get(key: number): T | undefined {
    const slot = this._slots[key];
    return slot > 0 ? this._values[slot - 1] : undefined;
  }

  /**
   * Return `true` when an entry exists at `key`.
   *
   * @param key - Non-negative integer key.
   */
  public has(key: number): boolean {
    return this._slots[key] > 0;
  }

  /**
   * Remove the entry at `key`. Does nothing if no entry exists there.
   *
   * @param key - Non-negative integer key.
   */
  public delete(key: number): void {
    const slot = this._slots[key];
    if (!(slot > 0)) {
      return;
    }

    const keys = this._keys;
    const values = this._values;
    const lastIndex = keys.length - 1;
    if (slot - 1 !== lastIndex) {
      const lastKey = keys[lastIndex];
      keys[slot - 1] = lastKey;
      values[slot - 1] = values[lastIndex];
      this._slots[lastKey] = slot;
    }

    keys.pop();
    values.pop();
    this._slots[key] = 0;
  }

  /**
   * Visit every present entry in dense item order.
   *
   * @param callback - Invoked with `(value, key, map)` for each entry.
   */
  public forEach(callback: (value: T, key: number, map: IterableArrayMap<T>) => void): void {
    const keys = this._keys;
    const values = this._values;
    for (let i = 0; i < keys.length; i++) {
      callback(values[i], keys[i], this);
    }
  }

  /**
   * Visit every present entry tolerating deletion of the **current** entry
   * from inside the callback.
   *
   * `delete` swaps the last entry into the vacated slot, which the plain
   * {@link IterableArrayMap.forEach} would skip. This variant re-visits the
   * slot after the callback returns when a new entry has been swapped in, so
   * the swapped-in entry is visited next. Deleting the last entry (no swap,
   * slot just pops out of bounds) is detected via a length check.
   *
   * Only deletion of the current entry is safe. A callback that deletes a
   * *different* (lower-indexed) entry will still cause that swapped-in entry
   * to be skipped — callers that mutate other slots must keep using a
   * snapshot.
   */
  public forEachSafe(callback: (value: T, key: number, map: IterableArrayMap<T>) => void): void {
    const keys = this._keys;
    const values = this._values;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      callback(values[i], key, this);
      if (i < keys.length && keys[i] !== key) {
        i--;
      }
    }
  }

  /**
   * Return an iterator over `[key, value]` entries in dense item order.
   *
   * Each entry is a fresh pair read from the map's current contents as the
   * iterator advances.
   */
  public *entries(): IterableIterator<readonly [number, T]> {
    const keys = this._keys;
    const values = this._values;
    for (let i = 0; i < keys.length; i++) {
      yield [keys[i], values[i]];
    }
  }

  /** Return an iterator over `[key, value]` entries in dense item order. */
  public [Symbol.iterator](): IterableIterator<readonly [number, T]> {
    return this.entries();
  }

  /** Return every present value in dense item order. */
  public values(): T[] {
    return this._values.slice();
  }

  /** Remove all entries and reset {@link size} to zero. */
  public clear(): void {
    this._slots.length = 0;
    this._keys.length = 0;
    this._values.length = 0;
  }
}

/**
 * Read-only view of an {@link IterableArrayMap}: the mutating methods `set`, `delete`,
 * and `clear` are omitted.
 *
 * @typeParam T - Value type stored in the map.
 */
export type ReadonlyIterableArrayMap<T> = Omit<IterableArrayMap<T>, "set" | "delete" | "clear">;
