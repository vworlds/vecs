import { ChildOf, Iter, type Entity, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Box, Capsule, Circle, Polygon, Segment, SingleShape } from "../components/geometry.js";
import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { CollisionFilter, Detectable, Material, Sensor } from "../components/material.js";
import { ShapePosition, ShapeRotation } from "../components/shape_pose.js";
import { type Box2DModule } from "../adapter/runtime.js";
import {
  type b2BodyId,
  type b2ShapeId,
  PhysicsSystemTag,
  type PhysicsEngine,
} from "../adapter/engine.js";
import { withAllocated } from "../adapter/disposal.js";
import { singleShapeWithBodyParent } from "./shape_predicates.js";

const MAX_POLYGON_VERTICES = 8;

export function installShapeLifecycle(world: World, engine: PhysicsEngine, phase: Entity): void {
  const system = world.system("PhysicsShapeLifecycle").with(singleShapeWithBodyParent).phase(phase);
  system.entity.add(PhysicsSystemTag);

  system.enter(Iter, [SingleShape, { target: [ChildOf, [Body]] }], (it, [shape, body]) => {
    createShapeForEntity(engine, it.entity, it.src[1], body, shape);
  });

  // Inject `[ChildOf, Shape]` so the parent relationship and shape handle are
  // captured in the exit snapshot while the entity's components are still
  // present. The exit callback itself runs on the next tick's inbox drain,
  // after `_destroy` has cleared `entity._components` -- by then
  // `entity.target(ChildOf)` and `entity.get(Shape)` would return `undefined`.
  system.exit([ChildOf, SingleShape], (entity, [childOf, shape]) => {
    destroyShapeForEntity(engine, entity, true, childOf?.target, shape);
  });

  system.update(Iter, SingleShape, [{ target: [ChildOf, [Body]] }], (it, shape, [body]) => {
    if (
      (shape instanceof Capsule && !hasValidEndpoints(shape.x1, shape.y1, shape.x2, shape.y2)) ||
      (shape instanceof Segment && !hasValidEndpoints(shape.x1, shape.y1, shape.x2, shape.y2))
    ) {
      return;
    }
    recreateSingleShapeForEntity(engine, it.entity, it.src[0], body, shape);
  });

  const childOfSystem = world
    .system("PhysicsShapeLifecycle:ChildOf")
    .with(ChildOf, singleShapeWithBodyParent)
    .phase(phase)
    .update(
      Iter,
      ChildOf,
      [SingleShape, { target: [ChildOf, [Body]] }],
      (it, _childOf, [shape, body]) => {
        recreateSingleShapeForEntity(engine, it.entity, it.src[1], body, shape);
      }
    );
  childOfSystem.entity.add(PhysicsSystemTag);
}

export function recreateSingleShapeForEntity(
  engine: PhysicsEngine,
  entity: Entity,
  parentEntity: Entity | undefined,
  parentBody: Body | undefined,
  shape: SingleShape | undefined
): void {
  destroyShapeForEntity(engine, entity, false, parentEntity, shape);
  createShapeForEntity(engine, entity, parentEntity, parentBody, shape);
}

function createShapeForEntity(
  engine: PhysicsEngine,
  entity: Entity,
  parentEntity: Entity | undefined,
  parentBody: Body | undefined,
  shape: SingleShape | undefined
): void {
  const bodyId = parentBody?._bodyId;
  if (parentEntity === undefined || bodyId === undefined || shape === undefined) {
    return;
  }

  const options = readShapeOptions(entity);
  const pose = readLocalPose(entity);
  const shapeId = createSingleShape(engine, bodyId, shape, options, pose);
  if (shapeId !== undefined) {
    shape._shapeId = shapeId;
    engine.entityByShapeIndex.set(shapeId.index1, entity.eid);
    engine.dirtyMassBodies.add(parentEntity.eid);
  }
}

function destroyShapeForEntity(
  engine: PhysicsEngine,
  entity: Entity,
  allowCascadeSkip: boolean,
  parent?: Entity,
  shape?: Readonly<SingleShape>
): void {
  const resolvedParent = parent ?? entity.parent;
  const resolvedShape = shape ?? entity.get(SingleShape);
  const shapeId = resolvedShape?._shapeId;
  if (shapeId === undefined) {
    return;
  }

  const parentBodyExists = parentBodyStillExists(resolvedParent);
  if ((!allowCascadeSkip || parentBodyExists) && engine.box2d.b2Shape_IsValid(shapeId)) {
    engine.box2d.b2DestroyShape(shapeId, true);
  }
  engine.entityByShapeIndex.delete(shapeId.index1);
  markParentBodyMassDirty(engine, resolvedParent);

  // Clear the handle on the live component if it still exists (e.g. the
  // parent body was removed and the shape entity remains, no longer matching
  // the lifecycle predicate). When `shape` was injected from an exit
  // snapshot, `entity.get(Shape)` is already cleared by `_destroy` and this
  // is a no-op.
  const mutableShape = entity.get(SingleShape) as SingleShape | undefined;
  if (mutableShape !== undefined) {
    mutableShape._shapeId = undefined;
  }
}

function createSingleShape(
  engine: PhysicsEngine,
  bodyId: b2BodyId,
  shape: SingleShape,
  options: ShapeOptions,
  pose: { x: number; y: number; angle: number }
): b2ShapeId | undefined {
  const box2d = engine.box2d;
  return withAllocated(box2d.b2DefaultShapeDef, (def) => {
    applyShapeDef(def, options);

    if (shape instanceof Box) {
      return withAllocated(
        () => new box2d.b2Vec2(pose.x, pose.y),
        (center) =>
          withAllocated(
            () => new box2d.b2Rot(),
            (rot) => {
              rot.SetAngle(pose.angle);
              const polygon = box2d.b2MakeOffsetBox(shape.hx, shape.hy, center, rot);
              try {
                return box2d.b2CreatePolygonShape(bodyId, def, polygon);
              } finally {
                polygon.delete();
              }
            }
          )
      );
    }

    if (shape instanceof Circle) {
      return withAllocated(
        () => new box2d.b2Circle(),
        (wasmShape) => {
          wasmShape.center.Set(pose.x, pose.y);
          wasmShape.radius = shape.radius;
          return box2d.b2CreateCircleShape(bodyId, def, wasmShape);
        }
      );
    }

    if (shape instanceof Capsule) {
      if (!hasValidEndpoints(shape.x1, shape.y1, shape.x2, shape.y2)) {
        return undefined;
      }
      return withAllocated(
        () => new box2d.b2Capsule(),
        (wasmShape) => {
          wasmShape.center1.Set(shape.x1 + pose.x, shape.y1 + pose.y);
          wasmShape.center2.Set(shape.x2 + pose.x, shape.y2 + pose.y);
          wasmShape.radius = shape.radius;
          return box2d.b2CreateCapsuleShape(bodyId, def, wasmShape);
        }
      );
    }

    if (shape instanceof Segment) {
      if (!hasValidEndpoints(shape.x1, shape.y1, shape.x2, shape.y2)) {
        return undefined;
      }
      return withAllocated(
        () => new box2d.b2Segment(),
        (wasmShape) => {
          wasmShape.point1.Set(shape.x1 + pose.x, shape.y1 + pose.y);
          wasmShape.point2.Set(shape.x2 + pose.x, shape.y2 + pose.y);
          return box2d.b2CreateSegmentShape(bodyId, def, wasmShape);
        }
      );
    }

    if (shape instanceof Polygon) {
      return createPolygonShape(engine, bodyId, def, shape, pose);
    }

    return undefined;
  });
}

function createPolygonShape(
  engine: PhysicsEngine,
  bodyId: b2BodyId,
  def: ReturnType<Box2DModule["b2DefaultShapeDef"]>,
  polygon: Polygon,
  pose: { x: number; y: number; angle: number }
): b2ShapeId | undefined {
  if (polygon.vertices.length > MAX_POLYGON_VERTICES || polygon.vertices.length < 3) {
    return undefined;
  }

  const box2d = engine.box2d;
  const points = polygon.vertices.map((point) => new box2d.b2Vec2(point.x, point.y));
  try {
    const hull = box2d.b2ComputeHull(points);
    try {
      if (hull.count < 3) {
        return undefined;
      }
      const wasmPolygon = box2d.b2MakePolygon(hull, polygon.radius);
      try {
        return box2d.b2CreatePolygonShape(bodyId, def, wasmPolygon);
      } finally {
        wasmPolygon.delete();
      }
    } finally {
      hull.delete();
    }
  } finally {
    for (const point of points) {
      point.delete();
    }
  }
}

function applyShapeDef(
  def: ReturnType<Box2DModule["b2DefaultShapeDef"]>,
  options: ShapeOptions
): void {
  def.density = options.density;
  def.isSensor = options.sensor;
  def.enableSensorEvents = options.enableSensorEvents;
  def.enableContactEvents = options.enableContactEvents;
  def.enableHitEvents = options.enableHitEvents;
  def.filter.categoryBits = options.categoryBits;
  def.filter.maskBits = options.maskBits;
  def.filter.groupIndex = options.groupIndex;
  def.material.friction = options.friction;
  def.material.restitution = options.restitution;
  def.material.rollingResistance = options.rollingResistance;
  def.material.tangentSpeed = options.tangentSpeed;
  def.material.userMaterialId = BigInt(options.userMaterialId);
}

export function applyChainDef(
  def: ReturnType<Box2DModule["b2DefaultChainDef"]>,
  options: ShapeOptions
): void {
  def.filter.categoryBits = options.categoryBits;
  def.filter.maskBits = options.maskBits;
  def.filter.groupIndex = options.groupIndex;
  const material = def.GetMaterials()[0];
  material.friction = options.friction;
  material.restitution = options.restitution;
  material.rollingResistance = options.rollingResistance;
  material.tangentSpeed = options.tangentSpeed;
  material.userMaterialId = BigInt(options.userMaterialId);
  def.materialCount = 1;
  def.enableSensorEvents = options.enableSensorEvents;
}

export function readShapeOptions(entity: Entity): ShapeOptions {
  const material = entity.get(Material);
  const filter = entity.get(CollisionFilter);
  return {
    density: material?.density ?? 1,
    friction: material?.friction ?? 0.6,
    restitution: material?.restitution ?? 0,
    rollingResistance: material?.rollingResistance ?? 0,
    tangentSpeed: material?.tangentSpeed ?? 0,
    userMaterialId: material?.userMaterialId ?? 0,
    categoryBits: filter?.categoryBits ?? 1,
    maskBits: filter?.maskBits ?? 0xffffffff,
    groupIndex: filter?.groupIndex ?? 0,
    sensor: entity.get(Sensor) !== undefined,
    enableContactEvents: entity.get(ContactEvents) !== undefined,
    enableHitEvents: entity.get(HitEvents) !== undefined,
    enableSensorEvents:
      entity.get(SensorEvents) !== undefined || entity.get(Detectable) !== undefined,
  };
}

export function readLocalPose(entity: Entity): { x: number; y: number; angle: number } {
  return {
    x: entity.get(ShapePosition)?.x ?? 0,
    y: entity.get(ShapePosition)?.y ?? 0,
    angle: entity.get(ShapeRotation)?.angle ?? 0,
  };
}

export function parentBodyStillExists(parent?: Entity): boolean {
  return parent !== undefined && parent.get(Body)?._bodyId !== undefined;
}

export function markParentBodyMassDirty(engine: PhysicsEngine, parent?: Entity): void {
  if (parent !== undefined && parent.get(Body)?._bodyId !== undefined) {
    engine.dirtyMassBodies.add(parent.eid);
  }
}

function hasValidEndpoints(ax: number, ay: number, bx: number, by: number): boolean {
  const LINEAR_SLOP = 0.005;
  return (bx - ax) ** 2 + (by - ay) ** 2 > LINEAR_SLOP * LINEAR_SLOP;
}

export interface ShapeOptions {
  density: number;
  friction: number;
  restitution: number;
  rollingResistance: number;
  tangentSpeed: number;
  userMaterialId: number;
  categoryBits: number;
  maskBits: number;
  groupIndex: number;
  sensor: boolean;
  enableContactEvents: boolean;
  enableHitEvents: boolean;
  enableSensorEvents: boolean;
}
