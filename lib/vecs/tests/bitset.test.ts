import { describe, it, expect } from "vitest";
import { Bitset, BitPtr } from "../src/util/bitset.js";

describe("Bitset", () => {
  it("starts empty", () => {
    const b = new Bitset();
    expect(b.has(0)).toBe(false);
    expect(b.has(31)).toBe(false);
    expect(b.has(64)).toBe(false);
    expect(b.indices()).toEqual([]);
  });

  it("adds and checks single bits", () => {
    const b = new Bitset();
    b.add(3);
    b.add(33);
    b.add(100);
    expect(b.has(3)).toBe(true);
    expect(b.has(33)).toBe(true);
    expect(b.has(100)).toBe(true);
    expect(b.has(2)).toBe(false);
    expect(b.has(34)).toBe(false);
  });

  it("returns indices in ascending order", () => {
    const b = new Bitset();
    b.add(100);
    b.add(0);
    b.add(31);
    b.add(32);
    expect(b.indices()).toEqual([0, 31, 32, 100]);
  });

  it("delete clears a bit", () => {
    const b = new Bitset();
    b.add(0);
    b.add(64);
    expect(b.has(64)).toBe(true);
    b.delete(64);
    expect(b.has(64)).toBe(false);
    expect(b.has(0)).toBe(true);
  });

  it("compact trims trailing zero words", () => {
    const b = new Bitset();
    b.add(0);
    b.add(32);
    b.add(64);
    expect(b._bits.length).toBe(3);
    b.delete(64);
    expect(b._bits.length).toBe(3); // Should not shrink yet
    b.compact();
    expect(b._bits.length).toBe(2);
    b.delete(32);
    b.compact();
    expect(b._bits.length).toBe(1);
    b.delete(0);
    b.compact();
    expect(b._bits.length).toBe(0);
  });

  it("delete on absent word is a no-op", () => {
    const b = new Bitset();
    b.delete(50); // never been added — array is empty
    expect(b.has(50)).toBe(false);
  });

  it("clear removes all bits", () => {
    const b = new Bitset();
    b.add(1);
    b.add(64);
    b.clear();
    expect(b.indices()).toEqual([]);
    expect(b._bits.length).toBe(0);
  });

  it("equal compares bit-by-bit", () => {
    const a = new Bitset();
    const b = new Bitset();
    a.add(1);
    a.add(33);
    b.add(33);
    b.add(1);
    expect(a.equal(b)).toBe(true);
    b.add(2);
    expect(a.equal(b)).toBe(false);
  });

  it("hasBitset checks subset relation", () => {
    const a = new Bitset();
    const b = new Bitset();
    a.add(1);
    a.add(2);
    a.add(33);
    b.add(1);
    b.add(33);
    expect(a.hasBitset(b)).toBe(true);
    expect(b.hasBitset(a)).toBe(false);
  });

  it("hasBitset returns false when other has bits in higher words than this", () => {
    const a = new Bitset();
    const b = new Bitset();
    a.add(0);
    b.add(0);
    b.add(64);
    expect(a.hasBitset(b)).toBe(false);
  });

  it("forEach yields each set bit exactly once", () => {
    const b = new Bitset();
    [0, 1, 32, 33, 100].forEach((n) => b.add(n));
    const seen: number[] = [];
    b.forEach((n) => seen.push(n));
    expect(seen).toEqual([0, 1, 32, 33, 100]);
  });

  it("BitPtr fast path matches add/has results", () => {
    const b = new Bitset();
    const ptr = new BitPtr(45);
    b.addBit(ptr);
    expect(b.hasBit(ptr)).toBe(true);
    expect(b.has(45)).toBe(true);
    b.deleteBit(ptr);
    expect(b.hasBit(ptr)).toBe(false);
    expect(b.has(45)).toBe(false);
  });

  it("BitPtr.equals identifies same bit position", () => {
    expect(new BitPtr(7).equals(new BitPtr(7))).toBe(true);
    expect(new BitPtr(7).equals(new BitPtr(8))).toBe(false);
  });

  it("_addIndexBitmask and _setIndexBitmask manipulate raw words", () => {
    const b = new Bitset();
    b._addIndexBitmask(0, 0b1010);
    expect(b.has(1)).toBe(true);
    expect(b.has(3)).toBe(true);
    b._setIndexBitmask(0, 0b0001);
    expect(b.has(1)).toBe(false);
    expect(b.has(0)).toBe(true);
  });

  describe("_compileSubsetCheck", () => {
    it("returns 'true' for an empty mask", () => {
      const mask = new Bitset();
      expect(mask._compileSubsetCheck("B")).toBe("true");
    });

    it("emits a single conjunct for a one-word mask", () => {
      const mask = new Bitset();
      mask.add(0);
      expect(mask._compileSubsetCheck("B")).toBe("(B[0]&1)===1");
    });

    it("ORs multiple bits in the same word into one conjunct", () => {
      const mask = new Bitset();
      mask.add(1);
      mask.add(2);
      expect(mask._compileSubsetCheck("B")).toBe("(B[0]&6)===6");
    });

    it("skips zero words at code-generation time", () => {
      const mask = new Bitset();
      mask.add(1); // word 0, bitmask 2
      mask.add(130); // word 4, bitmask 4
      expect(mask._compileSubsetCheck("B")).toBe("(B[0]&2)===2&&(B[4]&4)===4");
    });

    it("emits a negative int32 literal for bit 31", () => {
      const mask = new Bitset();
      mask.add(31);
      expect(mask._compileSubsetCheck("B")).toBe("(B[0]&-2147483648)===-2147483648");
    });

    it("emitted expression matches Bitset.hasBitset semantics on synthetic word arrays", () => {
      const mask = new Bitset();
      mask.add(1);
      mask.add(2);
      mask.add(33);
      mask.add(130);

      const evaluator = new Function("B", `return ${mask._compileSubsetCheck("B")};`) as (
        b: number[]
      ) => boolean;

      const cases: { entityBits: number[]; expected: boolean }[] = [
        // Superset of mask.
        { entityBits: [0xff, 0xff, 0xff, 0xff, 0xff], expected: true },
        // Missing bit 130 (word 4 missing the 0b100 bit).
        { entityBits: [0xff, 0xff, 0xff, 0xff, 0x0], expected: false },
        // Missing bit 33 (word 1 has only bit 0 set, not bit 1).
        { entityBits: [0xff, 0x1, 0xff, 0xff, 0xff], expected: false },
        // Entity shorter than the mask -> missing high words.
        { entityBits: [0xff], expected: false },
        // Entity exactly equal to the mask.
        { entityBits: [0b110, 0b10, 0, 0, 0b100], expected: true },
      ];

      for (const c of cases) {
        const target = new Bitset();
        c.entityBits.forEach((w, i) => target._setIndexBitmask(i, w));
        expect(evaluator(target._bits)).toBe(c.expected);
        expect(target.hasBitset(mask)).toBe(c.expected);
      }
    });

    it("handles bit-31 masks correctly when evaluated", () => {
      const mask = new Bitset();
      mask.add(31);
      const evaluator = new Function("B", `return ${mask._compileSubsetCheck("B")};`) as (
        b: number[]
      ) => boolean;

      const target = new Bitset();
      target.add(31);
      expect(evaluator(target._bits)).toBe(true);

      const empty = new Bitset();
      expect(evaluator(empty._bits)).toBe(false);
    });
  });
});
