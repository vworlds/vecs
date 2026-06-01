import { describe, expect, it } from "vitest";

import { Box } from "../../src/index.js";

// Box ships width/height accessors over the hx/hy half-extent fields. They are
// pure ergonomics: setting via the accessor does NOT notify Vecs (see PLAN →
// Box accessors), but the read/write arithmetic must stay exact.

describe("Box width/height accessors", () => {
  it("width and height read back as twice the half extents", () => {
    const box = new Box();
    expect(box.width).toBe(1);
    expect(box.height).toBe(1);
  });

  it("setting width/height writes half extents", () => {
    const box = new Box();
    box.width = 4;
    box.height = 6;
    expect(box.hx).toBe(2);
    expect(box.hy).toBe(3);
    expect(box.width).toBe(4);
    expect(box.height).toBe(6);
  });

  it("setting half extents is reflected by the accessors", () => {
    const box = new Box();
    box.hx = 1.5;
    box.hy = 0.25;
    expect(box.width).toBe(3);
    expect(box.height).toBe(0.5);
  });
});
