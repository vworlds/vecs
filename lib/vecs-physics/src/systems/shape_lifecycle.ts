// `PhysicsShapeLifecycle` — shape creation, destruction, geometry rebuild, and
// reparenting between bodies.
//
// This is the components/ → engine/ boundary for shapes. It runs in
// `physics-pre` AFTER `PhysicsBodyLifecycle`. The body must already exist in
// `state.bodyByEntity` before any of its shapes are inserted.
//
// Query: entities that carry one geometry component AND whose immediate ChildOf
// parent has a Body component. The `{ parent: Body }` DSL predicate enforces
// the immediate-parent rule (geometry on a grandchild is ignored).
//
// Chain shapes expand to N InternalShape records (one per segment). They are
// tracked via `state.chainShapeByEntity` (1:N); the common 1:1 path uses
// `state.shapeByEntity` — keeping both paths branch-free in the hot loop.
//
// Cross-ticket contract (PROGRESS.md → _Cross-ticket contracts_):
//   World AABB = computeAABB(geom, mul(bodyWorldTransform, localPose)).
//   Local pose fields (localX/Y/Cos/Sin) are set from ShapePosition/ShapeRotation;
//   the seeded values from the VP-8 constructors are overwritten here.
//
// Deferred to M3 (no contact graph yet):
//   Contact teardown on shape removal / type change (same shape of deferral as
//   PhysicsBodyLifecycle.exit). Contact refilter on CollisionFilter change.
//
// Upstream sources:
//   box2d/src/shape.c — b2CreateShape, b2DestroyShape,
//                       b2UpdateShapeAABBs, b2ComputeShapeMargin

import { ChildOf, type IPhase, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "../components/geometry.js";
import { CollisionFilter, Material, Sensor } from "../components/material.js";
import { ContactEvents, HitEvents, SensorEvents } from "../components/events.js";
import { ShapePosition, ShapeRotation } from "../components/shape_pose.js";
import {
  computeHull,
  makeBox,
  makePolygon,
  validateHull,
  type GeometryUnion,
  type PolygonGeometry,
} from "../engine/geometry.js";
import {
  createShape,
  freeShape,
  makeChainSegments,
  ShapeType,
  updateShapeAABBs,
  type InternalShape,
} from "../engine/shape.js";
import { DISABLED_SET } from "../engine/solver_set.js";
import type { PhysicsState } from "../engine/state.js";
import { LINEAR_SLOP } from "../math/constants.js";
import { makeRot } from "../math/rot.js";
import { mulTransforms, type Transform } from "../math/transform.js";
import { NULL_INDEX, type BodyHandle, type ShapeHandle } from "../util/handle.js";

// ─── Degenerate-geometry guard ────────────────────────────────────────────────

/** True when the endpoint pair (a→b) is long enough to be a valid capsule,
 * segment, or chain-segment geometry. Mirrors the `B2_LINEAR_SLOP` threshold
 * used in `b2CreateCapsuleShape`, `b2CreateSegmentShape`, and
 * `b2CreateChainSegmentShape` (box2d/src/shape.c). */
function hasValidEndpoints(ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const threshold = LINEAR_SLOP * LINEAR_SLOP;
  return dx * dx + dy * dy > threshold;
}

// ─── Geometry translation (components/ → engine/) ────────────────────────────

/** Translate a geometry component on `e` into a bare InternalShape (without
 * body-linkage or material fields). Returns undefined for Chain (handled
 * separately) or if the geometry is invalid. */
function buildShapeForEntity(
  e: { get: (c: any) => any },
  lx: number,
  ly: number,
  lcos: number,
  lsin: number
): InternalShape | undefined {
  const box = e.get(Box) as Box | undefined;
  if (box !== undefined) {
    const geom = makeBox(box.hx, box.hy);
    return newShape(ShapeType.Polygon, geom, lx, ly, lcos, lsin, geom.centroidX, geom.centroidY);
  }

  const circle = e.get(Circle) as Circle | undefined;
  if (circle !== undefined) {
    const geom: GeometryUnion = { kind: "circle", cx: 0, cy: 0, radius: circle.radius };
    return newShape(ShapeType.Circle, geom, lx, ly, lcos, lsin, 0, 0);
  }

  const capsule = e.get(Capsule) as Capsule | undefined;
  if (capsule !== undefined) {
    if (!hasValidEndpoints(capsule.x1, capsule.y1, capsule.x2, capsule.y2)) {
      console.warn("Capsule endpoint distance <= LINEAR_SLOP — shape skipped (Box2D parity)");
      return undefined;
    }
    const geom: GeometryUnion = {
      kind: "capsule",
      ax: capsule.x1,
      ay: capsule.y1,
      bx: capsule.x2,
      by: capsule.y2,
      radius: capsule.radius,
    };
    return newShape(
      ShapeType.Capsule,
      geom,
      lx,
      ly,
      lcos,
      lsin,
      0.5 * (capsule.x1 + capsule.x2),
      0.5 * (capsule.y1 + capsule.y2)
    );
  }

  const segment = e.get(Segment) as Segment | undefined;
  if (segment !== undefined) {
    if (!hasValidEndpoints(segment.x1, segment.y1, segment.x2, segment.y2)) {
      console.warn("Segment endpoint distance <= LINEAR_SLOP — shape skipped (Box2D parity)");
      return undefined;
    }
    const geom: GeometryUnion = {
      kind: "segment",
      ax: segment.x1,
      ay: segment.y1,
      bx: segment.x2,
      by: segment.y2,
    };
    return newShape(
      ShapeType.Segment,
      geom,
      lx,
      ly,
      lcos,
      lsin,
      0.5 * (segment.x1 + segment.x2),
      0.5 * (segment.y1 + segment.y2)
    );
  }

  const polygon = e.get(Polygon) as Polygon | undefined;
  if (polygon !== undefined && polygon.vertices.length >= 3) {
    const hull = computeHull(polygon.vertices);
    if (hull.count < 3 || !validateHull(hull)) {
      return undefined;
    }
    const geom = makePolygon(hull, polygon.radius);
    return newShape(ShapeType.Polygon, geom, lx, ly, lcos, lsin, geom.centroidX, geom.centroidY);
  }

  return undefined;
}

/** Allocate a fresh InternalShape with zeroed AABB / sentinel linkage. */
function newShape(
  type: ShapeType,
  geometry: GeometryUnion,
  lx: number,
  ly: number,
  lcos: number,
  lsin: number,
  centX: number,
  centY: number
): InternalShape {
  return {
    type,
    geometry,
    localX: lx,
    localY: ly,
    localCos: lcos,
    localSin: lsin,
    localCentroidX: centX,
    localCentroidY: centY,
    aabbMinX: 0,
    aabbMinY: 0,
    aabbMaxX: 0,
    aabbMaxY: 0,
    proxyKey: -1,
    fatAabbMinX: 0,
    fatAabbMinY: 0,
    fatAabbMaxX: 0,
    fatAabbMaxY: 0,
    // body-linkage — set by the caller before createShape.
    bodyHandle: { index: NULL_INDEX, generation: 0 } as unknown as BodyHandle,
    entity: 0,
    prevShape: NULL_INDEX,
    nextShape: NULL_INDEX,
    // material defaults (b2DefaultShapeDef / b2DefaultSurfaceMaterial)
    density: 1,
    friction: 0.6,
    restitution: 0,
    rollingResistance: 0,
    tangentSpeed: 0,
    userMaterialId: 0,
    // filter defaults (b2DefaultFilter)
    categoryBits: 1,
    maskBits: 0xffffffff,
    groupIndex: 0,
    // sensor / events
    sensor: false,
    enableContactEvents: false,
    enableHitEvents: false,
    enableSensorEvents: false,
    sensorIndex: -1,
  };
}

// ─── Body-transform helper ─────────────────────────────────────────────────────

/** Read the body's current world transform from the BodySim. */
function getBodyWorldTransform(state: PhysicsState, bodyHandle: BodyHandle): Transform {
  const bodyRec = state.bodies.get(bodyHandle.index);
  const sim = state.solverSets[bodyRec.setIndex]!.bodySims[bodyRec.localIndex]!;
  return { p: { x: sim.transformX, y: sim.transformY }, q: { c: sim.cos, s: sim.sin } };
}

// ─── Shape linked-list helpers ────────────────────────────────────────────────

/** Prepend `handle` to the body's shape linked list. Mirrors the headShapeId
 * manipulation in `b2CreateShape` (box2d/src/shape.c). */
function linkShapeToBody(state: PhysicsState, handle: ShapeHandle, bodyHandle: BodyHandle): void {
  const bodyRec = state.bodies.get(bodyHandle.index);
  const shape = state.shapes.get(handle.index);

  if (bodyRec.shapeHead !== NULL_INDEX) {
    // Existing head points back to the new shape.
    state.shapes.get(bodyRec.shapeHead).prevShape = handle.index;
  }
  shape.prevShape = NULL_INDEX;
  shape.nextShape = bodyRec.shapeHead;
  bodyRec.shapeHead = handle.index;
  bodyRec.shapeCount += 1;
}

/** Remove `handle` from its body's shape linked list. Mirrors the doubly-linked
 * removal in `b2DestroyShape` (box2d/src/shape.c). */
function unlinkShapeFromBody(
  state: PhysicsState,
  handle: ShapeHandle,
  bodyHandle: BodyHandle
): void {
  if (bodyHandle.index === NULL_INDEX) {
    return;
  }
  const bodyRec = state.bodies.records[bodyHandle.index];
  if (bodyRec === undefined) {
    return;
  }

  const shape = state.shapes.records[handle.index];
  if (shape === undefined) {
    return;
  }

  if (shape.prevShape !== NULL_INDEX) {
    const prevShape = state.shapes.records[shape.prevShape];
    if (prevShape !== undefined) {
      prevShape.nextShape = shape.nextShape;
    }
  } else {
    bodyRec.shapeHead = shape.nextShape;
  }
  if (shape.nextShape !== NULL_INDEX) {
    const nextShape = state.shapes.records[shape.nextShape];
    if (nextShape !== undefined) {
      nextShape.prevShape = shape.prevShape;
    }
  }
  bodyRec.shapeCount -= 1;
}

// ─── Destroy helper ───────────────────────────────────────────────────────────

/** Destroy the proxy, unlink from the body list, and free the shape slot.
 * Mirrors `b2DestroyShape` minus contact teardown (deferred to M3). */
function destroyShape(state: PhysicsState, handle: ShapeHandle): void {
  const shape = state.shapes.records[handle.index];
  if (shape === undefined) {
    return;
  } // already freed — idempotent

  if (shape.proxyKey !== -1) {
    state.broadPhase.destroyProxy(shape.proxyKey);
    shape.proxyKey = -1;
  }
  unlinkShapeFromBody(state, handle, shape.bodyHandle);
  freeShape(state.shapes, handle);
}

// ─── Chain expansion helper ───────────────────────────────────────────────────

/** Read material / filter / event opts from an entity into a flat record. */
function readMaterialOpts(e: { get: (c: any) => any }): {
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
} {
  const mat = e.get(Material) as Material | undefined;
  const filt = e.get(CollisionFilter) as CollisionFilter | undefined;
  return {
    density: mat?.density ?? 1,
    friction: mat?.friction ?? 0.6,
    restitution: mat?.restitution ?? 0,
    rollingResistance: mat?.rollingResistance ?? 0,
    tangentSpeed: mat?.tangentSpeed ?? 0,
    userMaterialId: mat?.userMaterialId ?? 0,
    categoryBits: filt?.categoryBits ?? 1,
    maskBits: filt?.maskBits ?? 0xffffffff,
    groupIndex: filt?.groupIndex ?? 0,
    sensor: e.get(Sensor) !== undefined,
    enableContactEvents: e.get(ContactEvents) !== undefined,
    enableHitEvents: e.get(HitEvents) !== undefined,
    enableSensorEvents: e.get(SensorEvents) !== undefined,
  };
}

/** Build and register chain segment shapes. Writes `state.chainShapeByEntity`.
 * Skips proxy creation when `bodySetIndex === DISABLED_SET`, matching
 * Box2D's `b2CreateShape` check (box2d/src/shape.c line 173-177). */
function enterChain(
  eid: number,
  chain: Chain,
  worldXf: Transform,
  localXf: Transform,
  bodyHandle: BodyHandle,
  bodyType: number,
  bodySetIndex: number,
  opts: ReturnType<typeof readMaterialOpts>,
  state: PhysicsState
): void {
  const segShapes = makeChainSegments(chain.points, chain.loop, worldXf);
  const handles: ShapeHandle[] = [];
  const disabled = bodySetIndex === DISABLED_SET;

  for (const seg of segShapes) {
    // Set local pose (all chain segments share the same chain entity's local pose).
    seg.localX = localXf.p.x;
    seg.localY = localXf.p.y;
    seg.localCos = localXf.q.c;
    seg.localSin = localXf.q.s;
    // Apply material / filter / events.
    seg.density = opts.density;
    seg.friction = opts.friction;
    seg.restitution = opts.restitution;
    seg.rollingResistance = opts.rollingResistance;
    seg.tangentSpeed = opts.tangentSpeed;
    seg.userMaterialId = opts.userMaterialId;
    seg.categoryBits = opts.categoryBits;
    seg.maskBits = opts.maskBits;
    seg.groupIndex = opts.groupIndex;
    seg.sensor = opts.sensor;
    seg.enableContactEvents = opts.enableContactEvents;
    seg.enableHitEvents = opts.enableHitEvents;
    seg.enableSensorEvents = opts.enableSensorEvents;
    seg.entity = eid; // eid stored as number
    seg.bodyHandle = bodyHandle;

    const fatAABB = updateShapeAABBs(seg, worldXf, bodyType);
    const handle = createShape(state.shapes, seg);
    linkShapeToBody(state, handle, bodyHandle);
    // Disabled bodies have no proxies; proxyKey stays -1 (Box2D parity).
    if (!disabled) {
      seg.proxyKey = state.broadPhase.createProxy(
        bodyType,
        fatAABB,
        opts.categoryBits,
        handle.index
      );
    }
    handles.push(handle);
  }

  state.chainShapeByEntity.set(eid, handles);
}

// ─── System factory ───────────────────────────────────────────────────────────

/** Create `PhysicsShapeLifecycle` on `world`, bound to `state` and `phase`. */
export function installShapeLifecycle(world: World, state: PhysicsState, phase: IPhase): System {
  const system = world
    .system("PhysicsShapeLifecycle")
    .query({ all: [{ any: [Box, Circle, Capsule, Segment, Polygon, Chain] }, { parent: Body }] })
    .phase(phase);

  // ── Enter ──────────────────────────────────────────────────────────────────

  system.enter((e) => {
    const parentEntity = e.parent(ChildOf);
    if (parentEntity === undefined) {
      return;
    }
    const bodyHandle = state.bodyByEntity.get(parentEntity.eid);
    if (bodyHandle === undefined) {
      return;
    } // parent not yet a body (should not happen given query)

    const bodyRec = state.bodies.get(bodyHandle.index);
    const bodyXf = getBodyWorldTransform(state, bodyHandle);

    // Local pose from ShapePosition / ShapeRotation (default identity).
    const shapePos = e.get(ShapePosition) as ShapePosition | undefined;
    const shapeRot = e.get(ShapeRotation) as ShapeRotation | undefined;
    const lx = shapePos?.x ?? 0;
    const ly = shapePos?.y ?? 0;
    const lq = makeRot(shapeRot?.angle ?? 0);
    const localXf: Transform = { p: { x: lx, y: ly }, q: lq };

    // World transform = body ∘ local pose (cross-ticket contract).
    const worldXf = mulTransforms(bodyXf, localXf);

    const opts = readMaterialOpts(e);

    // Chain: expand to N segment shapes.
    const chain = e.get(Chain) as Chain | undefined;
    if (chain !== undefined) {
      enterChain(
        e.eid,
        chain,
        worldXf,
        localXf,
        bodyHandle,
        bodyRec.type,
        bodyRec.setIndex,
        opts,
        state
      );
      bodyRec.massDirty = true;
      return;
    }

    // Single geometry shape.
    const shape = buildShapeForEntity(e, lx, ly, lq.c, lq.s);
    if (shape === undefined) {
      return;
    }

    // Apply material / filter / events.
    shape.density = opts.density;
    shape.friction = opts.friction;
    shape.restitution = opts.restitution;
    shape.rollingResistance = opts.rollingResistance;
    shape.tangentSpeed = opts.tangentSpeed;
    shape.userMaterialId = opts.userMaterialId;
    shape.categoryBits = opts.categoryBits;
    shape.maskBits = opts.maskBits;
    shape.groupIndex = opts.groupIndex;
    shape.sensor = opts.sensor;
    shape.enableContactEvents = opts.enableContactEvents;
    shape.enableHitEvents = opts.enableHitEvents;
    shape.enableSensorEvents = opts.enableSensorEvents;
    shape.entity = e.eid; // eid stored as number (InternalShape.entity)
    shape.bodyHandle = bodyHandle;

    // Compute world AABB + fat AABB (overwriting the zeroed sentinel values).
    const fatAABB = updateShapeAABBs(shape, worldXf, bodyRec.type);

    // Allocate slot, link into body list.
    const handle = createShape(state.shapes, shape);
    linkShapeToBody(state, handle, bodyHandle);

    // Create broad-phase proxy only when the body is NOT disabled.
    // Disabled bodies have no proxies (Box2D parity: box2d/src/shape.c line 173).
    if (bodyRec.setIndex !== DISABLED_SET) {
      shape.proxyKey = state.broadPhase.createProxy(
        bodyRec.type,
        fatAABB,
        opts.categoryBits,
        handle.index
      );
    }

    state.shapeByEntity.set(e.eid, handle);
    bodyRec.massDirty = true;
  });

  // ── Exit ───────────────────────────────────────────────────────────────────

  system.exit((e) => {
    // Chain teardown: destroy all segment shapes.
    const chainHandles = state.chainShapeByEntity.get(e.eid);
    if (chainHandles !== undefined) {
      // Read bodyHandle from the first segment before destroying.
      const firstSeg = state.shapes.records[chainHandles[0]!.index];
      const chainBodyHandle = firstSeg?.bodyHandle;
      for (const h of chainHandles) {
        destroyShape(state, h);
      }
      state.chainShapeByEntity.delete(e.eid);
      if (chainBodyHandle !== undefined && chainBodyHandle.index !== NULL_INDEX) {
        const bodyRec = state.bodies.records[chainBodyHandle.index];
        if (bodyRec !== undefined) {
          bodyRec.massDirty = true;
        }
      }
      return;
    }

    // Single-shape teardown.
    const handle = state.shapeByEntity.get(e.eid);
    if (handle === undefined) {
      return;
    } // idempotent

    const shape = state.shapes.records[handle.index];
    const bodyHandle = shape?.bodyHandle;

    destroyShape(state, handle);
    state.shapeByEntity.delete(e.eid);

    // Mark the parent body massDirty (body may still be alive).
    if (bodyHandle !== undefined && bodyHandle.index !== NULL_INDEX) {
      const bodyRec = state.bodies.records[bodyHandle.index];
      if (bodyRec !== undefined) {
        bodyRec.massDirty = true;
      }
    }
  });

  // ── Update — geometry rebuild ──────────────────────────────────────────────

  // Each geometry update handler rebuilds the shape's geometry union and
  // recomputes the world AABB + fat AABB, then moves the proxy.

  system.update(Box, (e, box) => {
    rebuildSingleShape(e.eid, state, (shape) => {
      (shape.geometry as PolygonGeometry) = makeBox(box.hx, box.hy);
      shape.type = ShapeType.Polygon;
    });
  });

  system.update(Circle, (e, circle) => {
    rebuildSingleShape(e.eid, state, (shape) => {
      shape.geometry = { kind: "circle", cx: 0, cy: 0, radius: circle.radius };
      shape.type = ShapeType.Circle;
    });
  });

  system.update(Capsule, (e, capsule) => {
    // Keep old valid shape if the new endpoints are degenerate (Box2D setter).
    if (!hasValidEndpoints(capsule.x1, capsule.y1, capsule.x2, capsule.y2)) {
      console.warn("Capsule update ignored — endpoint distance <= LINEAR_SLOP (Box2D parity)");
      return;
    }
    rebuildSingleShape(e.eid, state, (shape) => {
      shape.geometry = {
        kind: "capsule",
        ax: capsule.x1,
        ay: capsule.y1,
        bx: capsule.x2,
        by: capsule.y2,
        radius: capsule.radius,
      };
      shape.type = ShapeType.Capsule;
    });
  });

  system.update(Segment, (e, segment) => {
    // Keep old valid shape if the new endpoints are degenerate (Box2D setter).
    if (!hasValidEndpoints(segment.x1, segment.y1, segment.x2, segment.y2)) {
      console.warn("Segment update ignored — endpoint distance <= LINEAR_SLOP (Box2D parity)");
      return;
    }
    rebuildSingleShape(e.eid, state, (shape) => {
      shape.geometry = {
        kind: "segment",
        ax: segment.x1,
        ay: segment.y1,
        bx: segment.x2,
        by: segment.y2,
      };
      shape.type = ShapeType.Segment;
    });
  });

  system.update(Polygon, (e, polygon) => {
    if (polygon.vertices.length < 3) {
      return;
    }
    const hull = computeHull(polygon.vertices);
    if (hull.count < 3 || !validateHull(hull)) {
      return;
    }
    const geom = makePolygon(hull, polygon.radius);
    rebuildSingleShape(e.eid, state, (shape) => {
      shape.geometry = geom;
      shape.type = ShapeType.Polygon;
    });
  });

  system.update(Chain, (e, chain) => {
    const parentEntity = e.parent(ChildOf);
    if (parentEntity === undefined) {
      return;
    }
    const bodyHandle = state.bodyByEntity.get(parentEntity.eid);
    if (bodyHandle === undefined) {
      return;
    }

    // Destroy old segments.
    const oldHandles = state.chainShapeByEntity.get(e.eid);
    if (oldHandles !== undefined) {
      for (const h of oldHandles) {
        destroyShape(state, h);
      }
      state.chainShapeByEntity.delete(e.eid);
    }

    const bodyRec = state.bodies.get(bodyHandle.index);
    const bodyXf = getBodyWorldTransform(state, bodyHandle);
    const shapePos = e.get(ShapePosition) as ShapePosition | undefined;
    const shapeRot = e.get(ShapeRotation) as ShapeRotation | undefined;
    const lx = shapePos?.x ?? 0;
    const ly = shapePos?.y ?? 0;
    const lq = makeRot(shapeRot?.angle ?? 0);
    const localXf: Transform = { p: { x: lx, y: ly }, q: lq };
    const worldXf = mulTransforms(bodyXf, localXf);
    const opts = readMaterialOpts(e);

    enterChain(
      e.eid,
      chain,
      worldXf,
      localXf,
      bodyHandle,
      bodyRec.type,
      bodyRec.setIndex,
      opts,
      state
    );
    bodyRec.massDirty = true;
  });

  // ── Update — reparenting ───────────────────────────────────────────────────

  // Fires when ChildOf changes on a matched entity (the entity stays matched
  // because its new parent also has Body; losing Body causes exit instead).
  // Contact teardown on type-change reparent is deferred to M3.
  system.update(ChildOf, (e, childOf) => {
    const newParentEntity = (childOf as unknown as { target?: { eid: number } }).target;
    if (newParentEntity === undefined) {
      return;
    }

    const newBodyHandle = state.bodyByEntity.get(newParentEntity.eid);
    if (newBodyHandle === undefined) {
      return;
    } // new parent is not a body

    const newBodyRec = state.bodies.get(newBodyHandle.index);
    const newBodyXf = getBodyWorldTransform(state, newBodyHandle);

    // Chain reparent.
    const chainHandles = state.chainShapeByEntity.get(e.eid);
    if (chainHandles !== undefined) {
      if (chainHandles.length === 0) {
        return;
      }
      const firstSeg = state.shapes.get(chainHandles[0]!.index);
      const oldBodyHandle = firstSeg.bodyHandle;
      for (const h of chainHandles) {
        const seg = state.shapes.get(h.index);
        unlinkShapeFromBody(state, h, oldBodyHandle);
        linkShapeToBody(state, h, newBodyHandle);
        seg.bodyHandle = newBodyHandle;
        const localXf: Transform = {
          p: { x: seg.localX, y: seg.localY },
          q: { c: seg.localCos, s: seg.localSin },
        };
        const worldXf = mulTransforms(newBodyXf, localXf);
        const fatAABB = updateShapeAABBs(seg, worldXf, newBodyRec.type);
        if (seg.proxyKey !== -1) {
          state.broadPhase.destroyProxy(seg.proxyKey);
          seg.proxyKey = -1;
        }
        if (newBodyRec.setIndex !== DISABLED_SET) {
          seg.proxyKey = state.broadPhase.createProxy(
            newBodyRec.type,
            fatAABB,
            seg.categoryBits,
            h.index
          );
        }
      }
      if (oldBodyHandle.index !== NULL_INDEX) {
        const oldRec = state.bodies.records[oldBodyHandle.index];
        if (oldRec !== undefined) {
          oldRec.massDirty = true;
        }
      }
      newBodyRec.massDirty = true;
      return;
    }

    // Single-shape reparent.
    const handle = state.shapeByEntity.get(e.eid);
    if (handle === undefined) {
      return;
    }

    const shape = state.shapes.get(handle.index);
    const oldBodyHandle = shape.bodyHandle;

    unlinkShapeFromBody(state, handle, oldBodyHandle);
    linkShapeToBody(state, handle, newBodyHandle);
    shape.bodyHandle = newBodyHandle;

    const localXf: Transform = {
      p: { x: shape.localX, y: shape.localY },
      q: { c: shape.localCos, s: shape.localSin },
    };
    const worldXf = mulTransforms(newBodyXf, localXf);
    const fatAABB = updateShapeAABBs(shape, worldXf, newBodyRec.type);

    if (shape.proxyKey !== -1) {
      state.broadPhase.destroyProxy(shape.proxyKey);
      shape.proxyKey = -1;
    }
    if (newBodyRec.setIndex !== DISABLED_SET) {
      shape.proxyKey = state.broadPhase.createProxy(
        newBodyRec.type,
        fatAABB,
        shape.categoryBits,
        handle.index
      );
    }

    if (oldBodyHandle.index !== NULL_INDEX) {
      const oldRec = state.bodies.records[oldBodyHandle.index];
      if (oldRec !== undefined) {
        oldRec.massDirty = true;
      }
    }
    newBodyRec.massDirty = true;
  });

  return system;
}

// ─── Geometry-rebuild helper ──────────────────────────────────────────────────

/** Rebuild a single (non-chain) shape after a geometry update. Recomputes the
 * world AABB, moves the broad-phase proxy, and marks massDirty. */
function rebuildSingleShape(
  eid: number,
  state: PhysicsState,
  mutateFn: (shape: InternalShape) => void
): void {
  const handle = state.shapeByEntity.get(eid);
  if (handle === undefined) {
    return;
  }
  const shape = state.shapes.get(handle.index);

  mutateFn(shape);

  const bodyXf = getBodyWorldTransform(state, shape.bodyHandle);
  const localXf: Transform = {
    p: { x: shape.localX, y: shape.localY },
    q: { c: shape.localCos, s: shape.localSin },
  };
  const worldXf = mulTransforms(bodyXf, localXf);
  const bodyType = state.bodies.get(shape.bodyHandle.index).type;
  const fatAABB = updateShapeAABBs(shape, worldXf, bodyType);

  // Only move the proxy if it exists (disabled bodies have no proxy).
  if (shape.proxyKey !== -1) {
    state.broadPhase.moveProxy(shape.proxyKey, fatAABB);
  }
  state.bodies.get(shape.bodyHandle.index).massDirty = true;
}
