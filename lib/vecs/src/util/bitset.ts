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
 * class Tags {
 *   tags = new Bitset();
 * }
 *
 * tags.tags.add(TAG_VISIBLE);
 * if (tags.tags.has(TAG_VISIBLE)) { ... }
 * ```
 */
export class Bitset {
  /**
   * @internal Underlying word storage; exposed for tests and read directly
   * from query predicates emitted by {@link _compileSubsetCheck}. Renaming
   * this field is a breaking change for compiled query code generation.
   */
  public _bits: number[] = [];

  /**
   * Set bit `n`.
   *
   * @param n - Non-negative integer bit index.
   */
  public add(n: number): void {
    this._bits[n >>> 5] |= 1 << n;
  }

  /**
   * Set the bit described by `bptr` (fast path using a pre-computed
   * {@link BitPtr}).
   *
   * @param bptr - Pre-computed pointer to a bit position.
   */
  public addBit(bptr: BitPtr): void {
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
    const current = this._bits[bptr.arrayIndex];
    if (current) {
      this._bits[bptr.arrayIndex] = current & ~bptr.bitmask;
    }
  }

  /**
   * Clear bit `n`. Storage is not compacted automatically; call
   * {@link compact} to trim trailing zero words when needed.
   *
   * @param n - Non-negative integer bit index.
   */
  public delete(n: number): void {
    const arrayIndex = n >>> 5;
    const current = this._bits[arrayIndex];
    if (current) {
      this._bits[arrayIndex] = current & ~(1 << n);
    }
  }

  /**
   * Trim trailing zero words from the backing storage.
   */
  public compact(): void {
    while (this._bits.length && this._bits[this._bits.length - 1] === 0) {
      this._bits.pop();
    }
  }

  /** Remove every set bit. */
  public clear(): void {
    this._bits.length = 0;
  }

  /**
   * Return `true` when bit `n` is set.
   *
   * @param n - Non-negative integer bit index.
   */
  public has(n: number): boolean {
    return (this._bits[n >>> 5] & (1 << n)) !== 0;
  }

  /**
   * Return `true` when the bit described by `bptr` is set (fast path).
   *
   * @param bptr - Pre-computed pointer to a bit position.
   */
  public hasBit(bptr: BitPtr): boolean {
    return (this._bits[bptr.arrayIndex] & bptr.bitmask) !== 0;
  }

  /**
   * Return `true` when this bitset and `other` have exactly the same bits set.
   *
   * @param other - Bitset to compare against.
   */
  public equal(other: Bitset): boolean {
    const maxLength = Math.max(this._bits.length, other._bits.length);
    for (let i = 0; i < maxLength; i++) {
      if ((this._bits[i] || 0) !== (other._bits[i] || 0)) {
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
    const bits = this._bits;
    const otherBits = other._bits;
    for (let i = 0; i < otherBits.length; i++) {
      const otherWord = otherBits[i] | 0;
      if ((bits[i] & otherWord) !== otherWord) {
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
    const len = bits.length;
    for (let j = 0; j < len; j++) {
      let w = bits[j];
      if (w === 0) {
        continue;
      }
      const base = j << 5;
      for (let i = 0; i < 32; i++) {
        if ((w & 1) !== 0) {
          callback(base + i);
        }
        w >>>= 1;
        if (w === 0) {
          break;
        }
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
    this._bits[arrayIndex] |= bitmask;
  }

  /**
   * Replace the word at position `arrayIndex` with `bitmask`.
   *
   * @internal Used by network deserialization to write a whole word at once.
   */
  public _setIndexBitmask(arrayIndex: number, bitmask: number): void {
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

  /**
   * Emit a JavaScript expression that evaluates to `true` when the bitset
   * addressed by `targetBitsExpr` (a `number[]` of 32-bit words) contains
   * every bit set in this bitset.
   *
   * The expression is intended to be spliced into source generated through
   * `new Function(...)` so that a `hasBitset` call against this (immutable)
   * mask is replaced by straight-line bitwise checks with the mask's word
   * values baked in as numeric literals. Zero words are skipped at code
   * generation time, so the runtime expression never iterates them.
   *
   * Contract:
   * - Empty mask -> `"true"`.
   * - One non-zero word -> a single `(target[i]&W)===W` term (no outer
   *   parens; `===` binds tighter than `&&` / `||`, so embedding in an
   *   AND / OR chain is precedence-safe).
   * - Multiple non-zero words -> terms joined by `&&`, no outer parens.
   * - A word whose value sets bit 31 emits as a negative int32 literal
   *   (e.g. `-2147483648`); JS bitwise `&` is defined to coerce both
   *   operands to int32, so the round-trip comparison is correct.
   * - When `target.length` is smaller than the mask, the missing slots
   *   read as `undefined`; `undefined & W` coerces to `0`, and
   *   `0 === W` (W !== 0) is `false`, matching `hasBitset` semantics.
   *
   * The mask's `_bits` are read at the time `_compileSubsetCheck` runs,
   * so a caller that mutates the mask after compilation will not affect
   * already-emitted strings.
   *
   * @internal
   *
   * @param targetBitsExpr - JS expression that, when evaluated at runtime,
   *   yields the target's `_bits` array. Embedded verbatim into the
   *   emitted code; it must be free of side effects (it is evaluated
   *   once per non-zero word of this mask).
   */
  public _compileSubsetCheck(targetBitsExpr: string): string {
    const conjuncts: string[] = [];
    for (let i = 0; i < this._bits.length; i++) {
      const w = this._bits[i] | 0;
      if (w === 0) {
        continue;
      }
      conjuncts.push(`(${targetBitsExpr}[${i}]&${w})===${w}`);
    }
    return conjuncts.length === 0 ? "true" : conjuncts.join("&&");
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
    this.arrayIndex = value >>> 5;
    this.bitmask = 1 << value;
  }

  /**
   * Return `true` when both pointers refer to the same bit position.
   *
   * @param other - Pointer to compare against.
   */
  public equals(other: BitPtr): boolean {
    return this.arrayIndex === other.arrayIndex && this.bitmask === other.bitmask;
  }
}
