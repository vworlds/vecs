import { describe, expect, it } from "vitest";
import { fnv1a32 } from "../src/index.js";

describe("fnv1a32 stable public utility", () => {
  it.each([
    ["", 0x811c9dc5],
    ["a", 0xe40c292c],
    ["hello", 0x4f9f2cab],
    ["auth", 0x953fa84f],
  ] as const)("pins the hash of %j", (input, expected) => {
    expect(fnv1a32(input)).toBe(expected);
  });
});
