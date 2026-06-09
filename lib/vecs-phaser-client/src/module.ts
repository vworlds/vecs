import { Module, ON_STORE, type Entity, type World } from "@vworlds/vecs";
import {
  Alpha,
  Arc,
  Depth,
  Ellipse,
  FillStyle,
  Line,
  Polygon,
  Position,
  Rectangle,
  Rotation,
  Scale,
  Star,
  StrokeStyle,
  Text as TextComponent,
  TextAlign,
  Triangle,
} from "@vworlds/vecs-phaser";
import type Phaser from "phaser";

import { CoordSpace } from "./coord_space.js";

export interface PhaserRenderModuleConfig {
  readonly scene: Phaser.Scene;
  readonly pixelsPerMeter?: number;
}

export class VGameObject {
  public obj!: Phaser.GameObjects.GameObject;
}

export class PhaserRenderModule extends Module<PhaserRenderModuleConfig> {
  public init(config: PhaserRenderModuleConfig): void {
    const coords = new CoordSpace(config.scene, config.pixelsPerMeter);
    const world = this.world;

    world.component(VGameObject).onRemove((_entity, vgo) => vgo.obj.destroy());
    // Teardown must run before creation so Arc->Rectangle in one frame can remove the
    // old VGameObject before the new shape's .without(VGameObject) query runs.
    registerRenderSystems(world, coords);
    registerCreationSystems(world, config.scene, coords);
    registerSyncSystems(world, coords);
  }
}

interface RenderObject extends Phaser.GameObjects.GameObject {
  setAlpha(value: number): this;
  setDepth(value: number): this;
  setFillStyle(color: number, alpha?: number): this;
  setOrigin(x: number, y?: number): this;
  setPosition(x: number, y: number): this;
  setRotation(radians: number): this;
  setScale(x: number, y?: number): this;
  setStrokeStyle(lineWidth: number, color: number, alpha?: number): this;
}

interface ArcObject extends RenderObject {
  setEndAngle(degrees: number, anticlockwise?: boolean): this;
  setIterations(iterations: number): this;
  setRadius(radius: number): this;
  setStartAngle(degrees: number, anticlockwise?: boolean): this;
}

interface SizeGameObject extends RenderObject {
  setSize(width: number, height: number): this;
}

interface StarGameObject extends RenderObject {
  setInnerRadius(value: number): this;
  setOuterRadius(value: number): this;
  setPoints(points: number): this;
}

interface TextObject extends RenderObject {
  setStyle(style: Phaser.Types.GameObjects.Text.TextStyle): this;
  setText(value: string): this;
}

interface VertexGameObject extends RenderObject {
  setTo(...coordinates: readonly number[]): this;
}

function registerRenderSystems(world: World, coords: CoordSpace): void {
  registerArcRenderSystem(world, coords);
  registerEllipseRenderSystem(world, coords);
  registerRectangleRenderSystem(world, coords);
  registerPolygonRenderSystem(world, coords);
  registerLineRenderSystem(world, coords);
  registerTriangleRenderSystem(world, coords);
  registerStarRenderSystem(world, coords);
  registerTextRenderSystem(world);
}

function registerCreationSystems(world: World, scene: Phaser.Scene, coords: CoordSpace): void {
  registerArcCreationSystem(world, scene, coords);
  registerEllipseCreationSystem(world, scene, coords);
  registerRectangleCreationSystem(world, scene, coords);
  registerPolygonCreationSystem(world, scene, coords);
  registerLineCreationSystem(world, scene, coords);
  registerTriangleCreationSystem(world, scene, coords);
  registerStarCreationSystem(world, scene, coords);
  registerTextCreationSystem(world, scene);
}

function registerSyncSystems(world: World, coords: CoordSpace): void {
  world
    .system("phaser.sync.position")
    .with(Position, VGameObject)
    .phase(ON_STORE)
    .enter([Position, VGameObject], (_entity, [position, vgo]) =>
      syncPosition(coords, vgo, position)
    )
    .update(Position, [VGameObject], (_entity, position, [vgo]) =>
      syncPosition(coords, vgo, position)
    );

  world
    .system("phaser.sync.rotation")
    .with(Rotation, VGameObject)
    .phase(ON_STORE)
    .enter([Rotation, VGameObject], (_entity, [rotation, vgo]) =>
      syncRotation(coords, vgo, rotation)
    )
    .update(Rotation, [VGameObject], (_entity, rotation, [vgo]) =>
      syncRotation(coords, vgo, rotation)
    );

  world
    .system("phaser.sync.scale")
    .with(Scale, VGameObject)
    .phase(ON_STORE)
    .enter([Scale, VGameObject], (_entity, [scale, vgo]) => syncScale(vgo, scale))
    .update(Scale, [VGameObject], (_entity, scale, [vgo]) => syncScale(vgo, scale));

  world
    .system("phaser.sync.alpha")
    .with(Alpha, VGameObject)
    .phase(ON_STORE)
    .enter([Alpha, VGameObject], (_entity, [alpha, vgo]) => syncAlpha(vgo, alpha))
    .update(Alpha, [VGameObject], (_entity, alpha, [vgo]) => syncAlpha(vgo, alpha));

  world
    .system("phaser.sync.depth")
    .with(Depth, VGameObject)
    .phase(ON_STORE)
    .enter([Depth, VGameObject], (_entity, [depth, vgo]) => syncDepth(vgo, depth))
    .update(Depth, [VGameObject], (_entity, depth, [vgo]) => syncDepth(vgo, depth));

  world
    .system("phaser.sync.fill-style")
    .with(FillStyle, VGameObject)
    .phase(ON_STORE)
    .enter([FillStyle, VGameObject], (_entity, [fill, vgo]) => syncFillStyle(vgo, fill))
    .update(FillStyle, [VGameObject], (_entity, fill, [vgo]) => syncFillStyle(vgo, fill));

  world
    .system("phaser.sync.stroke-style")
    .with(StrokeStyle, VGameObject)
    .phase(ON_STORE)
    .enter([StrokeStyle, VGameObject], (_entity, [stroke, vgo]) => syncStrokeStyle(vgo, stroke))
    .update(StrokeStyle, [VGameObject], (_entity, stroke, [vgo]) => syncStrokeStyle(vgo, stroke));
}

function registerArcCreationSystem(world: World, scene: Phaser.Scene, coords: CoordSpace): void {
  world
    .system("phaser.new.arc")
    .with(Arc)
    .without(VGameObject)
    .phase(ON_STORE)
    .enter([Arc], (entity, [arc]) => {
      const obj = scene.add.arc(
        0,
        0,
        coords.len(arc.radius),
        coords.deg(arc.startAngle),
        coords.deg(arc.endAngle),
        arc.anticlockwise
      ) as ArcObject;
      obj.setIterations(arc.iterations);
      entity.set(VGameObject, { obj });
    });
}

function registerArcRenderSystem(world: World, coords: CoordSpace): void {
  world
    .system("phaser.render.arc")
    .with(Arc, VGameObject)
    .phase(ON_STORE)
    .update(Arc, [VGameObject], (_entity, arc, [vgo]) => {
      if (vgo === undefined) {
        return;
      }
      (vgo.obj as ArcObject)
        .setRadius(coords.len(arc.radius))
        .setStartAngle(coords.deg(arc.startAngle), arc.anticlockwise)
        .setEndAngle(coords.deg(arc.endAngle), arc.anticlockwise)
        .setIterations(arc.iterations);
    })
    .exit([Arc, VGameObject], (entity) => removeGameObject(entity));
}

function registerEllipseCreationSystem(
  world: World,
  scene: Phaser.Scene,
  coords: CoordSpace
): void {
  world
    .system("phaser.new.ellipse")
    .with(Ellipse)
    .without(VGameObject)
    .phase(ON_STORE)
    .enter([Ellipse], (entity, [ellipse]) => {
      const obj = scene.add.ellipse(
        0,
        0,
        coords.len(ellipse.width),
        coords.len(ellipse.height)
      ) as unknown as SizeGameObject;
      entity.set(VGameObject, { obj });
    });
}

function registerEllipseRenderSystem(world: World, coords: CoordSpace): void {
  world
    .system("phaser.render.ellipse")
    .with(Ellipse, VGameObject)
    .phase(ON_STORE)
    .update(Ellipse, [VGameObject], (_entity, ellipse, [vgo]) => {
      if (vgo === undefined) {
        return;
      }
      (vgo.obj as SizeGameObject).setSize(coords.len(ellipse.width), coords.len(ellipse.height));
    })
    .exit([Ellipse, VGameObject], (entity) => removeGameObject(entity));
}

function registerLineCreationSystem(world: World, scene: Phaser.Scene, coords: CoordSpace): void {
  world
    .system("phaser.new.line")
    .with(Line)
    .without(VGameObject)
    .phase(ON_STORE)
    .enter([Line], (entity, [line]) => {
      const points = linePoints(coords, line);
      const obj = scene.add.line(0, 0, points[0], points[1], points[2], points[3]) as LineObject;
      obj.setOrigin(0, 0);
      entity.set(VGameObject, { obj });
    });
}

type LineObject = Phaser.GameObjects.Line & VertexGameObject;

function registerLineRenderSystem(world: World, coords: CoordSpace): void {
  world
    .system("phaser.render.line")
    .with(Line, VGameObject)
    .phase(ON_STORE)
    .update(Line, [VGameObject], (_entity, line, [vgo]) => {
      if (vgo === undefined) {
        return;
      }
      const obj = vgo.obj as LineObject;
      obj.setTo(...linePoints(coords, line));
      obj.setOrigin(0, 0);
    })
    .exit([Line, VGameObject], (entity) => removeGameObject(entity));
}

function registerPolygonCreationSystem(
  world: World,
  scene: Phaser.Scene,
  coords: CoordSpace
): void {
  world
    .system("phaser.new.polygon")
    .with(Polygon)
    .without(VGameObject)
    .phase(ON_STORE)
    .enter([Polygon], (entity, [polygon]) => {
      const obj = scene.add.polygon(0, 0, polygonPoints(coords, polygon)) as PolygonObject;
      obj.setOrigin(0, 0);
      entity.set(VGameObject, { obj });
    });
}

type PolygonObject = Phaser.GameObjects.Polygon & VertexGameObject;

function registerPolygonRenderSystem(world: World, coords: CoordSpace): void {
  world
    .system("phaser.render.polygon")
    .with(Polygon, VGameObject)
    .phase(ON_STORE)
    .update(Polygon, [VGameObject], (_entity, polygon, [vgo]) => {
      if (vgo === undefined) {
        return;
      }
      const obj = vgo.obj as PolygonObject;
      obj.setTo(polygonPoints(coords, polygon));
      obj.setOrigin(0, 0);
    })
    .exit([Polygon, VGameObject], (entity) => removeGameObject(entity));
}

function registerRectangleCreationSystem(
  world: World,
  scene: Phaser.Scene,
  coords: CoordSpace
): void {
  world
    .system("phaser.new.rectangle")
    .with(Rectangle)
    .without(VGameObject)
    .phase(ON_STORE)
    .enter([Rectangle], (entity, [rectangle]) => {
      const obj = scene.add.rectangle(
        0,
        0,
        coords.len(rectangle.width),
        coords.len(rectangle.height)
      ) as RectangleObject;
      entity.set(VGameObject, { obj });
    });
}

type RectangleObject = Phaser.GameObjects.Rectangle & SizeGameObject;

function registerRectangleRenderSystem(world: World, coords: CoordSpace): void {
  world
    .system("phaser.render.rectangle")
    .with(Rectangle, VGameObject)
    .phase(ON_STORE)
    .update(Rectangle, [VGameObject], (_entity, rectangle, [vgo]) => {
      if (vgo === undefined) {
        return;
      }
      (vgo.obj as RectangleObject).setSize(
        coords.len(rectangle.width),
        coords.len(rectangle.height)
      );
    })
    .exit([Rectangle, VGameObject], (entity) => removeGameObject(entity));
}

function registerStarCreationSystem(world: World, scene: Phaser.Scene, coords: CoordSpace): void {
  world
    .system("phaser.new.star")
    .with(Star)
    .without(VGameObject)
    .phase(ON_STORE)
    .enter([Star], (entity, [star]) => {
      const obj = scene.add.star(
        0,
        0,
        star.points,
        coords.len(star.innerRadius),
        coords.len(star.outerRadius)
      ) as unknown as StarGameObject;
      entity.set(VGameObject, { obj });
    });
}

function registerStarRenderSystem(world: World, coords: CoordSpace): void {
  world
    .system("phaser.render.star")
    .with(Star, VGameObject)
    .phase(ON_STORE)
    .update(Star, [VGameObject], (_entity, star, [vgo]) => {
      if (vgo === undefined) {
        return;
      }
      const obj = vgo.obj as StarGameObject;
      obj.setPoints(star.points);
      obj.setInnerRadius(coords.len(star.innerRadius));
      obj.setOuterRadius(coords.len(star.outerRadius));
    })
    .exit([Star, VGameObject], (entity) => removeGameObject(entity));
}

function registerTextCreationSystem(world: World, scene: Phaser.Scene): void {
  world
    .system("phaser.new.text")
    .with(TextComponent)
    .without(VGameObject)
    .phase(ON_STORE)
    .enter([TextComponent], (entity, [text]) => {
      const obj = scene.add.text(0, 0, text.value, textStyle(text)) as unknown as TextObject;
      obj.setOrigin(0.5);
      entity.set(VGameObject, { obj });
    });
}

function registerTextRenderSystem(world: World): void {
  world
    .system("phaser.render.text")
    .with(TextComponent, VGameObject)
    .phase(ON_STORE)
    .update(TextComponent, [VGameObject], (_entity, text, [vgo]) => {
      if (vgo === undefined) {
        return;
      }
      const obj = vgo.obj as TextObject;
      obj.setText(text.value);
      obj.setStyle(textStyle(text));
      obj.setOrigin(0.5);
    })
    .exit([TextComponent, VGameObject], (entity) => removeGameObject(entity));
}

function registerTriangleCreationSystem(
  world: World,
  scene: Phaser.Scene,
  coords: CoordSpace
): void {
  world
    .system("phaser.new.triangle")
    .with(Triangle)
    .without(VGameObject)
    .phase(ON_STORE)
    .enter([Triangle], (entity, [triangle]) => {
      const obj = scene.add.triangle(
        0,
        0,
        ...triangleCoordinates(coords, triangle)
      ) as TriangleObject;
      obj.setOrigin(0, 0);
      entity.set(VGameObject, { obj });
    });
}

type TriangleObject = Phaser.GameObjects.Triangle & VertexGameObject;

function registerTriangleRenderSystem(world: World, coords: CoordSpace): void {
  world
    .system("phaser.render.triangle")
    .with(Triangle, VGameObject)
    .phase(ON_STORE)
    .update(Triangle, [VGameObject], (_entity, triangle, [vgo]) => {
      if (vgo === undefined) {
        return;
      }
      const obj = vgo.obj as TriangleObject;
      obj.setTo(...triangleCoordinates(coords, triangle));
      obj.setOrigin(0, 0);
    })
    .exit([Triangle, VGameObject], (entity) => removeGameObject(entity));
}

function removeGameObject(entity: Entity): void {
  if (entity.has(VGameObject)) {
    entity.remove(VGameObject);
  }
}

function hexColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

function linePoints(coords: CoordSpace, line: Line): [number, number, number, number] {
  return [coords.rx(line.x1), coords.ry(line.y1), coords.rx(line.x2), coords.ry(line.y2)];
}

function polygonPoints(coords: CoordSpace, polygon: Polygon): number[] {
  const points: number[] = [];
  for (let i = 0; i < polygon.points.length; i += 2) {
    points.push(coords.rx(polygon.points[i] ?? 0), coords.ry(polygon.points[i + 1] ?? 0));
  }
  return points;
}

function syncAlpha(vgo: VGameObject, alpha: Alpha): void {
  (vgo.obj as RenderObject).setAlpha(alpha.value);
}

function syncDepth(vgo: VGameObject, depth: Depth): void {
  (vgo.obj as RenderObject).setDepth(depth.value);
}

function syncFillStyle(vgo: VGameObject, fill: FillStyle): void {
  (vgo.obj as RenderObject).setFillStyle(fill.color, fill.alpha);
}

function syncPosition(coords: CoordSpace, vgo: VGameObject, position: Position): void {
  (vgo.obj as RenderObject).setPosition(coords.x(position.x), coords.y(position.y));
}

function syncRotation(coords: CoordSpace, vgo: VGameObject, rotation: Rotation): void {
  (vgo.obj as RenderObject).setRotation(coords.rot(rotation.angle));
}

function syncScale(vgo: VGameObject, scale: Scale): void {
  (vgo.obj as RenderObject).setScale(scale.x, scale.y);
}

function syncStrokeStyle(vgo: VGameObject, stroke: StrokeStyle): void {
  (vgo.obj as RenderObject).setStrokeStyle(stroke.width, stroke.color, stroke.alpha);
}

function textAlign(value: TextAlign): "center" | "left" | "right" {
  switch (value) {
    case TextAlign.Center:
      return "center";
    case TextAlign.Right:
      return "right";
    default:
      return "left";
  }
}

function textStyle(text: TextComponent): Phaser.Types.GameObjects.Text.TextStyle {
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

function triangleCoordinates(
  coords: CoordSpace,
  triangle: Triangle
): readonly [number, number, number, number, number, number] {
  return [
    coords.rx(triangle.x1),
    coords.ry(triangle.y1),
    coords.rx(triangle.x2),
    coords.ry(triangle.y2),
    coords.rx(triangle.x3),
    coords.ry(triangle.y3),
  ];
}
