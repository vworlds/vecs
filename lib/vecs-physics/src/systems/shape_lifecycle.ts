import { ChildOf, type Entity, type IPhase, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "../components/geometry.js";
import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { CollisionFilter, Material, Sensor } from "../components/material.js";
import { ShapePosition, ShapeRotation } from "../components/shape_pose.js";
import { type Box2DModule } from "../adapter/runtime.js";
import { type b2BodyId, type b2ShapeId, type PhysicsState } from "../adapter/state.js";
import { withAllocated } from "../adapter/disposal.js";

const MAX_POLYGON_VERTICES = 8;

export function installShapeLifecycle(world: World, state: PhysicsState, phase: IPhase): System {
  const system = world
    .system("PhysicsShapeLifecycle")
    .query({ all: [{ any: [Box, Circle, Capsule, Segment, Polygon, Chain] }, { parent: Body }] })
    .phase(phase);

  system.enter((entity) => {
    createShapeForEntity(state, entity);
  });

  system.exit((entity) => {
    destroyShapeForEntity(state, entity, true);
  });

  system.update(Box, (entity) => {
    recreateShapeForEntity(state, entity);
  });
  system.update(Circle, (entity) => {
    recreateShapeForEntity(state, entity);
  });
  system.update(Capsule, (entity) => {
    const capsule = entity.get(Capsule);
    if (
      capsule !== undefined &&
      !hasValidEndpoints(capsule.x1, capsule.y1, capsule.x2, capsule.y2)
    ) {
      return;
    }
    recreateShapeForEntity(state, entity);
  });
  system.update(Segment, (entity) => {
    const segment = entity.get(Segment);
    if (
      segment !== undefined &&
      !hasValidEndpoints(segment.x1, segment.y1, segment.x2, segment.y2)
    ) {
      return;
    }
    recreateShapeForEntity(state, entity);
  });
  system.update(Polygon, (entity) => {
    recreateShapeForEntity(state, entity);
  });
  system.update(Chain, (entity) => {
    recreateShapeForEntity(state, entity);
  });
  system.update(ChildOf, (entity) => {
    recreateShapeForEntity(state, entity);
  });

  return system;
}

export function recreateShapeForEntity(state: PhysicsState, entity: Entity): void {
  destroyShapeForEntity(state, entity, false);
  createShapeForEntity(state, entity);
}

function createShapeForEntity(state: PhysicsState, entity: Entity): void {
  const parentEntity = entity.parent(ChildOf);
  if (parentEntity === undefined) {
    return;
  }
  const bodyId = state.bodyByEntityWasm.get(parentEntity.eid);
  if (bodyId === undefined) {
    return;
  }

  const options = readShapeOptions(entity);
  const pose = readLocalPose(entity);
  const chain = entity.get(Chain);
  if (chain !== undefined) {
    createChain(state, entity, bodyId, chain, options, pose);
    return;
  }

  const shapeId = createSingleShape(state, entity, bodyId, options, pose);
  if (shapeId !== undefined) {
    state.shapeByEntityWasm.set(entity.eid, shapeId);
    state.entityByShapeIndex.set(shapeId.index1, entity.eid);
    state.shapeEntityByEid.set(entity.eid, entity);
    state.dirtyMassBodies.add(parentEntity.eid);
  }
}

function destroyShapeForEntity(
  state: PhysicsState,
  entity: Entity,
  allowCascadeSkip: boolean
): void {
  const chainId = state.chainByEntity.get(entity.eid);
  if (chainId !== undefined) {
    const parentBodyExists = parentBodyStillExists(state, entity);
    if (!allowCascadeSkip || parentBodyExists || state.box2d.b2Chain_IsValid(chainId)) {
      if (state.box2d.b2Chain_IsValid(chainId)) {
        state.box2d.b2DestroyChain(chainId);
      }
    }
    state.chainByEntity.delete(entity.eid);
    markParentBodyMassDirty(state, entity);
  }

  const shapeId = state.shapeByEntityWasm.get(entity.eid);
  if (shapeId !== undefined) {
    const parentBodyExists = parentBodyStillExists(state, entity);
    if ((!allowCascadeSkip || parentBodyExists) && state.box2d.b2Shape_IsValid(shapeId)) {
      state.box2d.b2DestroyShape(shapeId, true);
    }
    state.shapeByEntityWasm.delete(entity.eid);
    state.entityByShapeIndex.delete(shapeId.index1);
    markParentBodyMassDirty(state, entity);
  }
}

function createSingleShape(
  state: PhysicsState,
  entity: Entity,
  bodyId: b2BodyId,
  options: ShapeOptions,
  pose: { x: number; y: number; angle: number }
): b2ShapeId | undefined {
  const box2d = state.box2d;
  return withAllocated(box2d.b2DefaultShapeDef, (def) => {
    applyShapeDef(def, options);

    const box = entity.get(Box);
    if (box !== undefined) {
      return withAllocated(
        () => new box2d.b2Vec2(pose.x, pose.y),
        (center) =>
          withAllocated(
            () => new box2d.b2Rot(),
            (rot) => {
              rot.SetAngle(pose.angle);
              const polygon = box2d.b2MakeOffsetBox(box.hx, box.hy, center, rot);
              try {
                return box2d.b2CreatePolygonShape(bodyId, def, polygon);
              } finally {
                polygon.delete();
              }
            }
          )
      );
    }

    const circle = entity.get(Circle);
    if (circle !== undefined) {
      return withAllocated(
        () => new box2d.b2Circle(),
        (shape) => {
          shape.center.Set(pose.x, pose.y);
          shape.radius = circle.radius;
          return box2d.b2CreateCircleShape(bodyId, def, shape);
        }
      );
    }

    const capsule = entity.get(Capsule);
    if (capsule !== undefined) {
      if (!hasValidEndpoints(capsule.x1, capsule.y1, capsule.x2, capsule.y2)) {
        return undefined;
      }
      return withAllocated(
        () => new box2d.b2Capsule(),
        (shape) => {
          shape.center1.Set(capsule.x1 + pose.x, capsule.y1 + pose.y);
          shape.center2.Set(capsule.x2 + pose.x, capsule.y2 + pose.y);
          shape.radius = capsule.radius;
          return box2d.b2CreateCapsuleShape(bodyId, def, shape);
        }
      );
    }

    const segment = entity.get(Segment);
    if (segment !== undefined) {
      if (!hasValidEndpoints(segment.x1, segment.y1, segment.x2, segment.y2)) {
        return undefined;
      }
      return withAllocated(
        () => new box2d.b2Segment(),
        (shape) => {
          shape.point1.Set(segment.x1 + pose.x, segment.y1 + pose.y);
          shape.point2.Set(segment.x2 + pose.x, segment.y2 + pose.y);
          return box2d.b2CreateSegmentShape(bodyId, def, shape);
        }
      );
    }

    const polygon = entity.get(Polygon);
    if (polygon !== undefined) {
      return createPolygonShape(state, bodyId, def, polygon, pose);
    }

    return undefined;
  });
}

function createPolygonShape(
  state: PhysicsState,
  bodyId: b2BodyId,
  def: ReturnType<Box2DModule["b2DefaultShapeDef"]>,
  polygon: Polygon,
  pose: { x: number; y: number; angle: number }
): b2ShapeId | undefined {
  if (polygon.vertices.length > MAX_POLYGON_VERTICES || polygon.vertices.length < 3) {
    return undefined;
  }

  const box2d = state.box2d;
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

function createChain(
  state: PhysicsState,
  entity: Entity,
  bodyId: b2BodyId,
  chain: Chain,
  options: ShapeOptions,
  pose: { x: number; y: number; angle: number }
): void {
  if (chain.points.length < 4) {
    return;
  }

  const box2d = state.box2d;
  const points = chain.points.map((point) => new box2d.b2Vec2(point.x, point.y));
  try {
    const chainId = withAllocated(box2d.b2DefaultChainDef, (def) => {
      applyChainDef(def, options);
      def.isLoop = chain.loop;
      def.count = points.length;
      def.SetPoints(points);
      return box2d.b2CreateChain(bodyId, def);
    });
    state.chainByEntity.set(entity.eid, chainId);
    state.shapeEntityByEid.set(entity.eid, entity);
    markParentBodyMassDirty(state, entity);
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

function applyChainDef(
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

function readShapeOptions(entity: Entity): ShapeOptions {
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
    enableSensorEvents: entity.get(SensorEvents) !== undefined,
  };
}

function readLocalPose(entity: Entity): { x: number; y: number; angle: number } {
  return {
    x: entity.get(ShapePosition)?.x ?? 0,
    y: entity.get(ShapePosition)?.y ?? 0,
    angle: entity.get(ShapeRotation)?.angle ?? 0,
  };
}

function parentBodyStillExists(state: PhysicsState, entity: Entity): boolean {
  const parent = entity.parent(ChildOf);
  return parent !== undefined && state.bodyByEntityWasm.has(parent.eid);
}

function markParentBodyMassDirty(state: PhysicsState, entity: Entity): void {
  const parent = entity.parent(ChildOf);
  if (parent !== undefined && state.bodyByEntityWasm.has(parent.eid)) {
    state.dirtyMassBodies.add(parent.eid);
  }
}

function hasValidEndpoints(ax: number, ay: number, bx: number, by: number): boolean {
  const LINEAR_SLOP = 0.005;
  return (bx - ax) ** 2 + (by - ay) ** 2 > LINEAR_SLOP * LINEAR_SLOP;
}

interface ShapeOptions {
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
