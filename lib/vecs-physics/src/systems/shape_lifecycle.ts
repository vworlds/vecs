import { ChildOf, type Entity, type IPhase, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import {
  Box,
  Capsule,
  Chain,
  Circle,
  Polygon,
  Segment,
  type Vec2,
} from "../components/geometry.js";
import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { CollisionFilter, Material, Sensor } from "../components/material.js";
import { ShapePosition, ShapeRotation } from "../components/shape_pose.js";
import { type Box2DModule } from "../adapter/runtime.js";
import {
  type b2BodyId,
  type b2ChainId,
  type b2ShapeId,
  type PhysicsState,
} from "../adapter/state.js";
import { withAllocated } from "../adapter/disposal.js";
import { destroyBodyContactsForShape } from "../engine/contact.js";
import { destroySensor } from "../engine/sensor.js";
import { LINEAR_SLOP, MAX_AABB_MARGIN, SPECULATIVE_DISTANCE } from "../math/constants.js";
import { makeRot } from "../math/rot.js";
import { transformPoint, type Transform } from "../math/transform.js";
import { NULL_INDEX, type BodyHandle, type ShapeHandle } from "../util/handle.js";

const STATIC_BODY = 0;
const DISABLED_SET = 1;
const MAX_POLYGON_VERTICES = 8;

const enum ShapeType {
  Circle = 0,
  Capsule = 1,
  Segment = 2,
  Polygon = 3,
  ChainSegment = 4,
}

type GeometryUnion =
  | { kind: "circle"; cx: number; cy: number; radius: number }
  | { kind: "capsule"; ax: number; ay: number; bx: number; by: number; radius: number }
  | { kind: "segment"; ax: number; ay: number; bx: number; by: number }
  | {
      kind: "polygon";
      vertices: Float32Array;
      normals: Float32Array;
      count: number;
      radius: number;
      centroidX: number;
      centroidY: number;
    }
  | {
      kind: "chainSegment";
      ghost1X: number;
      ghost1Y: number;
      ax: number;
      ay: number;
      bx: number;
      by: number;
      ghost2X: number;
      ghost2Y: number;
      chainId: number;
    };

interface LegacyShape {
  type: ShapeType;
  geometry: GeometryUnion;
  localX: number;
  localY: number;
  localCos: number;
  localSin: number;
  localCentroidX: number;
  localCentroidY: number;
  aabbMinX: number;
  aabbMinY: number;
  aabbMaxX: number;
  aabbMaxY: number;
  proxyKey: number;
  fatAabbMinX: number;
  fatAabbMinY: number;
  fatAabbMaxX: number;
  fatAabbMaxY: number;
  bodyHandle: BodyHandle;
  entity: number;
  prevShape: number;
  nextShape: number;
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
  sensorIndex: number;
  aabbMargin: number;
  enlargedAABB: boolean;
  shapeIndex: number;
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

  system.update(Material, (entity, material) => {
    updateWasmMaterial(state, entity, material);
    updateLegacyMaterial(state, entity, readShapeOptions(entity));
  });
  system.update(CollisionFilter, (entity, filter) => {
    updateWasmFilter(state, entity, filter);
    updateLegacyMaterial(state, entity, readShapeOptions(entity));
  });
  system.update(Sensor, (entity) => {
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
  const bodyHandle = state.bodyByEntity.get(parentEntity.eid);
  if (bodyId === undefined || bodyHandle === undefined) {
    return;
  }

  const options = readShapeOptions(entity);
  const pose = readLocalPose(entity);
  const chain = entity.get(Chain);
  if (chain !== undefined) {
    createChain(state, entity, bodyId, bodyHandle, chain, options, pose);
    return;
  }

  const created = createSingleShape(state, entity, bodyId, bodyHandle, options, pose);
  if (created !== undefined) {
    state.shapeByEntityWasm.set(entity.eid, created.shapeId);
    state.entityByShape.set(created.shapeId, entity.eid);
    state.shapeByEntity.set(entity.eid, created.legacyHandle);
    state.shapeEntityByEid.set(entity.eid, entity);
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
  }

  const chainHandles = state.chainShapeByEntity.get(entity.eid);
  if (chainHandles !== undefined) {
    const bodyHandle = getFirstBodyHandle(state, chainHandles);
    for (const handle of chainHandles) {
      destroyLegacyShape(state, handle);
    }
    state.chainShapeByEntity.delete(entity.eid);
    markLegacyBodyMassDirty(state, bodyHandle);
  }

  const shapeId = state.shapeByEntityWasm.get(entity.eid);
  if (shapeId !== undefined) {
    const parentBodyExists = parentBodyStillExists(state, entity);
    if ((!allowCascadeSkip || parentBodyExists) && state.box2d.b2Shape_IsValid(shapeId)) {
      state.box2d.b2DestroyShape(shapeId, true);
    }
    state.shapeByEntityWasm.delete(entity.eid);
    state.entityByShape.delete(shapeId);
  }

  const handle = state.shapeByEntity.get(entity.eid);
  if (handle !== undefined) {
    const shape = getLegacyShape(state, handle);
    const bodyHandle = shape?.bodyHandle;
    destroyLegacyShape(state, handle);
    state.shapeByEntity.delete(entity.eid);
    markLegacyBodyMassDirty(state, bodyHandle);
  }
}

function createSingleShape(
  state: PhysicsState,
  entity: Entity,
  bodyId: b2BodyId,
  bodyHandle: BodyHandle,
  options: ShapeOptions,
  pose: { x: number; y: number; angle: number }
): { shapeId: b2ShapeId; legacyHandle: ShapeHandle } | undefined {
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
                const shapeId = box2d.b2CreatePolygonShape(bodyId, def, polygon);
                const legacyHandle = createLegacyShape(
                  state,
                  entity,
                  bodyHandle,
                  makeLegacyBox(box.hx, box.hy),
                  ShapeType.Polygon,
                  options,
                  pose
                );
                return { shapeId, legacyHandle };
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
          const shapeId = box2d.b2CreateCircleShape(bodyId, def, shape);
          const legacyHandle = createLegacyShape(
            state,
            entity,
            bodyHandle,
            { kind: "circle", cx: 0, cy: 0, radius: circle.radius },
            ShapeType.Circle,
            options,
            pose
          );
          return { shapeId, legacyHandle };
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
          const shapeId = box2d.b2CreateCapsuleShape(bodyId, def, shape);
          const legacyHandle = createLegacyShape(
            state,
            entity,
            bodyHandle,
            {
              kind: "capsule",
              ax: capsule.x1,
              ay: capsule.y1,
              bx: capsule.x2,
              by: capsule.y2,
              radius: capsule.radius,
            },
            ShapeType.Capsule,
            options,
            pose
          );
          return { shapeId, legacyHandle };
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
          const shapeId = box2d.b2CreateSegmentShape(bodyId, def, shape);
          const legacyHandle = createLegacyShape(
            state,
            entity,
            bodyHandle,
            { kind: "segment", ax: segment.x1, ay: segment.y1, bx: segment.x2, by: segment.y2 },
            ShapeType.Segment,
            options,
            pose
          );
          return { shapeId, legacyHandle };
        }
      );
    }

    const polygon = entity.get(Polygon);
    if (polygon !== undefined) {
      return createPolygonShape(state, entity, bodyId, bodyHandle, def, polygon, options, pose);
    }

    return undefined;
  });
}

function createPolygonShape(
  state: PhysicsState,
  entity: Entity,
  bodyId: b2BodyId,
  bodyHandle: BodyHandle,
  def: ReturnType<Box2DModule["b2DefaultShapeDef"]>,
  polygon: Polygon,
  options: ShapeOptions,
  pose: { x: number; y: number; angle: number }
): { shapeId: b2ShapeId; legacyHandle: ShapeHandle } | undefined {
  if (polygon.vertices.length > MAX_POLYGON_VERTICES || polygon.vertices.length < 3) {
    warnInvalidPolygon(entity);
    return undefined;
  }

  const box2d = state.box2d;
  const points = polygon.vertices.map((point) => new box2d.b2Vec2(point.x, point.y));
  try {
    const hull = box2d.b2ComputeHull(points);
    try {
      if (hull.count < 3) {
        warnInvalidPolygon(entity);
        return undefined;
      }
      const wasmPolygon = box2d.b2MakePolygon(hull, polygon.radius);
      try {
        const shapeId = box2d.b2CreatePolygonShape(bodyId, def, wasmPolygon);
        const legacyGeometry = makeLegacyPolygonFromHull(hull, polygon.radius);
        const legacyHandle = createLegacyShape(
          state,
          entity,
          bodyHandle,
          legacyGeometry,
          ShapeType.Polygon,
          options,
          pose
        );
        return { shapeId, legacyHandle };
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
  bodyHandle: BodyHandle,
  chain: Chain,
  options: ShapeOptions,
  pose: { x: number; y: number; angle: number }
): void {
  if (chain.points.length < 4) {
    warnTooFewChainPoints(entity, chain.points.length);
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
    state.chainShapeByEntity.set(
      entity.eid,
      createLegacyChainShapes(state, entity, bodyHandle, chain, options, pose)
    );
    state.shapeEntityByEid.set(entity.eid, entity);
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

function updateWasmMaterial(state: PhysicsState, entity: Entity, material: Material): void {
  const shapeId = state.shapeByEntityWasm.get(entity.eid);
  if (shapeId !== undefined) {
    state.box2d.b2Shape_SetDensity(shapeId, material.density, true);
    state.box2d.b2Shape_SetFriction(shapeId, material.friction);
    state.box2d.b2Shape_SetRestitution(shapeId, material.restitution);
  }
}

function updateWasmFilter(state: PhysicsState, entity: Entity, filter: CollisionFilter): void {
  const shapeId = state.shapeByEntityWasm.get(entity.eid);
  if (shapeId === undefined) {
    return;
  }
  withAllocated(
    () => new state.box2d.b2Filter(),
    (wasmFilter) => {
      wasmFilter.categoryBits = filter.categoryBits;
      wasmFilter.maskBits = filter.maskBits;
      wasmFilter.groupIndex = filter.groupIndex;
      state.box2d.b2Shape_SetFilter(shapeId, wasmFilter);
    }
  );
}

function updateLegacyMaterial(state: PhysicsState, entity: Entity, options: ShapeOptions): void {
  const handle = state.shapeByEntity.get(entity.eid);
  if (handle !== undefined) {
    const shape = getLegacyShape(state, handle);
    if (shape) {
      const densityChanged = shape.density !== options.density;
      applyLegacyOptions(shape, options);
      if (densityChanged) {
        markLegacyBodyMassDirty(state, shape.bodyHandle);
      }
    }
  }
  const handles = state.chainShapeByEntity.get(entity.eid);
  if (handles !== undefined) {
    for (const chainHandle of handles) {
      const shape = getLegacyShape(state, chainHandle);
      if (shape) {
        const densityChanged = shape.density !== options.density;
        applyLegacyOptions(shape, options);
        if (densityChanged) {
          markLegacyBodyMassDirty(state, shape.bodyHandle);
        }
      }
    }
  }
}

function createLegacyShape(
  state: PhysicsState,
  entity: Entity,
  bodyHandle: BodyHandle,
  geometry: GeometryUnion,
  type: ShapeType,
  options: ShapeOptions,
  pose: { x: number; y: number; angle: number }
): ShapeHandle {
  const q = makeRot(pose.angle);
  const legacyShape = makeLegacyShape(
    type,
    geometry,
    pose.x,
    pose.y,
    q.c,
    q.s,
    entity.eid,
    bodyHandle,
    options
  );
  const bodyRec = state.bodies.get(bodyHandle.index);
  const worldXf = composeLegacyWorldTransform(state, bodyHandle, legacyShape);
  updateLegacyAabbs(legacyShape, worldXf, bodyRec.type);
  const handle = state.shapes.idPool.allocate();
  legacyShape.shapeIndex = handle.index;
  state.shapes.records[handle.index] = legacyShape as never;
  linkLegacyShapeToBody(state, handle, bodyHandle);
  if (bodyRec.setIndex !== DISABLED_SET) {
    legacyShape.proxyKey = state.broadPhase.createProxy(
      bodyRec.type,
      legacyFatAabb(legacyShape),
      options.categoryBits,
      handle.index,
      true
    );
  }
  if (legacyShape.sensor) {
    legacyShape.sensorIndex = state.sensors.create(handle.index);
  }
  bodyRec.massDirty = true;
  return handle;
}

function createLegacyChainShapes(
  state: PhysicsState,
  entity: Entity,
  bodyHandle: BodyHandle,
  chain: Chain,
  options: ShapeOptions,
  pose: { x: number; y: number; angle: number }
): ShapeHandle[] {
  const handles: ShapeHandle[] = [];
  const n = chain.points.length;
  const segmentCount = chain.loop ? n : n - 1;
  for (let i = 0; i < segmentCount; i++) {
    const a = chain.points[i]!;
    const b = chain.points[(i + 1) % n]!;
    if (!hasValidEndpoints(a.x, a.y, b.x, b.y)) {
      continue;
    }
    const ghost1 = chain.loop
      ? chain.points[(i - 1 + n) % n]!
      : i === 0
        ? reflect(a, b)
        : chain.points[i - 1]!;
    const ghost2 = chain.loop
      ? chain.points[(i + 2) % n]!
      : i === segmentCount - 1
        ? reflect(b, a)
        : chain.points[i + 2]!;
    handles.push(
      createLegacyShape(
        state,
        entity,
        bodyHandle,
        {
          kind: "chainSegment",
          ghost1X: ghost1.x,
          ghost1Y: ghost1.y,
          ax: a.x,
          ay: a.y,
          bx: b.x,
          by: b.y,
          ghost2X: ghost2.x,
          ghost2Y: ghost2.y,
          chainId: 0,
        },
        ShapeType.ChainSegment,
        options,
        pose
      )
    );
  }
  return handles;
}

function makeLegacyShape(
  type: ShapeType,
  geometry: GeometryUnion,
  localX: number,
  localY: number,
  localCos: number,
  localSin: number,
  eid: number,
  bodyHandle: BodyHandle,
  options: ShapeOptions
): LegacyShape {
  const centroid = legacyCentroid(geometry);
  const shape: LegacyShape = {
    type,
    geometry,
    localX,
    localY,
    localCos,
    localSin,
    localCentroidX: centroid.x,
    localCentroidY: centroid.y,
    aabbMinX: 0,
    aabbMinY: 0,
    aabbMaxX: 0,
    aabbMaxY: 0,
    proxyKey: -1,
    fatAabbMinX: 0,
    fatAabbMinY: 0,
    fatAabbMaxX: 0,
    fatAabbMaxY: 0,
    bodyHandle,
    entity: eid,
    prevShape: NULL_INDEX,
    nextShape: NULL_INDEX,
    sensorIndex: -1,
    aabbMargin: computeShapeMargin(geometry),
    enlargedAABB: false,
    shapeIndex: NULL_INDEX,
    density: 1,
    friction: 0.6,
    restitution: 0,
    rollingResistance: 0,
    tangentSpeed: 0,
    userMaterialId: 0,
    categoryBits: 1,
    maskBits: 0xffffffff,
    groupIndex: 0,
    sensor: false,
    enableContactEvents: false,
    enableHitEvents: false,
    enableSensorEvents: false,
  };
  applyLegacyOptions(shape, options);
  return shape;
}

function applyLegacyOptions(shape: LegacyShape, options: ShapeOptions): void {
  shape.density = options.density;
  shape.friction = options.friction;
  shape.restitution = options.restitution;
  shape.rollingResistance = options.rollingResistance;
  shape.tangentSpeed = options.tangentSpeed;
  shape.userMaterialId = options.userMaterialId;
  shape.categoryBits = options.categoryBits;
  shape.maskBits = options.maskBits;
  shape.groupIndex = options.groupIndex;
  shape.sensor = options.sensor;
  shape.enableContactEvents = options.enableContactEvents;
  shape.enableHitEvents = options.enableHitEvents;
  shape.enableSensorEvents = options.enableSensorEvents;
}

function destroyLegacyShape(state: PhysicsState, handle: ShapeHandle): void {
  const shape = getLegacyShape(state, handle);
  if (shape === undefined) {
    return;
  }
  if (shape.sensor && shape.sensorIndex !== -1) {
    destroySensor(state, shape.sensorIndex);
    shape.sensorIndex = -1;
  }
  if (shape.bodyHandle.index !== NULL_INDEX) {
    const bodyRec = state.bodies.records[shape.bodyHandle.index];
    if (bodyRec !== undefined) {
      destroyBodyContactsForShape(state, shape.bodyHandle.index, handle.index, false);
    }
  }
  if (shape.proxyKey !== -1) {
    state.broadPhase.destroyProxy(shape.proxyKey);
    shape.proxyKey = -1;
  }
  unlinkLegacyShapeFromBody(state, handle, shape.bodyHandle);
  state.shapes.records[handle.index] = undefined;
  state.shapes.idPool.free(handle);
}

function getLegacyShape(state: PhysicsState, handle: ShapeHandle): LegacyShape | undefined {
  return state.shapes.records[handle.index] as LegacyShape | undefined;
}

function linkLegacyShapeToBody(
  state: PhysicsState,
  handle: ShapeHandle,
  bodyHandle: BodyHandle
): void {
  const bodyRec = state.bodies.get(bodyHandle.index);
  const shape = getLegacyShape(state, handle)!;
  if (bodyRec.shapeHead !== NULL_INDEX) {
    getLegacyShape(state, { index: bodyRec.shapeHead, generation: 0 } as ShapeHandle)!.prevShape =
      handle.index;
  }
  shape.prevShape = NULL_INDEX;
  shape.nextShape = bodyRec.shapeHead;
  bodyRec.shapeHead = handle.index;
  bodyRec.shapeCount += 1;
}

function unlinkLegacyShapeFromBody(
  state: PhysicsState,
  handle: ShapeHandle,
  bodyHandle: BodyHandle
): void {
  const bodyRec = state.bodies.records[bodyHandle.index];
  const shape = getLegacyShape(state, handle);
  if (bodyRec === undefined || shape === undefined) {
    return;
  }
  if (shape.prevShape !== NULL_INDEX) {
    const prev = state.shapes.records[shape.prevShape] as LegacyShape | undefined;
    if (prev) {
      prev.nextShape = shape.nextShape;
    }
  } else {
    bodyRec.shapeHead = shape.nextShape;
  }
  if (shape.nextShape !== NULL_INDEX) {
    const next = state.shapes.records[shape.nextShape] as LegacyShape | undefined;
    if (next) {
      next.prevShape = shape.prevShape;
    }
  }
  bodyRec.shapeCount -= 1;
}

function parentBodyStillExists(state: PhysicsState, entity: Entity): boolean {
  const parent = entity.parent(ChildOf);
  return parent !== undefined && state.bodyByEntityWasm.has(parent.eid);
}

function getFirstBodyHandle(state: PhysicsState, handles: ShapeHandle[]): BodyHandle | undefined {
  const first = handles[0];
  return first === undefined ? undefined : getLegacyShape(state, first)?.bodyHandle;
}

function markLegacyBodyMassDirty(state: PhysicsState, bodyHandle: BodyHandle | undefined): void {
  if (bodyHandle === undefined || bodyHandle.index === NULL_INDEX) {
    return;
  }
  const body = state.bodies.records[bodyHandle.index];
  if (body !== undefined) {
    body.massDirty = true;
  }
}

function composeLegacyWorldTransform(
  state: PhysicsState,
  bodyHandle: BodyHandle,
  shape: LegacyShape
): Transform {
  const bodyRec = state.bodies.get(bodyHandle.index);
  const sim = state.solverSets[bodyRec.setIndex]!.bodySims[bodyRec.localIndex]!;
  const bx = sim.transformX;
  const by = sim.transformY;
  const bc = sim.cos;
  const bs = sim.sin;
  const x = bx + bc * shape.localX - bs * shape.localY;
  const y = by + bs * shape.localX + bc * shape.localY;
  return {
    p: { x, y },
    q: {
      c: bc * shape.localCos - bs * shape.localSin,
      s: bs * shape.localCos + bc * shape.localSin,
    },
  };
}

function updateLegacyAabbs(shape: LegacyShape, xf: Transform, bodyType: number): void {
  const raw = computeAabb(shape.geometry, xf);
  const spec = SPECULATIVE_DISTANCE;
  shape.aabbMinX = raw.lowerBound.x - spec;
  shape.aabbMinY = raw.lowerBound.y - spec;
  shape.aabbMaxX = raw.upperBound.x + spec;
  shape.aabbMaxY = raw.upperBound.y + spec;
  const extra = bodyType === STATIC_BODY ? spec : shape.aabbMargin;
  shape.fatAabbMinX = shape.aabbMinX - extra;
  shape.fatAabbMinY = shape.aabbMinY - extra;
  shape.fatAabbMaxX = shape.aabbMaxX + extra;
  shape.fatAabbMaxY = shape.aabbMaxY + extra;
}

function legacyFatAabb(shape: LegacyShape) {
  return {
    lowerBound: { x: shape.fatAabbMinX, y: shape.fatAabbMinY },
    upperBound: { x: shape.fatAabbMaxX, y: shape.fatAabbMaxY },
  };
}

function makeLegacyBox(hx: number, hy: number): GeometryUnion {
  return {
    kind: "polygon",
    vertices: new Float32Array([-hx, -hy, hx, -hy, hx, hy, -hx, hy]),
    normals: new Float32Array([0, -1, 1, 0, 0, 1, -1, 0]),
    count: 4,
    radius: 0,
    centroidX: 0,
    centroidY: 0,
  };
}

function makeLegacyPolygonFromHull(
  hull: ReturnType<Box2DModule["b2ComputeHull"]>,
  radius: number
): GeometryUnion {
  const vertices = new Float32Array(hull.count * 2);
  for (let i = 0; i < hull.count; i++) {
    const point = hull.getPoint(i);
    vertices[i * 2] = point.x;
    vertices[i * 2 + 1] = point.y;
  }
  const normals = new Float32Array(hull.count * 2);
  for (let i = 0; i < hull.count; i++) {
    const j = i + 1 < hull.count ? i + 1 : 0;
    const ex = vertices[j * 2]! - vertices[i * 2]!;
    const ey = vertices[j * 2 + 1]! - vertices[i * 2 + 1]!;
    const len = Math.hypot(ex, ey);
    if (len > 0) {
      normals[i * 2] = ey / len;
      normals[i * 2 + 1] = -ex / len;
    }
  }
  const centroid = computePolygonCentroid(vertices, hull.count);
  return {
    kind: "polygon",
    vertices,
    normals,
    count: hull.count,
    radius,
    centroidX: centroid.x,
    centroidY: centroid.y,
  };
}

function computeAabb(geom: GeometryUnion, xf: Transform) {
  if (geom.kind === "circle") {
    const center = transformPoint(xf, { x: geom.cx, y: geom.cy });
    return {
      lowerBound: { x: center.x - geom.radius, y: center.y - geom.radius },
      upperBound: { x: center.x + geom.radius, y: center.y + geom.radius },
    };
  }
  if (geom.kind === "capsule") {
    const a = transformPoint(xf, { x: geom.ax, y: geom.ay });
    const b = transformPoint(xf, { x: geom.bx, y: geom.by });
    return {
      lowerBound: { x: Math.min(a.x, b.x) - geom.radius, y: Math.min(a.y, b.y) - geom.radius },
      upperBound: { x: Math.max(a.x, b.x) + geom.radius, y: Math.max(a.y, b.y) + geom.radius },
    };
  }
  if (geom.kind === "segment" || geom.kind === "chainSegment") {
    const a = transformPoint(xf, { x: geom.ax, y: geom.ay });
    const b = transformPoint(xf, { x: geom.bx, y: geom.by });
    return {
      lowerBound: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
      upperBound: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
    };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < geom.count; i++) {
    const point = transformPoint(xf, { x: geom.vertices[i * 2]!, y: geom.vertices[i * 2 + 1]! });
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    lowerBound: { x: minX - geom.radius, y: minY - geom.radius },
    upperBound: { x: maxX + geom.radius, y: maxY + geom.radius },
  };
}

function computeShapeMargin(geom: GeometryUnion): number {
  let raw = 0;
  if (geom.kind === "circle") {
    raw = geom.radius;
  } else if (geom.kind === "capsule") {
    raw = 0.5 * Math.hypot(geom.bx - geom.ax, geom.by - geom.ay) + geom.radius;
  } else if (geom.kind === "segment" || geom.kind === "chainSegment") {
    raw = 0.5 * Math.hypot(geom.bx - geom.ax, geom.by - geom.ay);
  } else {
    for (let i = 0; i < geom.count; i++) {
      raw = Math.max(
        raw,
        Math.hypot(
          geom.vertices[i * 2]! - geom.centroidX,
          geom.vertices[i * 2 + 1]! - geom.centroidY
        )
      );
    }
  }
  return Math.min(MAX_AABB_MARGIN, 0.1 * raw);
}

function legacyCentroid(geom: GeometryUnion): { x: number; y: number } {
  if (geom.kind === "circle") {
    return { x: geom.cx, y: geom.cy };
  }
  if (geom.kind === "capsule" || geom.kind === "segment" || geom.kind === "chainSegment") {
    return { x: 0.5 * (geom.ax + geom.bx), y: 0.5 * (geom.ay + geom.by) };
  }
  return { x: geom.centroidX, y: geom.centroidY };
}

function computePolygonCentroid(vertices: Float32Array, count: number): { x: number; y: number } {
  let cx = 0;
  let cy = 0;
  let area = 0;
  const ox = vertices[0]!;
  const oy = vertices[1]!;
  for (let i = 1; i < count - 1; i++) {
    const e1x = vertices[i * 2]! - ox;
    const e1y = vertices[i * 2 + 1]! - oy;
    const e2x = vertices[(i + 1) * 2]! - ox;
    const e2y = vertices[(i + 1) * 2 + 1]! - oy;
    const a = 0.5 * (e1x * e2y - e1y * e2x);
    cx += (a * (e1x + e2x)) / 3;
    cy += (a * (e1y + e2y)) / 3;
    area += a;
  }
  return { x: ox + cx / area, y: oy + cy / area };
}

function hasValidEndpoints(ax: number, ay: number, bx: number, by: number): boolean {
  return (bx - ax) ** 2 + (by - ay) ** 2 > LINEAR_SLOP * LINEAR_SLOP;
}

function reflect(a: Vec2, b: Vec2): Vec2 {
  return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
}

function warnInvalidPolygon(entity: Entity): void {
  console.warn(
    `Entity${entity.eid} has Polygon with invalid or non-convex vertices. [polygon-invalid]`
  );
}

function warnTooFewChainPoints(entity: Entity, count: number): void {
  console.warn(
    `Entity${entity.eid} has Chain with ${count} point(s); at least 4 are required. [chain-too-few-points]`
  );
}
