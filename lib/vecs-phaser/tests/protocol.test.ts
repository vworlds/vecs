import { describe, expect, it } from "vitest";
import { phaserNetworkComponents, phaserRenderableComponents } from "../src/index.js";

describe("phaserNetworkComponents", () => {
  it("has exactly 16 entries", () => {
    expect(phaserNetworkComponents.length).toBe(16);
  });

  it("contains components in the exact protocol order (type id = index + 1)", () => {
    expect(phaserNetworkComponents.map((c) => c.name)).toEqual([
      "Position",
      "Rotation",
      "Scale",
      "Alpha",
      "Depth",
      "FillStyle",
      "StrokeStyle",
      "Arc",
      "Ellipse",
      "Rectangle",
      "Polygon",
      "Line",
      "Triangle",
      "Star",
      "Text",
      "Size",
    ]);
  });
});

describe("phaserRenderableComponents", () => {
  it("contains the 8 primary renderable components in order", () => {
    expect(phaserRenderableComponents.map((c) => c.name)).toEqual([
      "Arc",
      "Ellipse",
      "Rectangle",
      "Polygon",
      "Line",
      "Triangle",
      "Star",
      "Text",
    ]);
  });

  it("every renderable component is also present in phaserNetworkComponents", () => {
    for (const renderable of phaserRenderableComponents) {
      expect(phaserNetworkComponents).toContain(renderable);
    }
  });
});
