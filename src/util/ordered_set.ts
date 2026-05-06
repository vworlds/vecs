/**
 * A `Set<T>` whose iteration order is determined by a comparator instead of
 * insertion order.
 *
 * Backed by a sorted array. Insertions and lookups are `O(log n)` (binary
 * search) plus the cost of an array splice on `add` / `delete`.
 *
 * Used by `Query.sort` to keep matched entities in a user-defined order so
 * iteration in `forEach` and `each` walks them sorted.
 *
 * @internal Used only inside the package.
 *
 * @typeParam T - Element type stored in the set.
 */
export class OrderedSet<T> implements Set<T> {
  private _items: T[] = [];
  private readonly _compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this._compare = compare;
  }

  /**
   * Return the index where `value` should be inserted to keep the array
   * sorted (binary search; mirrors Python's `bisect_left`).
   */
  private _bisect(value: T): number {
    let lo = 0;
    let hi = this._items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._compare(this._items[mid], value) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** Number of elements currently stored. */
  public get size(): number {
    return this._items.length;
  }

  /** Tag used by `Object.prototype.toString` for stringification. */
  public get [Symbol.toStringTag](): string {
    return "OrderedSet";
  }

  /**
   * Insert `value` at the position determined by the comparator. No-op when
   * an element compares equal to `value`.
   *
   * @param value - Element to insert.
   */
  public add(value: T): this {
    const i = this._bisect(value);
    if (i < this._items.length && this._compare(this._items[i], value) === 0) {
      return this;
    }
    this._items.splice(i, 0, value);
    return this;
  }

  /**
   * Return `true` when an element comparing equal to `value` is in the set.
   *
   * @param value - Element to look up.
   */
  public has(value: T): boolean {
    const i = this._bisect(value);
    return i < this._items.length && this._compare(this._items[i], value) === 0;
  }

  /**
   * Remove the element comparing equal to `value`. Returns `true` if an
   * element was removed.
   *
   * @param value - Element to remove.
   */
  public delete(value: T): boolean {
    const i = this._bisect(value);
    if (i < this._items.length && this._compare(this._items[i], value) === 0) {
      this._items.splice(i, 1);
      return true;
    }
    return false;
  }

  /** Remove every element. */
  public clear(): void {
    this._items.length = 0;
  }

  /**
   * Visit each element in sorted order.
   *
   * @param callbackfn - Invoked with `(value, value, set)` for each element
   *   (`Set` interface compatibility — both arguments are the same value).
   * @param thisArg - Optional `this` binding for the callback.
   */
  public forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: unknown): void {
    for (const item of this._items) {
      callbackfn.call(thisArg, item, item, this);
    }
  }

  /** Iterator over elements in sorted order. */
  public [Symbol.iterator](): IterableIterator<T> {
    return this._items[Symbol.iterator]();
  }

  /** Iterator yielding `[value, value]` pairs in sorted order. */
  public *entries(): IterableIterator<[T, T]> {
    for (const item of this._items) {
      yield [item, item];
    }
  }

  /** Iterator over elements in sorted order. */
  public keys(): IterableIterator<T> {
    return this._items[Symbol.iterator]();
  }

  /** Iterator over elements in sorted order. */
  public values(): IterableIterator<T> {
    return this._items[Symbol.iterator]();
  }
}
