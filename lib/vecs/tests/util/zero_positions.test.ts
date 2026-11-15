import { describe, expect, it } from "vitest";
import { zeroPositions } from "../../src/util/zero_positions.js";

describe("zeroPositions", () => {
  it.each([0, 1, 137, 2047, 2048, 2049, 5000])("returns %i zeros", (length) => {
    const positions = zeroPositions(length);
    expect(positions).toHaveLength(length);
    expect(positions.every((slot) => slot === 0)).toBe(true);
  });

  it("returns an array of its own that grows and is written independently", () => {
    const first = zeroPositions(64);
    first.fill(7);
    first.push(9);
    const second = zeroPositions(3000);
    expect(second).toHaveLength(3000);
    expect(second.every((slot) => slot === 0)).toBe(true);
    second[10] = 5;
    expect(zeroPositions(64)).toEqual(new Array<number>(64).fill(0));
    expect(first).toHaveLength(65);
  });
});
