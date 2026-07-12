import { describe, expect, it } from "vitest";
import { phaserNetworkComponents, phaserRenderableComponents } from "../src/index.js";

describe("phaserNetworkComponents", () => {
  it("has exactly 30 entries", () => {
    expect(phaserNetworkComponents.length).toBe(30);
  });

  it("contains components in the exact protocol order (wire type = index + 1)", () => {
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
      "Image",
      "Tint",
      "DrawIn",
      "Container",
      "Offset",
      "DrawBy",
      "Hidden",
      "Flip",
      "Origin",
      "ScreenAnchor",
      "CameraFollow",
      "CameraZoom",
      "CameraBounds",
      "CameraShake",
    ]);
  });
});

describe("phaserRenderableComponents", () => {
  it("contains the 10 renderable components in order (9 shapes + Container)", () => {
    expect(phaserRenderableComponents.map((c) => c.name)).toEqual([
      "Arc",
      "Ellipse",
      "Rectangle",
      "Polygon",
      "Line",
      "Triangle",
      "Star",
      "Text",
      "Image",
      "Container",
    ]);
  });

  it("every renderable component is also present in phaserNetworkComponents", () => {
    for (const renderable of phaserRenderableComponents) {
      expect(phaserNetworkComponents).toContain(renderable);
    }
  });
});
