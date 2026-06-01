import { describe, expect, it } from "vitest";

import { Bitset } from "../../src/util/bitset.js";

// vecs-physics re-exports Vecs' Bitset; this guards that the re-export resolves
// and exposes the operations the engine relies on.
describe("bitset re-export", () => {
  it("sets, queries, and clears bits", () => {
    const bits = new Bitset();
    bits.add(3);
    bits.add(70); // forces a second word
    expect(bits.has(3)).toBe(true);
    expect(bits.has(70)).toBe(true);
    expect(bits.has(4)).toBe(false);

    bits.delete(3);
    expect(bits.has(3)).toBe(false);

    expect(bits.indices().sort((a, b) => a - b)).toEqual([70]);

    bits.clear();
    expect(bits.has(70)).toBe(false);
  });
});
