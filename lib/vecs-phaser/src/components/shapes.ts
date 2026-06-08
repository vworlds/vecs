import { type as wireType } from "@vworlds/vecs-wire";

/**
 * Arc shape. All dimensions in meters; angles in radians (CCW+).
 * The full unit circle default (endAngle = 2π) renders a complete circle.
 */
export class Arc {
  /** Radius in meters. */
  @wireType("f32")
  public radius = 0.5;

  /** Start angle in radians (CCW+). */
  @wireType("f32")
  public startAngle = 0;

  /** End angle in radians (CCW+). Default is a full circle (2π). */
  @wireType("f32")
  public endAngle = Math.PI * 2;

  /** Whether the arc is drawn anticlockwise. */
  @wireType("bool")
  public anticlockwise = false;

  /** Iteration step size for arc tessellation. */
  @wireType("f32")
  public iterations = 0.01;
}

/**
 * Ellipse shape. All dimensions in meters.
 */
export class Ellipse {
  /** Width in meters. */
  @wireType("f32")
  public width = 2;

  /** Height in meters. */
  @wireType("f32")
  public height = 1;
}

/**
 * Rectangle shape. All dimensions in meters.
 */
export class Rectangle {
  /** Width in meters. */
  @wireType("f32")
  public width = 2;

  /** Height in meters. */
  @wireType("f32")
  public height = 1;
}

/**
 * Polygon shape. Points are alternating x,y pairs in meters,
 * relative to the entity's Position.
 */
export class Polygon {
  /** Alternating x,y coordinates in meters, relative to entity Position. */
  @wireType(["f32"])
  public points: number[] = [];
}

/**
 * Line shape. Endpoints are in meters, relative to the entity's Position.
 */
export class Line {
  /** X coordinate of the first endpoint in meters (relative). */
  @wireType("f32")
  public x1 = 0;

  /** Y coordinate of the first endpoint in meters (relative). */
  @wireType("f32")
  public y1 = 0;

  /** X coordinate of the second endpoint in meters (relative). */
  @wireType("f32")
  public x2 = 0;

  /** Y coordinate of the second endpoint in meters (relative). */
  @wireType("f32")
  public y2 = 0;
}

/**
 * Triangle shape. Vertices are in meters, relative to the entity's Position.
 * Default is an upward-pointing equilateral-ish triangle.
 */
export class Triangle {
  /** X coordinate of vertex 1 in meters (relative). */
  @wireType("f32")
  public x1 = 0;

  /** Y coordinate of vertex 1 in meters (relative). */
  @wireType("f32")
  public y1 = 1;

  /** X coordinate of vertex 2 in meters (relative). */
  @wireType("f32")
  public x2 = -1;

  /** Y coordinate of vertex 2 in meters (relative). */
  @wireType("f32")
  public y2 = -1;

  /** X coordinate of vertex 3 in meters (relative). */
  @wireType("f32")
  public x3 = 1;

  /** Y coordinate of vertex 3 in meters (relative). */
  @wireType("f32")
  public y3 = -1;
}

/**
 * Star shape. Radii are in meters.
 */
export class Star {
  /** Number of points on the star. */
  @wireType("u8")
  public points = 5;

  /** Inner radius in meters. */
  @wireType("f32")
  public innerRadius = 0.5;

  /** Outer radius in meters. */
  @wireType("f32")
  public outerRadius = 1;
}
