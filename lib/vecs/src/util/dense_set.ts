/**
 * A `Set<T>` whose members are kept in a dense backing array so iteration is a
 * tight indexed loop rather than a hash-table walk.
 *
 * Membership is tracked in a side `Map<T, number>` that records each element's
 * slot, so `add` is a push and `delete` swaps the last element into the vacated
 * slot and pops — both O(1) and without the tombstone slots a churned native
 * `Set` accumulates. The swap means iteration order is **not** insertion order
 * after a deletion; that is fine for query membership, whose order is
 * unspecified unless `Query.orderBy` is used (which keeps an {@link OrderedSet}
 * instead).
 *
 * @internal Used only inside the package.
 *
 * @typeParam T - Element type stored in the set.
 */
export class DenseSet<T> implements Set<T> {
  private readonly _items: T[] = [];
  private readonly _slot = new Map<T, number>();

  /** Number of elements currently stored. */
  public get size(): number {
    return this._items.length;
  }

  /** Tag used by `Object.prototype.toString` for stringification. */
  public get [Symbol.toStringTag](): string {
    return "DenseSet";
  }

  /** Insert `value` if not already present. */
  public add(value: T): this {
    if (!this._slot.has(value)) {
      this._slot.set(value, this._items.length);
      this._items.push(value);
    }
    return this;
  }

  /** Return `true` when `value` is a member. */
  public has(value: T): boolean {
    return this._slot.has(value);
  }

  /**
   * Remove `value`. Returns `true` if it was present. The last element is
   * swapped into the vacated slot, so surviving order may change.
   */
  public delete(value: T): boolean {
    const i = this._slot.get(value);
    if (i === undefined) {
      return false;
    }
    const last = this._items.pop()!;
    if (last !== value) {
      this._items[i] = last;
      this._slot.set(last, i);
    }
    this._slot.delete(value);
    return true;
  }

  /** Remove every element. */
  public clear(): void {
    this._items.length = 0;
    this._slot.clear();
  }

  /** Visit each element (current order) without allocating an iterator. */
  public forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: unknown): void {
    const items = this._items;
    for (let i = 0; i < items.length; i++) {
      callbackfn.call(thisArg, items[i], items[i], this);
    }
  }

  /** Iterator over elements in current order. */
  public [Symbol.iterator](): IterableIterator<T> {
    return this._items[Symbol.iterator]();
  }

  /** Iterator yielding `[value, value]` pairs. */
  public *entries(): IterableIterator<[T, T]> {
    for (const item of this._items) {
      yield [item, item];
    }
  }

  /** Iterator over elements in current order. */
  public keys(): IterableIterator<T> {
    return this._items[Symbol.iterator]();
  }

  /** Iterator over elements in current order. */
  public values(): IterableIterator<T> {
    return this._items[Symbol.iterator]();
  }
}
