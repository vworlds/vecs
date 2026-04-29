/**
 * A compact, growable set of non-negative integers backed by an array of
 * 32-bit words.
 *
 * Used internally to represent entity archetypes (the set of component type
 * ids attached to an entity) and system watchlists. Exposed in the public API
 * so that component data can use it for bit-flag fields:
 *
 * ```ts
 * class Tags extends Component {
 *   tags    = new Bitset();
 *   oldTags = new Bitset();
 * }
 *
 * // Check a specific tag bit:
 * if (tags.tags.has(TAG_VISIBLE)) { ... }
 * ```
 */
export class Bitset {
  /** @internal */
  public _bits: number[];

  constructor() {
    this._bits = [];
  }

  /**
   * Return `true` if this bitset and `other` have exactly the same bits set.
   */
  equal(other: Bitset) {
    return (
      this._bits.length === other._bits.length && this._bits.every((v, i) => other._bits[i] === v)
    );
  }

  /**
   * OR the given `bitmask` word into the word at position `arrayIndex`.
   *
   * @internal Low-level bulk operation; prefer {@link add} for single bits.
   */
  addIndexBitmask(arrayIndex: number, bitmask: number) {
    this._bits[arrayIndex] |= bitmask;
  }

  /**
   * Replace the word at position `arrayIndex` with `bitmask`.
   *
   * @internal Used by network deserialization to set a whole word at once.
   */
  setIndexBitmask(arrayIndex: number, bitmask: number) {
    this._bits[arrayIndex] = bitmask;
  }

  /**
   * Set the bit described by `bptr` (fast path using a pre-computed
   * {@link BitPtr}).
   */
  addBit(bptr: BitPtr) {
    this.addIndexBitmask(bptr.arrayIndex, bptr.bitmask);
  }

  /**
   * Set bit `n`.
   *
   * @param n - Non-negative integer bit index.
   */
  add(n: number): void {
    const arrayIndex = Math.floor(n / 32);
    const bitmask = 1 << (n % 32);
    this.addIndexBitmask(arrayIndex, bitmask);
  }

  /**
   * Clear bit `n`.
   *
   * Trailing zero words are trimmed so that the internal array stays compact.
   *
   * @param n - Non-negative integer bit index.
   */
  delete(n: number): void {
    const arrayIndex = Math.floor(n / 32);
    const current = this._bits[arrayIndex];
    if (current === undefined) {
      return;
    } else {
      this._bits[arrayIndex] = current & ~(1 << (n % 32));
    }
    while (this._bits.length && this._bits[this._bits.length - 1] === 0) {
      this._bits.pop();
    }
  }

  /**
   * Return `true` if the bit described by `bptr` is set (fast path).
   */
  hasBit(bptr: BitPtr) {
    return this.hasIndexBitmask(bptr.arrayIndex, bptr.bitmask);
  }

  /**
   * Return `true` if bit `n` is set.
   *
   * @param n - Non-negative integer bit index.
   */
  has(n: number): boolean {
    const arrayIndex = Math.floor(n / 32);
    if (arrayIndex >= this._bits.length) {
      return false;
    }
    const bitIndex = n % 32;
    const bitmask = 1 << bitIndex;
    return this.hasIndexBitmask(arrayIndex, bitmask);
  }

  /**
   * Return `true` if the given word-level bitmask is fully set at `arrayIndex`.
   *
   * @internal
   */
  hasIndexBitmask(arrayIndex: number, bitmask: number) {
    return (this._bits[arrayIndex] & bitmask) !== 0;
  }

  /**
   * Return `true` if every bit set in `other` is also set in `this` (i.e.
   * `other` is a subset of `this`).
   *
   * Used by the world to test whether an entity's archetype satisfies a
   * system's `HAS` query.
   */
  hasBitset(other: Bitset): boolean {
    if (this._bits.length < other._bits.length) {
      return false;
    }

    for (let i = 0; i < other._bits.length; i++) {
      if ((this._bits[i] & other._bits[i]) !== (other._bits[i] || 0)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Iterate over every set bit index in ascending order.
   *
   * @param callback - Called with each set bit index.
   */
  forEach(callback: (n: number) => void): void {
    this._bits.forEach((b, j) => {
      for (let i = 0; i < 32; i++) {
        if ((b & 1) !== 0) {
          callback(i + j * 32);
        }
        b >>= 1;
      }
    });
  }

  /**
   * Return an array of all set bit indices in ascending order.
   *
   * @returns `number[]` of set bit positions.
   */
  indices(): number[] {
    const idx: number[] = [];
    this.forEach((i) => idx.push(i));
    return idx;
  }
}

/**
 * A pre-computed pointer into a {@link Bitset}'s internal word array.
 *
 * Computing `arrayIndex` and `bitmask` from a raw bit index requires a floor
 * division and a bitshift. `BitPtr` caches those values so that hot-path
 * archetype checks ({@link Bitset.hasBit}, {@link Bitset.addBit}) avoid
 * repeating the arithmetic on every entity update.
 *
 * A `BitPtr` is created once per component type and stored on
 * {@link ComponentMeta.bitPtr}.
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

  /** Return `true` if both pointers refer to the same bit position. */
  public equals(other: BitPtr) {
    return this.arrayIndex == other.arrayIndex && this.bitmask == other.bitmask;
  }
}
