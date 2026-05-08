/**
 * A compact, growable set of non-negative integers backed by an array of
 * 32-bit words.
 *
 * `Bitset` is the data structure the ECS uses to represent entity archetypes
 * (the set of component type ids attached to an entity) and watchlists
 * (the set of component types a query reacts to).
 *
 * It is exported in the public API so component data can use it for
 * compact bit-flag fields:
 *
 * ```ts
 * class Tags extends Component {
 *   tags = new Bitset();
 * }
 *
 * tags.tags.add(TAG_VISIBLE);
 * if (tags.tags.has(TAG_VISIBLE)) { ... }
 * ```
 */
export class Bitset {
  /** @internal Underlying word storage; exposed for tests. */
  public _bits: Uint32Array = new Uint32Array(0);

  private _ensureCapacity(arrayIndex: number): void {
    if (arrayIndex < this._bits.length) {
      return;
    }
    const bits = new Uint32Array(arrayIndex + 1);
    bits.set(this._bits);
    this._bits = bits;
  }

  /**
   * Set bit `n`.
   *
   * @param n - Non-negative integer bit index.
   */
  public add(n: number): void {
    const arrayIndex = n >>> 5;
    const bitmask = 1 << (n & 31);
    this._ensureCapacity(arrayIndex);
    this._bits[arrayIndex] |= bitmask;
  }

  /**
   * Set the bit described by `bptr` (fast path using a pre-computed
   * {@link BitPtr}).
   *
   * @param bptr - Pre-computed pointer to a bit position.
   */
  public addBit(bptr: BitPtr): void {
    this._ensureCapacity(bptr.arrayIndex);
    this._bits[bptr.arrayIndex] |= bptr.bitmask;
  }

  /**
   * Clear the bit described by `bptr` (fast path using a pre-computed
   * {@link BitPtr}). Storage is not compacted automatically; call
   * {@link compact} to trim trailing zero words when needed.
   *
   * @param bptr - Pre-computed pointer to a bit position.
   */
  public deleteBit(bptr: BitPtr): void {
    if (bptr.arrayIndex >= this._bits.length) {
      return;
    }
    this._bits[bptr.arrayIndex] &= ~bptr.bitmask;
  }

  /**
   * Clear bit `n`.
   *
   * @param n - Non-negative integer bit index.
   */
  public delete(n: number): void {
    const arrayIndex = n >>> 5;
    if (arrayIndex >= this._bits.length) {
      return;
    }
    this._bits[arrayIndex] &= ~(1 << (n & 31));
  }

  /**
   * Trim trailing zero words to recover memory.
   */
  public compact(): void {
    let length = this._bits.length;
    while (length > 0 && this._bits[length - 1] === 0) {
      length--;
    }
    if (length !== this._bits.length) {
      this._bits = this._bits.slice(0, length);
    }
  }

  /**
   * Return `true` when bit `n` is set.
   *
   * @param n - Non-negative integer bit index.
   */
  public has(n: number): boolean {
    const arrayIndex = n >>> 5;
    if (arrayIndex >= this._bits.length) {
      return false;
    }
    const bitmask = 1 << (n & 31);
    return this._hasIndexBitmask(arrayIndex, bitmask);
  }

  /**
   * Return `true` when the bit described by `bptr` is set (fast path).
   *
   * @param bptr - Pre-computed pointer to a bit position.
   */
  public hasBit(bptr: BitPtr): boolean {
    return this._hasIndexBitmask(bptr.arrayIndex, bptr.bitmask);
  }

  /**
   * Return `true` when this bitset and `other` have exactly the same bits set.
   *
   * @param other - Bitset to compare against.
   */
  public equal(other: Bitset): boolean {
    const thisBits = this._bits;
    const otherBits = other._bits;
    if (thisBits.length !== otherBits.length) {
      return false;
    }
    for (let i = 0; i < thisBits.length; i++) {
      if (thisBits[i] !== otherBits[i]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Return `true` when every bit set in `other` is also set in this bitset
   * (i.e. `other` is a subset of `this`).
   *
   * Used by the world to test whether an entity's archetype satisfies a
   * `HAS` query.
   *
   * @param other - Bitset whose set bits must all appear in this bitset.
   */
  public hasBitset(other: Bitset): boolean {
    const thisBits = this._bits;
    const otherBits = other._bits;
    const otherLen = otherBits.length;
    const thisLen = thisBits.length;

    if (thisLen < otherLen) {
      return false;
    }

    let i = 0;
    for (; i + 7 < otherLen; i += 8) {
      const w0 = otherBits[i];
      if (w0 !== 0 && (thisBits[i] & w0) !== w0) {
        return false;
      }
      const w1 = otherBits[i + 1];
      if (w1 !== 0 && (thisBits[i + 1] & w1) !== w1) {
        return false;
      }
      const w2 = otherBits[i + 2];
      if (w2 !== 0 && (thisBits[i + 2] & w2) !== w2) {
        return false;
      }
      const w3 = otherBits[i + 3];
      if (w3 !== 0 && (thisBits[i + 3] & w3) !== w3) {
        return false;
      }
      const w4 = otherBits[i + 4];
      if (w4 !== 0 && (thisBits[i + 4] & w4) !== w4) {
        return false;
      }
      const w5 = otherBits[i + 5];
      if (w5 !== 0 && (thisBits[i + 5] & w5) !== w5) {
        return false;
      }
      const w6 = otherBits[i + 6];
      if (w6 !== 0 && (thisBits[i + 6] & w6) !== w6) {
        return false;
      }
      const w7 = otherBits[i + 7];
      if (w7 !== 0 && (thisBits[i + 7] & w7) !== w7) {
        return false;
      }
    }

    for (; i < otherLen; i++) {
      const otherWord = otherBits[i];
      if (otherWord !== 0 && (thisBits[i] & otherWord) !== otherWord) {
        return false;
      }
    }
    return true;
  }

  /**
   * Visit each set bit index in ascending order.
   *
   * @param callback - Invoked once per set bit.
   */
  public forEach(callback: (n: number) => void): void {
    const bits = this._bits;
    for (let j = 0, len = bits.length; j < len; j++) {
      let w = bits[j];
      while (w !== 0) {
        const lsb = w & -w;
        callback((j << 5) + (31 - Math.clz32(lsb >>> 0)));
        w &= w - 1;
      }
    }
  }

  /**
   * Return an array of every set bit index in ascending order.
   */
  public indices(): number[] {
    const idx: number[] = [];
    this.forEach((i) => idx.push(i));
    return idx;
  }

  /**
   * OR `bitmask` into the word at position `arrayIndex`.
   *
   * @internal Low-level bulk operation; prefer {@link add} or {@link addBit}
   * for single bits.
   */
  public _addIndexBitmask(arrayIndex: number, bitmask: number): void {
    this._ensureCapacity(arrayIndex);
    this._bits[arrayIndex] |= bitmask;
  }

  /**
   * Replace the word at position `arrayIndex` with `bitmask`.
   *
   * @internal Used by network deserialization to write a whole word at once.
   */
  public _setIndexBitmask(arrayIndex: number, bitmask: number): void {
    this._ensureCapacity(arrayIndex);
    this._bits[arrayIndex] = bitmask;
  }

  /**
   * Return `true` when every bit in `bitmask` is set in the word at
   * `arrayIndex`.
   *
   * @internal
   */
  public _hasIndexBitmask(arrayIndex: number, bitmask: number): boolean {
    return (this._bits[arrayIndex] & bitmask) !== 0;
  }
}

/**
 * A pre-computed pointer into a {@link Bitset}'s internal word array.
 *
 * Computing `arrayIndex` and `bitmask` from a raw bit index requires a floor
 * division and a bit shift. `BitPtr` caches both values so that hot-path
 * archetype checks ({@link Bitset.hasBit}, {@link Bitset.addBit}) avoid
 * repeating the arithmetic on every entity update.
 *
 * One `BitPtr` is created per registered component type and stored on
 * `ComponentMeta.bitPtr`.
 */
export class BitPtr {
  /** Index of the 32-bit word that contains this bit. */
  public readonly arrayIndex: number;
  /** Single-bit mask within that word. */
  public readonly bitmask: number;

  constructor(
    /** The raw bit index this pointer refers to. */
    public readonly value: number
  ) {
    this.arrayIndex = Math.floor(value / 32);
    this.bitmask = 1 << (value % 32);
  }

  /**
   * Return `true` when both pointers refer to the same bit position.
   *
   * @param other - Pointer to compare against.
   */
  public equals(other: BitPtr): boolean {
    return this.arrayIndex == other.arrayIndex && this.bitmask == other.bitmask;
  }
}
