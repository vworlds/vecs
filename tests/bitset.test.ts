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

  it("delete trims trailing zero words", () => {
    const b = new Bitset();
    b.add(0);
    b.add(32);
    b.add(64);
    expect(b._bits.length).toBe(3);
    b.delete(64);
    expect(b._bits.length).toBe(2);
    b.delete(32);
    expect(b._bits.length).toBe(1);
    b.delete(0);
    expect(b._bits.length).toBe(0);
  });

  it("delete on absent word is a no-op", () => {
    const b = new Bitset();
    b.delete(50); // never been added — array is empty
    expect(b.has(50)).toBe(false);
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
});
