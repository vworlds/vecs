/**
 * A `Map<number, T>` substitute backed by a sparse JavaScript array.
 *
 * For small, dense, non-negative integer key spaces, indexing into a regular
 * array is faster than the hash-table lookups performed by the built-in
 * `Map`. `ArrayMap` is used inside the ECS to store per-entity component
 * instances and per-type metadata.
 *
 * Empty slots are represented as `undefined` and do not count toward
 * {@link size}.
 *
 * @internal Used only inside the package.
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

  /**
   * Visit every present entry in ascending key order. Empty slots are skipped.
   *
   * @param callback - Invoked with `(value, key, map)` for each entry.
   */
  public forEach(callback: (value: T, key: number, map: ArrayMap<T>) => void): void {
    const backend = this._backend;
    for (let i = 0; i < backend.length; i++) {
      const value = backend[i];
      if (value !== undefined) {
        callback(value, i, this);
      }
    }
  }

  /** Remove all entries and reset {@link size} to zero. */
  public clear(): void {
    this._backend.length = 0;
    this._size = 0;
  }
}

/**
 * Read-only view of an {@link ArrayMap}: the mutating methods `set`, `delete`,
 * and `clear` are omitted.
 *
 * @typeParam T - Value type stored in the map.
 */
export type ReadonlyArrayMap<T> = Omit<ArrayMap<T>, "set" | "delete" | "clear">;
