// `PhysicsShapePoseSync` — propagates ShapePosition and ShapeRotation changes
// to the internal shape's local-pose fields, then recomputes the world AABB +
// fat AABB and updates the broad-phase proxy.
//
// Runs in `physics-pre` after `PhysicsShapeLifecycle`. The shape record must
// already exist in `state.shapeByEntity` when these update callbacks fire.
//
// Cross-ticket contract (PROGRESS.md → _Cross-ticket contracts_):
//   World AABB = computeAABB(geom, mul(bodyWorldTransform, localPose)).
//   This system composes the new local pose with the body's current world
//   transform and recomputes the AABB from scratch on every update.
//
// Upstream sources:
//   box2d/src/shape.c — b2Shape_SetLocalTransform (hypothetical combined setter),
//                       b2UpdateShapeAABBs

import { type IPhase, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "../components/geometry.js";
import { ShapePosition, ShapeRotation } from "../components/shape_pose.js";
import { computeAABB } from "../engine/geometry.js";
import { STATIC_BODY } from "../engine/body.js";
import type { InternalShape } from "../engine/shape.js";
import type { PhysicsState } from "../engine/state.js";
import { AABB_MARGIN_FRACTION, MAX_AABB_MARGIN, SPECULATIVE_DISTANCE } from "../math/constants.js";
import { makeRot } from "../math/rot.js";
import { mulTransforms, type Transform } from "../math/transform.js";
import type { BodyHandle } from "../util/handle.js";

// ─── Helpers shared with shape_lifecycle ──────────────────────────────────────

/** Read the body's current world transform from its BodySim. */
function getBodyWorldTransform(state: PhysicsState, bodyHandle: BodyHandle): Transform {
  const bodyRec = state.bodies.get(bodyHandle.index);
  const sim = state.solverSets[bodyRec.setIndex]!.bodySims[bodyRec.localIndex]!;
  return { p: { x: sim.transformX, y: sim.transformY }, q: { c: sim.cos, s: sim.sin } };
}

/** Compute shape margin (mirrors b2ComputeShapeMargin, duplicated here to avoid
 * cross-system imports; the function is small and pure). */
function computeShapeMargin(geom: InternalShape["geometry"]): number {
  let raw: number;
  switch (geom.kind) {
    case "circle":
      raw = geom.radius;
      break;
    case "capsule": {
      const dx = geom.bx - geom.ax;
      const dy = geom.by - geom.ay;
      raw = 0.5 * Math.sqrt(dx * dx + dy * dy) + geom.radius;
      break;
    }
    case "segment":
    case "chainSegment": {
      const dx = geom.bx - geom.ax;
      const dy = geom.by - geom.ay;
      raw = 0.5 * Math.sqrt(dx * dx + dy * dy);
      break;
    }
    case "polygon": {
      const cx = geom.centroidX;
      const cy = geom.centroidY;
      let maxSq = 0;
      for (let i = 0; i < geom.count; i++) {
        const vx = geom.vertices[i * 2]! - cx;
        const vy = geom.vertices[i * 2 + 1]! - cy;
        const sq = vx * vx + vy * vy;
        if (sq > maxSq) {
          maxSq = sq;
        }
      }
      raw = Math.sqrt(maxSq);
      break;
    }
  }
  return Math.min(MAX_AABB_MARGIN, AABB_MARGIN_FRACTION * raw);
}

/** Recompute and write the tight + fat AABBs for `shape`, return the fat AABB. */
function refreshAABBs(
  shape: InternalShape,
  worldXf: Transform,
  bodyType: number
): { lowerBound: { x: number; y: number }; upperBound: { x: number; y: number } } {
  const raw = computeAABB(shape.geometry, worldXf);
  const spec = SPECULATIVE_DISTANCE;
  shape.aabbMinX = raw.lowerBound.x - spec;
  shape.aabbMinY = raw.lowerBound.y - spec;
  shape.aabbMaxX = raw.upperBound.x + spec;
  shape.aabbMaxY = raw.upperBound.y + spec;

  const extra = bodyType === STATIC_BODY ? 0 : computeShapeMargin(shape.geometry);
  shape.fatAabbMinX = shape.aabbMinX - extra;
  shape.fatAabbMinY = shape.aabbMinY - extra;
  shape.fatAabbMaxX = shape.aabbMaxX + extra;
  shape.fatAabbMaxY = shape.aabbMaxY + extra;

  return {
    lowerBound: { x: shape.fatAabbMinX, y: shape.fatAabbMinY },
    upperBound: { x: shape.fatAabbMaxX, y: shape.fatAabbMaxY },
  };
}

/** Update local pose fields from new localX/Y/Cos/Sin, recompute AABBs, and
 * move/enlarge the broad-phase proxy for a single shape. */
function refreshSingleShape(
  eid: number,
  state: PhysicsState,
  lx: number,
  ly: number,
  lcos: number,
  lsin: number
): void {
  const handle = state.shapeByEntity.get(eid);
  if (handle === undefined) {
    return;
  }
  const shape = state.shapes.get(handle.index);

  shape.localX = lx;
  shape.localY = ly;
  shape.localCos = lcos;
  shape.localSin = lsin;

  const bodyXf = getBodyWorldTransform(state, shape.bodyHandle);
  const localXf: Transform = { p: { x: lx, y: ly }, q: { c: lcos, s: lsin } };
  const worldXf = mulTransforms(bodyXf, localXf);
  const bodyType = state.bodies.get(shape.bodyHandle.index).type;
  const fatAABB = refreshAABBs(shape, worldXf, bodyType);

  state.broadPhase.moveProxy(shape.proxyKey, fatAABB);
}

/** Update all chain segment shapes with a new local pose. Chain segments share
 * the same local pose (the pose of the chain entity). */
function refreshChainShapes(
  eid: number,
  state: PhysicsState,
  lx: number,
  ly: number,
  lcos: number,
  lsin: number
): void {
  const handles = state.chainShapeByEntity.get(eid);
  if (handles === undefined) {
    return;
  }

  for (const h of handles) {
    const seg = state.shapes.get(h.index);
    seg.localX = lx;
    seg.localY = ly;
    seg.localCos = lcos;
    seg.localSin = lsin;

    const bodyXf = getBodyWorldTransform(state, seg.bodyHandle);
    const localXf: Transform = { p: { x: lx, y: ly }, q: { c: lcos, s: lsin } };
    const worldXf = mulTransforms(bodyXf, localXf);
    const bodyType = state.bodies.get(seg.bodyHandle.index).type;
    const fatAABB = refreshAABBs(seg, worldXf, bodyType);

    state.broadPhase.moveProxy(seg.proxyKey, fatAABB);
  }
}

// ─── System factory ───────────────────────────────────────────────────────────

/** Create `PhysicsShapePoseSync` on `world`, bound to `state` and `phase`. */
export function installShapePoseSync(world: World, state: PhysicsState, phase: IPhase): System {
  const system = world
    .system("PhysicsShapePoseSync")
    .query({ all: [{ any: [Box, Circle, Capsule, Segment, Polygon, Chain] }, { parent: Body }] })
    .phase(phase);

  // ── ShapePosition update ───────────────────────────────────────────────────

  system.update(ShapePosition, (e, pos) => {
    const shapeRot = e.get(ShapeRotation) as ShapeRotation | undefined;
    const lq = makeRot(shapeRot?.angle ?? 0);

    if (state.chainShapeByEntity.has(e.eid)) {
      refreshChainShapes(e.eid, state, pos.x, pos.y, lq.c, lq.s);
    } else {
      refreshSingleShape(e.eid, state, pos.x, pos.y, lq.c, lq.s);
    }
  });

  // ── ShapeRotation update ───────────────────────────────────────────────────

  system.update(ShapeRotation, (e, rot) => {
    const shapePos = e.get(ShapePosition) as ShapePosition | undefined;
    const lx = shapePos?.x ?? 0;
    const ly = shapePos?.y ?? 0;
    const lq = makeRot(rot.angle);

    if (state.chainShapeByEntity.has(e.eid)) {
      refreshChainShapes(e.eid, state, lx, ly, lq.c, lq.s);
    } else {
      refreshSingleShape(e.eid, state, lx, ly, lq.c, lq.s);
    }
  });

  return system;
}
