import type { Entity } from "@vworlds/vecs";
import {
  Alpha,
  Depth,
  FillStyle,
  Position,
  Rotation,
  Scale,
  StrokeStyle,
  TextAlign,
} from "@vworlds/vecs-phaser";
import type Phaser from "phaser";

import type { RenderContext } from "../render_context.js";

export interface RenderObject extends Phaser.GameObjects.GameObject {
  setAlpha(value: number): this;
  setDepth(value: number): this;
  setFillStyle(color: number, alpha?: number): this;
  setOrigin(x: number, y?: number): this;
  setPosition(x: number, y: number): this;
  setRotation(radians: number): this;
  setScale(x: number, y?: number): this;
  setStrokeStyle(lineWidth: number, color: number, alpha?: number): this;
}

export interface VertexBounds {
  readonly maxX: number;
  readonly maxY: number;
  readonly minX: number;
  readonly minY: number;
}

export function applyInitialComponents(
  ctx: RenderContext,
  entity: Entity,
  obj: RenderObject
): void {
  const position = entity.get(Position);
  if (position) {
    obj.setPosition(ctx.coords.x(position.x), ctx.coords.y(position.y));
  }

  const rotation = entity.get(Rotation);
  if (rotation) {
    obj.setRotation(ctx.coords.rot(rotation.angle));
  }

  const scale = entity.get(Scale);
  if (scale) {
    obj.setScale(scale.x, scale.y);
  }

  const alpha = entity.get(Alpha);
  if (alpha) {
    obj.setAlpha(alpha.value);
  }

  const depth = entity.get(Depth);
  if (depth) {
    obj.setDepth(depth.value);
  }

  const fill = entity.get(FillStyle);
  if (fill) {
    obj.setFillStyle(fill.color, fill.alpha);
  }

  const stroke = entity.get(StrokeStyle);
  if (stroke) {
    obj.setStrokeStyle(stroke.width, stroke.color, stroke.alpha);
  }
}

export function applyVertexOrigin(obj: RenderObject, bounds: VertexBounds): void {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  obj.setOrigin(originForAxis(bounds.minX, width), originForAxis(bounds.minY, height));
}

export function boundsFromFlatPoints(points: readonly number[]): VertexBounds {
  if (points.length < 2) {
    return { maxX: 0, maxY: 0, minX: 0, minY: 0 };
  }

  let minX = points[0] ?? 0;
  let maxX = minX;
  let minY = points[1] ?? 0;
  let maxY = minY;

  for (let i = 2; i < points.length; i += 2) {
    const x = points[i] ?? 0;
    const y = points[i + 1] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  return { maxX, maxY, minX, minY };
}

export function hexColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function textAlign(value: TextAlign): "center" | "left" | "right" {
  switch (value) {
    case TextAlign.Center:
      return "center";
    case TextAlign.Right:
      return "right";
    default:
      return "left";
  }
}

function originForAxis(min: number, size: number): number {
  return size === 0 ? 0 : -min / size;
}
