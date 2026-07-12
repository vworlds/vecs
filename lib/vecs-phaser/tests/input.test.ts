import { describe, expect, it } from "vitest";
import { actionMask, hasAction } from "../src/input.js";

const ORDER = ["left", "right", "up", "down", "fire"] as const;

describe("actionMask", () => {
  it("packs active actions into bits by their index in the shared order", () => {
    expect(actionMask(ORDER, [])).toBe(0);
    expect(actionMask(ORDER, ["left"])).toBe(0b00001);
    expect(actionMask(ORDER, ["fire"])).toBe(0b10000);
    expect(actionMask(ORDER, ["left", "up", "fire"])).toBe(0b10101);
  });

  it("ignores unknown action names", () => {
    expect(actionMask(ORDER, ["warp", "left"])).toBe(0b00001);
  });
});

describe("hasAction", () => {
  it("reads bits back using the same order", () => {
    const mask = actionMask(ORDER, ["right", "down"]);
    expect(hasAction(mask, ORDER, "right")).toBe(true);
    expect(hasAction(mask, ORDER, "down")).toBe(true);
    expect(hasAction(mask, ORDER, "left")).toBe(false);
    expect(hasAction(mask, ORDER, "fire")).toBe(false);
  });

  it("never reports unknown names as active", () => {
    expect(hasAction(0xffffffff, ORDER, "warp")).toBe(false);
  });
});
