export class Rng {
  private _state: number;

  constructor(seed: number) {
    this._state = seed >>> 0;
  }

  bool(probability = 0.5): boolean {
    return this.float() < probability;
  }

  choice<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  float(): number {
    this._state = (this._state + 0x6d2b79f5) >>> 0;
    let t = this._state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }

  signed(maxMagnitude: number): number {
    return this.range(-maxMagnitude, maxMagnitude);
  }
}
