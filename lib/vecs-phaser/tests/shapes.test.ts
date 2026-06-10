import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { describe, expect, it } from "vitest";

import {
  Arc,
  Ellipse,
  Line,
  Polygon,
  Rectangle,
  Star,
  Triangle,
} from "../src/components/shapes.js";

function roundTrip<T extends object>(C: new () => T, value: T): T {
  const enc = new Encoder(new Uint8Array(1024));
  enc.write(value);
  return new Decoder(enc.getBuffer()).read(C);
}

describe("Arc", () => {
  it("round-trips non-default values", () => {
    const arc = new Arc();
    arc.radius = 1.5;
    arc.startAngle = 0.5;
    arc.endAngle = 3.0;
    arc.anticlockwise = true;
    arc.iterations = 0.05;

    const decoded = roundTrip(Arc, arc);

    expect(decoded).toBeInstanceOf(Arc);
    expect(decoded.radius).toBeCloseTo(1.5, 4);
    expect(decoded.startAngle).toBeCloseTo(0.5, 4);
    expect(decoded.endAngle).toBeCloseTo(3.0, 4);
    expect(decoded.anticlockwise).toBe(true);
    expect(decoded.iterations).toBeCloseTo(0.05, 4);
  });

  it("round-trips default values including endAngle = 2π", () => {
    const decoded = roundTrip(Arc, new Arc());

    expect(decoded.radius).toBeCloseTo(0.5, 4);
    expect(decoded.startAngle).toBeCloseTo(0, 4);
    // f32 round-trip of Math.PI * 2 — use toBeCloseTo
    expect(decoded.endAngle).toBeCloseTo(Math.PI * 2, 4);
    expect(decoded.anticlockwise).toBe(false);
    expect(decoded.iterations).toBeCloseTo(0.01, 4);
  });
});

describe("Ellipse", () => {
  it("round-trips non-default values", () => {
    const ellipse = new Ellipse();
    ellipse.width = 4;
    ellipse.height = 2;

    const decoded = roundTrip(Ellipse, ellipse);

    expect(decoded).toBeInstanceOf(Ellipse);
    expect(decoded.width).toBeCloseTo(4, 4);
    expect(decoded.height).toBeCloseTo(2, 4);
  });
});

describe("Rectangle", () => {
  it("round-trips non-default values", () => {
    const rect = new Rectangle();
    rect.width = 3;
    rect.height = 1.5;

    const decoded = roundTrip(Rectangle, rect);

    expect(decoded).toBeInstanceOf(Rectangle);
    expect(decoded.width).toBeCloseTo(3, 4);
    expect(decoded.height).toBeCloseTo(1.5, 4);
  });
});

describe("Polygon", () => {
  it("round-trips a non-empty points array", () => {
    const poly = new Polygon();
    poly.points = [0, 1, -1, -1, 1, -1];

    const decoded = roundTrip(Polygon, poly);

    expect(decoded).toBeInstanceOf(Polygon);
    expect(decoded.points).toHaveLength(6);
    expect(decoded.points[0]).toBeCloseTo(0, 4);
    expect(decoded.points[1]).toBeCloseTo(1, 4);
    expect(decoded.points[2]).toBeCloseTo(-1, 4);
    expect(decoded.points[3]).toBeCloseTo(-1, 4);
    expect(decoded.points[4]).toBeCloseTo(1, 4);
    expect(decoded.points[5]).toBeCloseTo(-1, 4);
  });

  it("round-trips an empty points array", () => {
    const decoded = roundTrip(Polygon, new Polygon());

    expect(decoded).toBeInstanceOf(Polygon);
    expect(decoded.points).toEqual([]);
  });
});

describe("Line", () => {
  it("round-trips non-default values", () => {
    const line = new Line();
    line.x1 = 0.5;
    line.y1 = 1.0;
    line.x2 = -0.5;
    line.y2 = -1.0;

    const decoded = roundTrip(Line, line);

    expect(decoded).toBeInstanceOf(Line);
    expect(decoded.x1).toBeCloseTo(0.5, 4);
    expect(decoded.y1).toBeCloseTo(1.0, 4);
    expect(decoded.x2).toBeCloseTo(-0.5, 4);
    expect(decoded.y2).toBeCloseTo(-1.0, 4);
  });
});

describe("Triangle", () => {
  it("round-trips non-default values", () => {
    const tri = new Triangle();
    tri.x1 = 0;
    tri.y1 = 2;
    tri.x2 = -2;
    tri.y2 = -2;
    tri.x3 = 2;
    tri.y3 = -2;

    const decoded = roundTrip(Triangle, tri);

    expect(decoded).toBeInstanceOf(Triangle);
    expect(decoded.x1).toBeCloseTo(0, 4);
    expect(decoded.y1).toBeCloseTo(2, 4);
    expect(decoded.x2).toBeCloseTo(-2, 4);
    expect(decoded.y2).toBeCloseTo(-2, 4);
    expect(decoded.x3).toBeCloseTo(2, 4);
    expect(decoded.y3).toBeCloseTo(-2, 4);
  });

  it("round-trips default values", () => {
    const decoded = roundTrip(Triangle, new Triangle());

    expect(decoded.x1).toBeCloseTo(0, 4);
    expect(decoded.y1).toBeCloseTo(1, 4);
    expect(decoded.x2).toBeCloseTo(-1, 4);
    expect(decoded.y2).toBeCloseTo(-1, 4);
    expect(decoded.x3).toBeCloseTo(1, 4);
    expect(decoded.y3).toBeCloseTo(-1, 4);
  });
});

describe("Star", () => {
  it("round-trips non-default values", () => {
    const star = new Star();
    star.points = 6;
    star.innerRadius = 0.25;
    star.outerRadius = 0.75;

    const decoded = roundTrip(Star, star);

    expect(decoded).toBeInstanceOf(Star);
    expect(decoded.points).toBe(6);
    expect(decoded.innerRadius).toBeCloseTo(0.25, 4);
    expect(decoded.outerRadius).toBeCloseTo(0.75, 4);
  });

  it("round-trips default values", () => {
    const decoded = roundTrip(Star, new Star());

    expect(decoded.points).toBe(5);
    expect(decoded.innerRadius).toBeCloseTo(0.5, 4);
    expect(decoded.outerRadius).toBeCloseTo(1, 4);
  });
});
