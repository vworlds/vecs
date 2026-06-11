/**
 * A `Set<T>` whose iteration order is determined by a comparator instead of
 * insertion order.
 *
 * Backed by a sorted array plus a side `Set<T>` for O(1) membership checks.
 * Insertions are `O(log n)` (binary search) plus the cost of an array splice.
 * Removal uses identity lookup because sorted values may be mutable.
 *
 * The backing array can go stale relative to the comparator: callers mark it
 * dirty with {@link markDirty} when data the comparator reads has changed.
 * The next order-dependent read re-sorts the whole array in place before
 * returning. `has` is unaffected by dirtiness — it always checks the side set.
 *
 * Used by `Query.orderBy` to keep matched entities in a user-defined order so
 * iteration in `forEach` and `each` walks them sorted.
 *
 * @internal Used only inside the package.
 *
 * @typeParam T - Element type stored in the set.
 */
export class OrderedSet<T> implements Set<T> {
  private _items: T[] = [];
  private readonly _members = new Set<T>();
  private readonly _compare: (a: T, b: T) => number;
  private _dirty = false;

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

  /** Re-sort the backing array in place when {@link markDirty} was called. */
  private _ensureSorted(): void {
    if (!this._dirty) {
      return;
    }
    this._items.sort(this._compare);
    this._dirty = false;
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
   * `value` is already a member.
   *
   * @param value - Element to insert.
   */
  public add(value: T): this {
    if (this._members.has(value)) {
      return this;
    }
    this._ensureSorted();
    const i = this._bisect(value);
    this._items.splice(i, 0, value);
    this._members.add(value);
    return this;
  }

  /**
   * Mark the backing array stale. The next order-dependent read re-sorts it
   * with the comparator before returning.
   */
  public markDirty(): void {
    this._dirty = true;
  }

  /**
   * Return `true` when `value` is a member of the set, regardless of sort
   * state. O(1) identity lookup against the side membership set.
   *
   * @param value - Element to look up.
   */
  public has(value: T): boolean {
    return this._members.has(value);
  }

  /** Remove `value` by identity. Returns `true` if an element was removed. */
  public delete(value: T): boolean {
    if (!this._members.delete(value)) {
      return false;
    }
    const i = this._items.indexOf(value);
    if (i !== -1) {
      this._items.splice(i, 1);
    }
    return true;
  }

  /** Remove every element. */
  public clear(): void {
    this._items.length = 0;
    this._members.clear();
    this._dirty = false;
  }

  /**
   * Visit each element in sorted order.
   *
   * @param callbackfn - Invoked with `(value, value, set)` for each element
   *   (`Set` interface compatibility — both arguments are the same value).
   * @param thisArg - Optional `this` binding for the callback.
   */
  public forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: unknown): void {
    this._ensureSorted();
    for (const item of this._items) {
      callbackfn.call(thisArg, item, item, this);
    }
  }

  /** Iterator over elements in sorted order. */
  public [Symbol.iterator](): IterableIterator<T> {
    this._ensureSorted();
    return this._items[Symbol.iterator]();
  }

  /** Iterator yielding `[value, value]` pairs in sorted order. */
  public *entries(): IterableIterator<[T, T]> {
    this._ensureSorted();
    for (const item of this._items) {
      yield [item, item];
    }
  }

  /** Iterator over elements in sorted order. */
  public keys(): IterableIterator<T> {
    this._ensureSorted();
    return this._items[Symbol.iterator]();
  }

  /** Iterator over elements in sorted order. */
  public values(): IterableIterator<T> {
    this._ensureSorted();
    return this._items[Symbol.iterator]();
  }
}
