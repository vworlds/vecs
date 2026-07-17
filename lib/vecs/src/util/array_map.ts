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
 * Random access resolves `key -> dense index` through {@link ArrayMap}, then
 * indexes into `_items`; iteration walks the dense `_items` array directly.
 *
 * Deletes keep `_items` dense by moving the last value into the removed slot
 * and updating the moved value's stored index.
 *
 * Compared with {@link ArrayMap}, this costs extra memory for tuple storage and
 * an index map, and `delete`/new `set` do more bookkeeping. In return, iteration
 * is dense and does not scan sparse holes.
 *
 * @typeParam T - Value type stored in the map.
 */
export class IterableArrayMap<T> {
  private readonly _indices = new ArrayMap<number>();
  private readonly _items: Array<readonly [number, T]> = [];

  /** The number of entries currently in the map. */
  public get size(): number {
    return this._items.length;
  }

  /**
   * Insert or replace the value at `key`.
   *
   * @param key - Non-negative integer key.
   * @param value - Value to store.
   */
  public set(key: number, value: T): void {
    const existingIndex = this._indices.get(key);
    if (existingIndex !== undefined) {
      this._items[existingIndex] = [key, value];
      return;
    }

    const index = this._items.length;
    this._indices.set(key, index);
    this._items.push([key, value]);
  }

  /**
   * Retrieve the value stored at `key`, or `undefined` if no entry exists.
   *
   * @param key - Non-negative integer key.
   */
  public get(key: number): T | undefined {
    const index = this._indices.get(key);
    return index === undefined ? undefined : this._items[index][1];
  }

  /**
   * Return `true` when an entry exists at `key`.
   *
   * @param key - Non-negative integer key.
   */
  public has(key: number): boolean {
    return this._indices.has(key);
  }

  /**
   * Remove the entry at `key`. Does nothing if no entry exists there.
   *
   * @param key - Non-negative integer key.
   */
  public delete(key: number): void {
    const index = this._indices.get(key);
    if (index === undefined) {
      return;
    }

    const lastIndex = this._items.length - 1;
    if (index !== lastIndex) {
      const lastItem = this._items[lastIndex];
      this._items[index] = lastItem;
      const lastKey = lastItem[0];
      this._indices.set(lastKey, index);
    }

    this._items.pop();
    this._indices.delete(key);
  }

  /**
   * Visit every present entry in dense item order.
   *
   * @param callback - Invoked with `(value, key, map)` for each entry.
   */
  public forEach(callback: (value: T, key: number, map: IterableArrayMap<T>) => void): void {
    const items = this._items;
    for (let i = 0; i < items.length; i++) {
      const [key, value] = items[i];
      callback(value, key, this);
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
    const items = this._items;
    for (let i = 0; i < items.length; i++) {
      const [key, value] = items[i];
      callback(value, key, this);
      if (i < items.length && items[i][0] !== key) {
        i--;
      }
    }
  }

  /**
   * Return an iterator over `[key, value]` entries in dense item order.
   *
   * Entries are backed by the map's internal storage for speed. Treat them as
   * immutable; mutating them through casts or plain JavaScript can corrupt the
   * map's key index.
   */
  public entries(): IterableIterator<readonly [number, T]> {
    return this._items.values();
  }

  /** Return an iterator over `[key, value]` entries in dense item order. */
  public [Symbol.iterator](): IterableIterator<readonly [number, T]> {
    return this.entries();
  }

  /** Return every present value in dense item order. */
  public values(): T[] {
    return this._items.map(([, value]) => value);
  }

  /** Remove all entries and reset {@link size} to zero. */
  public clear(): void {
    this._indices.clear();
    this._items.length = 0;
  }
}

/**
 * Read-only view of an {@link IterableArrayMap}: the mutating methods `set`, `delete`,
 * and `clear` are omitted.
 *
 * @typeParam T - Value type stored in the map.
 */
export type ReadonlyIterableArrayMap<T> = Omit<IterableArrayMap<T>, "set" | "delete" | "clear">;
