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
import { updateShapeAABBs } from "../engine/shape.js";
import type { PhysicsState } from "../engine/state.js";
import { makeRot } from "../math/rot.js";
import { mulTransforms, type Transform } from "../math/transform.js";
import type { BodyHandle } from "../util/handle.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Read the body's current world transform from its BodySim. */
function getBodyWorldTransform(state: PhysicsState, bodyHandle: BodyHandle): Transform {
  const bodyRec = state.bodies.get(bodyHandle.index);
  const sim = state.solverSets[bodyRec.setIndex]!.bodySims[bodyRec.localIndex]!;
  return { p: { x: sim.transformX, y: sim.transformY }, q: { c: sim.cos, s: sim.sin } };
}

/** Update local pose fields from new localX/Y/Cos/Sin, recompute AABBs, and
 * move/enlarge the broad-phase proxy for a single shape. Marks the owning body
 * massDirty because the local pose affects the body-local center of mass and
 * inertia (mirrors b2Shape_SetLocalTransform intent). */
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
  const bodyRec = state.bodies.get(shape.bodyHandle.index);
  const fatAABB = updateShapeAABBs(shape, worldXf, bodyRec.type);

  state.broadPhase.moveProxy(shape.proxyKey, fatAABB);
  bodyRec.massDirty = true;
}

/** Update all chain segment shapes with a new local pose. Chain segments share
 * the same local pose (the pose of the chain entity). Marks the owning body
 * massDirty for extents consistency (chain segments have zero mass, but extents
 * also depend on world AABB). */
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

  let lastBodyHandle = undefined;
  for (const h of handles) {
    const seg = state.shapes.get(h.index);
    seg.localX = lx;
    seg.localY = ly;
    seg.localCos = lcos;
    seg.localSin = lsin;

    const bodyXf = getBodyWorldTransform(state, seg.bodyHandle);
    const localXf: Transform = { p: { x: lx, y: ly }, q: { c: lcos, s: lsin } };
    const worldXf = mulTransforms(bodyXf, localXf);
    const bodyRec = state.bodies.get(seg.bodyHandle.index);
    const fatAABB = updateShapeAABBs(seg, worldXf, bodyRec.type);

    state.broadPhase.moveProxy(seg.proxyKey, fatAABB);
    lastBodyHandle = seg.bodyHandle;
  }
  // Mark the body massDirty once after all segments are updated.
  if (lastBodyHandle !== undefined) {
    state.bodies.get(lastBodyHandle.index).massDirty = true;
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
