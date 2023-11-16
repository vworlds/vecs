export class Bitset {
  private bits: number;

  constructor() {
    this.bits = 0;
  }

  add(n: number): void {
    this.bits |= 1 << n;
  }

  delete(n: number): void {
    this.bits &= ~(1 << n);
  }

  has(n: number): boolean {
    return (this.bits & (1 << n)) !== 0;
  }

  forEach(callback: (n: number) => void): void {
    let currentBits = this.bits;
    for (let i = 0; i < 32; i++) {
      if ((currentBits & 1) !== 0) {
        callback(i);
      }
      currentBits >>= 1;
    }
  }
}
