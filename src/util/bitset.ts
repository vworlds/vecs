export class Bitset {
  private bits: number[];

  constructor() {
    this.bits = [];
  }

  addIndexBitmask(arrayIndex: number, bitmask: number) {
    this.bits[arrayIndex] |= bitmask;
  }

  addBit(bptr: BitPtr) {
    this.addIndexBitmask(bptr.arrayIndex, bptr.bitmask);
  }

  add(n: number): void {
    const arrayIndex = Math.floor(n / 32);
    const bitmask = 1 << n % 32;
    this.addIndexBitmask(arrayIndex, bitmask);
  }

  delete(n: number): void {
    const arrayIndex = Math.floor(n / 32);
    const current = this.bits[arrayIndex];
    if (current === undefined) {
      return;
    } else {
      const bitIndex = n % 32;
      this.bits[arrayIndex] = current & (1 << bitIndex);
    }
    while (this.bits.length && this.bits[this.bits.length - 1] === 0)
      this.bits.pop();
  }

  hasIndexBitmask(arrayIndex: number, bitmask: number) {
    return (this.bits[arrayIndex] & bitmask) !== 0;
  }

  hasBit(bptr: BitPtr) {
    return this.hasIndexBitmask(bptr.arrayIndex, bptr.bitmask);
  }

  has(n: number): boolean {
    const arrayIndex = Math.floor(n / 32);
    if (arrayIndex >= this.bits.length) return false;
    const bitIndex = n % 32;
    const bitmask = 1 << bitIndex;
    return this.hasIndexBitmask(arrayIndex, bitmask);
  }

  hasBitset(other: Bitset): boolean {
    if (this.bits.length < other.bits.length) {
      return false;
    }

    for (let i = 0; i < other.bits.length; i++) {
      if ((this.bits[i] & other.bits[i]) !== other.bits[i]) {
        return false;
      }
    }

    return true;
  }

  forEach(callback: (n: number) => void): void {
    this.bits.forEach((b, j) => {
      for (let i = 0; i < 32; i++) {
        if ((b & 1) !== 0) {
          callback(i + j * 32);
        }
        b >>= 1;
      }
    });
  }
}

export class BitPtr {
  public readonly arrayIndex: number;
  public readonly bitmask: number;
  constructor(n: number) {
    this.arrayIndex = Math.floor(n / 32);
    this.bitmask = 1 << n % 32;
  }
  public equals(other: BitPtr) {
    return this.arrayIndex == other.arrayIndex && this.bitmask == other.bitmask;
  }
}
