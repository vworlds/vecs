import type { Entity } from "@vworlds/vecs";
import { TextAlign, type Text as TextComponent } from "@vworlds/vecs-phaser";
import type Phaser from "phaser";

export class VGameObject {
  public obj!: RenderObject;
}

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

export interface ArcObject extends RenderObject {
  setEndAngle(degrees: number, anticlockwise?: boolean): this;
  setIterations(iterations: number): this;
  setRadius(radius: number): this;
  setStartAngle(degrees: number, anticlockwise?: boolean): this;
}

export interface SizeGameObject extends RenderObject {
  setSize(width: number, height: number): this;
}

export interface StarGameObject extends RenderObject {
  setInnerRadius(value: number): this;
  setOuterRadius(value: number): this;
  setPoints(points: number): this;
}

export interface TextObject extends RenderObject {
  setStyle(style: Phaser.Types.GameObjects.Text.TextStyle): this;
  setText(value: string): this;
}

export interface VertexGameObject extends RenderObject {
  setTo(...coordinates: readonly number[]): this;
}

export type LineObject = Phaser.GameObjects.Line & VertexGameObject;
export type PolygonObject = Phaser.GameObjects.Polygon & VertexGameObject;
export type RectangleObject = Phaser.GameObjects.Rectangle & SizeGameObject;
export type TriangleObject = Phaser.GameObjects.Triangle & VertexGameObject;

export function removeGameObject(entity: Entity): void {
  if (entity.has(VGameObject)) {
    entity.remove(VGameObject);
  }
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

export function textStyle(text: TextComponent): Phaser.Types.GameObjects.Text.TextStyle {
  const style: Phaser.Types.GameObjects.Text.TextStyle = {
    align: textAlign(text.align),
    color: hexColor(text.color),
    fontFamily: text.fontFamily,
    fontSize: text.fontSize,
  };
  if (text.backgroundAlpha > 0) {
    style.backgroundColor = hexColor(text.backgroundColor);
  }
  return style;
}
