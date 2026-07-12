import { describe, expect, it } from "vitest";

import { CoordSpace } from "../src/coord_space.js";

function mockScene(width: number, height: number): Phaser.Scene {
  return { scale: { width, height } } as unknown as Phaser.Scene;
}

describe("CoordSpace", () => {
  describe("worked example (1024×768, ppm=64)", () => {
    const scene = mockScene(1024, 768);
    const cs = new CoordSpace(scene, 64);

    it("x(0) = 512", () => {
      expect(cs.x(0)).toBe(512);
    });

    it("x(1) = 576", () => {
      expect(cs.x(1)).toBe(576);
    });

    it("y(0) = 384", () => {
      expect(cs.y(0)).toBe(384);
    });

    it("y(1) = 320", () => {
      expect(cs.y(1)).toBe(320);
    });
  });

  describe("len", () => {
    const cs = new CoordSpace(mockScene(800, 600), 64);

    it("len(1) = 64", () => {
      expect(cs.len(1)).toBe(64);
    });

    it("len(0.5) = 32", () => {
      expect(cs.len(0.5)).toBe(32);
    });
  });

  describe("relative geometry (rx / ry)", () => {
    const cs = new CoordSpace(mockScene(800, 600), 64);

    it("rx(1) = 64", () => {
      expect(cs.rx(1)).toBe(64);
    });

    it("ry(1) = -64 (Y flip)", () => {
      expect(cs.ry(1)).toBe(-64);
    });
  });

  describe("angle conversions", () => {
    const cs = new CoordSpace(mockScene(800, 600), 64);

    it("rot(r) === -r", () => {
      const r = 1.23;
      expect(cs.rot(r)).toBe(-r);
    });

    it("rot(0) === 0", () => {
      expect(cs.rot(0)).toBe(-0);
    });

    it("deg(PI) ≈ -180", () => {
      expect(cs.deg(Math.PI)).toBeCloseTo(-180);
    });

    it("deg(0) = 0", () => {
      expect(cs.deg(0)).toBe(-0);
    });
  });

  describe("default ppm is 64", () => {
    const cs = new CoordSpace(mockScene(1024, 768));

    it("x(1) = 576 with default ppm", () => {
      expect(cs.x(1)).toBe(576);
    });

    it("len(1) = 64 with default ppm", () => {
      expect(cs.len(1)).toBe(64);
    });
  });

  describe("custom ppm is respected", () => {
    const cs = new CoordSpace(mockScene(1024, 768), 100);

    it("x(1) = 612 with ppm=100", () => {
      expect(cs.x(1)).toBe(612);
    });

    it("len(1) = 100 with ppm=100", () => {
      expect(cs.len(1)).toBe(100);
    });
  });

  describe("inverse mapping mx/my", () => {
    const scene = { scale: { width: 1024, height: 768 } } as unknown as Phaser.Scene;
    const cs = new CoordSpace(scene, 64);

    it("mx inverts x for center, positive, and negative meters", () => {
      expect(cs.mx(cs.x(0))).toBe(0);
      expect(cs.mx(cs.x(1.5))).toBe(1.5);
      expect(cs.mx(cs.x(-2.25))).toBe(-2.25);
    });

    it("my inverts y with the Y flip", () => {
      expect(cs.my(cs.y(0))).toBe(0);
      expect(cs.my(cs.y(2))).toBe(2);
      expect(cs.my(cs.y(-0.5))).toBe(-0.5);
    });

    it("my(0) is the top edge in meters (+y up)", () => {
      expect(cs.my(0)).toBe(6);
    });
  });

  describe("resize reflects in subsequent calls", () => {
    const scale = { width: 800, height: 600 };
    const scene = { scale } as unknown as Phaser.Scene;
    const cs = new CoordSpace(scene, 64);

    it("x(0) = 400 before resize", () => {
      expect(cs.x(0)).toBe(400);
    });

    it("y(0) = 300 before resize", () => {
      expect(cs.y(0)).toBe(300);
    });

    it("x(0) = 512 after resize to 1024×768", () => {
      scale.width = 1024;
      scale.height = 768;
      expect(cs.x(0)).toBe(512);
    });

    it("y(0) = 384 after resize to 1024×768", () => {
      expect(cs.y(0)).toBe(384);
    });
  });
});
