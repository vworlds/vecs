export class OrderedSet<T> implements Set<T> {
  private items: T[];
  private readonly compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.items = [];
    this.compare = compare;
  }

  private bisect(value: T): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(this.items[mid], value) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  add(value: T): this {
    const i = this.bisect(value);
    if (i < this.items.length && this.compare(this.items[i], value) === 0) {
      return this;
    }
    this.items.splice(i, 0, value);
    return this;
  }

  has(value: T): boolean {
    const i = this.bisect(value);
    return i < this.items.length && this.compare(this.items[i], value) === 0;
  }

  delete(value: T): boolean {
    const i = this.bisect(value);
    if (i < this.items.length && this.compare(this.items[i], value) === 0) {
      this.items.splice(i, 1);
      return true;
    }
    return false;
  }

  clear(): void {
    this.items.length = 0;
  }

  get size(): number {
    return this.items.length;
  }

  forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: unknown): void {
    for (const item of this.items) {
      callbackfn.call(thisArg, item, item, this);
    }
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.items[Symbol.iterator]();
  }

  *entries(): IterableIterator<[T, T]> {
    for (const item of this.items) {
      yield [item, item];
    }
  }

  keys(): IterableIterator<T> {
    return this.items[Symbol.iterator]();
  }

  values(): IterableIterator<T> {
    return this.items[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return "OrderedSet";
  }
}
