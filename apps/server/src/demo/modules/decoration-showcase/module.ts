import { Module, type Entity } from "@vworlds/vecs";
import {
  Ellipse,
  FillStyle,
  Line,
  Polygon,
  Position as RenderPosition,
  Rotation as RenderRotation,
  Size,
  Star,
  StrokeStyle,
  Text,
  TextAlign,
  Tint,
  Triangle,
} from "@vworlds/vecs-phaser";
import { Networked } from "@vworlds/vecs-server";
import { DecorationShowcaseComponents, RotatingDecoration } from "./components.js";

export class DecorationShowcaseModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(DecorationShowcaseComponents);

    world
      .system("SpinDecorations")
      .with(Networked, RotatingDecoration, RenderRotation)
      .each([RotatingDecoration, RenderRotation], (entity, [rotating, rotation]) => {
        rotation.angle += rotating.speed;
        entity.modified(RenderRotation);
      });

    createDecorations(world);
  }
}

function createDecorations(world: { entity(): Entity }): void {
  world
    .entity()
    .add(Networked)
    .set(Star, { points: 5, innerRadius: 0.12, outerRadius: 0.24 })
    .set(RenderPosition, { x: -4.1, y: -2.05 })
    .set(FillStyle, { color: 0xffdd66, alpha: 0.9 });
  world
    .entity()
    .add(Networked)
    .set(Triangle, { x1: 0, y1: 0.28, x2: -0.28, y2: -0.2, x3: 0.28, y3: -0.2 })
    .set(RenderPosition, { x: -2.7, y: -2.05 })
    .set(RenderRotation, { angle: 0 })
    .set(FillStyle, { color: 0x66ffaa, alpha: 0.85 })
    .set(RotatingDecoration, { speed: 0.018 });
  world
    .entity()
    .add(Networked)
    .set(Polygon, { points: [-0.3, -0.18, -0.08, 0.25, 0.32, 0.14, 0.22, -0.24] })
    .set(RenderPosition, { x: -1.1, y: -2.05 })
    .set(RenderRotation, { angle: 0 })
    .set(FillStyle, { color: 0xb388ff, alpha: 0.85 })
    .set(StrokeStyle, { color: 0xffffff, alpha: 0.45, width: 2 })
    .set(RotatingDecoration, { speed: -0.014 });
  world
    .entity()
    .add(Networked)
    .add(Ellipse)
    .set(Size, { width: 0.7, height: 0.32 })
    .set(RenderPosition, { x: 1.0, y: -2.05 })
    .set(FillStyle, { color: 0xff88bb, alpha: 0.8 });
  world
    .entity()
    .add(Networked)
    .set(Line, { x1: -0.45, y1: -0.15, x2: 0.45, y2: 0.15 })
    .set(RenderPosition, { x: 2.55, y: -2.05 })
    .set(RenderRotation, { angle: 0 })
    .set(StrokeStyle, { color: 0x88ccff, alpha: 1, width: 4 })
    .set(RotatingDecoration, { speed: 0.03 });

  world
    .entity()
    .add(Networked)
    .set(Text, {
      value: "TINT",
      fontFamily: "monospace",
      fontSize: 32,
      color: 0xffffff,
      align: TextAlign.Center,
    })
    .set(RenderPosition, { x: 3.9, y: -2.05 })
    .set(Tint, {
      topLeft: 0xff0000,
      topRight: 0x00ff00,
      bottomLeft: 0x0000ff,
      bottomRight: 0xffff00,
      monochromatic: false,
    } as Partial<Tint>);
}
