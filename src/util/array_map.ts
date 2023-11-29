export class ArrayMap<T> {
  private backend: (T | undefined)[];
  private _size: number;

  constructor() {
    this.backend = [];
    this._size = 0;
  }

  set(key: number, value: T): void {
    if (this.backend[key] === undefined) {
      this._size++;
    }
    this.backend[key] = value;
  }

  get(key: number): T | undefined {
    return this.backend[key];
  }

  delete(key: number): void {
    if (this.backend[key] !== undefined) {
      this.backend[key] = undefined;
      this._size--;
    }
  }

  has(key: number): boolean {
    return this.backend[key] !== undefined;
  }

  forEach(callback: (value: T, key: number, map: ArrayMap<T>) => void): void {
    this.backend.forEach((value, index) => {
      if (value !== undefined) {
        callback(value, index, this);
      }
    });
  }

  clear() {
    this.backend.length = 0;
  }

  get size(): number {
    return this._size;
  }
}
