import { type ComponentClass, type Entity } from "@vworlds/vecs";
import {
  Alpha,
  Arc,
  Depth,
  Ellipse,
  FillStyle,
  Line,
  phaserRenderableComponents,
  Polygon,
  Position,
  Rectangle,
  Rotation,
  Scale,
  Star,
  StrokeStyle,
  Text,
  Triangle,
} from "@vworlds/vecs-phaser";
import { Networked, type ServerWorld } from "@vworlds/vecs-server";

export interface RenderProps {
  alpha?: Partial<Alpha>;
  depth?: Partial<Depth>;
  fillStyle?: Partial<FillStyle>;
  position?: Partial<Position>;
  rotation?: Partial<Rotation>;
  scale?: Partial<Scale>;
  strokeStyle?: Partial<StrokeStyle>;
}

export type ArcProps = Partial<Arc> & RenderProps;
export type EllipseProps = Partial<Ellipse> & RenderProps;
export type LineProps = Partial<Line> & RenderProps;
export type PolygonProps = Partial<Polygon> & RenderProps;
export type RectangleProps = Partial<Rectangle> & RenderProps;
export type StarProps = Partial<Star> & RenderProps;
export type TextProps = Partial<Text> & RenderProps;
export type TriangleProps = Partial<Triangle> & RenderProps;

export function registerRenderExclusivity(world: ServerWorld): void {
  world.setExclusiveComponents(...phaserRenderableComponents);
}

export function createArc(world: ServerWorld, props: ArcProps = {}): Entity {
  const { alpha, depth, fillStyle, position, rotation, scale, strokeStyle, ...shape } = props;
  return createRenderable(world, Arc, shape, {
    alpha,
    depth,
    fillStyle,
    position,
    rotation,
    scale,
    strokeStyle,
  });
}

export function createEllipse(world: ServerWorld, props: EllipseProps = {}): Entity {
  const { alpha, depth, fillStyle, position, rotation, scale, strokeStyle, ...shape } = props;
  return createRenderable(world, Ellipse, shape, {
    alpha,
    depth,
    fillStyle,
    position,
    rotation,
    scale,
    strokeStyle,
  });
}

export function createRectangle(world: ServerWorld, props: RectangleProps = {}): Entity {
  const { alpha, depth, fillStyle, position, rotation, scale, strokeStyle, ...shape } = props;
  return createRenderable(world, Rectangle, shape, {
    alpha,
    depth,
    fillStyle,
    position,
    rotation,
    scale,
    strokeStyle,
  });
}

export function createPolygon(world: ServerWorld, props: PolygonProps = {}): Entity {
  const { alpha, depth, fillStyle, position, rotation, scale, strokeStyle, ...shape } = props;
  return createRenderable(world, Polygon, shape, {
    alpha,
    depth,
    fillStyle,
    position,
    rotation,
    scale,
    strokeStyle,
  });
}

export function createLine(world: ServerWorld, props: LineProps = {}): Entity {
  const { alpha, depth, fillStyle, position, rotation, scale, strokeStyle, ...shape } = props;
  return createRenderable(world, Line, shape, {
    alpha,
    depth,
    fillStyle,
    position,
    rotation,
    scale,
    strokeStyle,
  });
}

export function createTriangle(world: ServerWorld, props: TriangleProps = {}): Entity {
  const { alpha, depth, fillStyle, position, rotation, scale, strokeStyle, ...shape } = props;
  return createRenderable(world, Triangle, shape, {
    alpha,
    depth,
    fillStyle,
    position,
    rotation,
    scale,
    strokeStyle,
  });
}

export function createStar(world: ServerWorld, props: StarProps = {}): Entity {
  const { alpha, depth, fillStyle, position, rotation, scale, strokeStyle, ...shape } = props;
  return createRenderable(world, Star, shape, {
    alpha,
    depth,
    fillStyle,
    position,
    rotation,
    scale,
    strokeStyle,
  });
}

export function createText(world: ServerWorld, props: TextProps = {}): Entity {
  const { alpha, depth, fillStyle, position, rotation, scale, strokeStyle, ...shape } = props;
  return createRenderable(world, Text, shape, {
    alpha,
    depth,
    fillStyle,
    position,
    rotation,
    scale,
    strokeStyle,
  });
}

function createRenderable<C extends ComponentClass>(
  world: ServerWorld,
  Shape: C,
  shapeProps: Partial<InstanceType<C>>,
  renderProps: RenderProps
): Entity {
  const entity = world.entity().add(Networked).set(Shape, shapeProps);
  applyRenderProps(entity, renderProps);
  return entity;
}

function applyRenderProps(entity: Entity, props: RenderProps): void {
  if (props.position !== undefined) {
    entity.set(Position, props.position);
  }
  if (props.rotation !== undefined) {
    entity.set(Rotation, props.rotation);
  }
  if (props.scale !== undefined) {
    entity.set(Scale, props.scale);
  }
  if (props.alpha !== undefined) {
    entity.set(Alpha, props.alpha);
  }
  if (props.depth !== undefined) {
    entity.set(Depth, props.depth);
  }
  if (props.fillStyle !== undefined) {
    entity.set(FillStyle, props.fillStyle);
  }
  if (props.strokeStyle !== undefined) {
    entity.set(StrokeStyle, props.strokeStyle);
  }
}
