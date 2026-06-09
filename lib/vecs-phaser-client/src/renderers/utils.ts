import type { Entity, EID } from "@vworlds/vecs";
import {
  Alpha,
  Depth,
  FillStyle,
  Position,
  Rotation,
  Scale,
  StrokeStyle,
} from "@vworlds/vecs-phaser";
import type Phaser from "phaser";

import type { RenderContext } from "../render_context.js";

export interface TransformStyleGameObject extends Phaser.GameObjects.GameObject {
  setAlpha(value: number): this;
  setDepth(value: number): this;
  setFillStyle(color: number, alpha: number): this;
  setPosition(x: number, y: number): this;
  setRotation(angle: number): this;
  setScale(x: number, y: number): this;
  setStrokeStyle(width: number, color: number, alpha: number): this;
}

export interface SizeGameObject extends TransformStyleGameObject {
  setSize(width: number, height: number): this;
}

export interface StarGameObject extends TransformStyleGameObject {
  setPoints(points: number): this;
  setRadius(innerRadius: number, outerRadius: number): this;
}

export interface VertexGameObject extends TransformStyleGameObject {
  setDisplayOrigin(x: number, y: number): this;
  setTo(...coordinates: readonly number[]): this;
}

export function applyInitialComponents(
  ctx: RenderContext,
  entity: Entity,
  obj: TransformStyleGameObject
): void {
  const position = entity.get(Position);
  if (position !== undefined) {
    obj.setPosition(ctx.coords.x(position.x), ctx.coords.y(position.y));
  }

  const rotation = entity.get(Rotation);
  if (rotation !== undefined) {
    obj.setRotation(ctx.coords.rot(rotation.angle));
  }

  const scale = entity.get(Scale);
  if (scale !== undefined) {
    obj.setScale(scale.x, scale.y);
  }

  const alpha = entity.get(Alpha);
  if (alpha !== undefined) {
    obj.setAlpha(alpha.value);
  }

  const depth = entity.get(Depth);
  if (depth !== undefined) {
    obj.setDepth(depth.value);
  }

  const fill = entity.get(FillStyle);
  if (fill !== undefined) {
    obj.setFillStyle(fill.color, fill.alpha);
  }

  const stroke = entity.get(StrokeStyle);
  if (stroke !== undefined) {
    obj.setStrokeStyle(stroke.width, stroke.color, stroke.alpha);
  }
}

export function destroyMappedGameObject(ctx: RenderContext, eid: EID): void {
  const obj = ctx.getGameObject(eid);
  if (obj === undefined) {
    return;
  }
  obj.destroy();
  ctx.deleteGameObject(eid);
}

export function getMappedGameObject<T extends TransformStyleGameObject>(
  ctx: RenderContext,
  eid: EID
): T | undefined {
  return ctx.getGameObject(eid) as T | undefined;
}

export function initialPosition(ctx: RenderContext, entity: Entity): readonly [number, number] {
  const position = entity.get(Position);
  return [ctx.coords.x(position?.x ?? 0), ctx.coords.y(position?.y ?? 0)];
}

export function pinVertexOrigin(obj: VertexGameObject): void {
  obj.setDisplayOrigin(0, 0);
}
