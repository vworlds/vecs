import type { EID, Entity } from "@vworlds/vecs";
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

export interface SizeGameObject extends RenderObject {
  setSize(width: number, height: number): this;
}

export interface StarGameObject extends RenderObject {
  setInnerRadius(value: number): this;
  setOuterRadius(value: number): this;
  setPoints(points: number): this;
}

export interface VertexGameObject extends RenderObject {
  setTo(...coordinates: readonly number[]): this;
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

export function applyVertexOrigin(obj: RenderObject): void {
  obj.setOrigin(0, 0);
}

export function destroyMappedGameObject(ctx: RenderContext, eid: EID): void {
  const obj = ctx.getGameObject(eid);
  if (obj === undefined) {
    return;
  }
  obj.destroy();
  ctx.deleteGameObject(eid);
}

export function getMappedGameObject<T extends RenderObject>(
  ctx: RenderContext,
  eid: EID
): T | undefined {
  return ctx.getGameObject(eid) as T | undefined;
}

export function initialPosition(ctx: RenderContext, entity: Entity): readonly [number, number] {
  const position = entity.get(Position);
  return [ctx.coords.x(position?.x ?? 0), ctx.coords.y(position?.y ?? 0)];
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
