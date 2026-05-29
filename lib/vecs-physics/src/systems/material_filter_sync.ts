// `PhysicsMaterialFilterSync` — propagates Material, CollisionFilter, and
// Sensor changes from ECS components to the corresponding InternalShape fields.
//
// Runs in `physics-pre` after `PhysicsShapeLifecycle`. The shape record must
// already exist in `state.shapeByEntity` or `state.chainShapeByEntity` when
// these update callbacks fire.
//
// Deferred to M3 (no contact graph yet):
//   Contact refilter on CollisionFilter change — existing incompatible contacts
//   must be destroyed when category/mask bits change (box2d calls
//   `b2RefilterShape` which walks the contact list). Documented here, mirroring
//   the PhysicsBodyLifecycle.exit contact-teardown deferral.
//
// Upstream sources:
//   box2d/src/shape.c — b2Shape_SetDensity, b2Shape_SetFilter, b2Shape_EnableSensorEvents

import { type IPhase, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "../components/geometry.js";
import { CollisionFilter, Material } from "../components/material.js";
import { DYNAMIC_BODY } from "../engine/body.js";
import type { InternalShape } from "../engine/shape.js";
import type { PhysicsState } from "../engine/state.js";
import { NULL_INDEX } from "../util/handle.js";

/** Create `PhysicsMaterialFilterSync` on `world`, bound to `state` and `phase`. */
export function installMaterialFilterSync(
  world: World,
  state: PhysicsState,
  phase: IPhase
): System {
  const system = world
    .system("PhysicsMaterialFilterSync")
    .query({ all: [{ any: [Box, Circle, Capsule, Segment, Polygon, Chain] }, { parent: Body }] })
    .phase(phase);

  // ── Material update ────────────────────────────────────────────────────────

  system.update(Material, (e, mat) => {
    // Chain shapes — update all segments.
    const chainHandles = state.chainShapeByEntity.get(e.eid);
    if (chainHandles !== undefined) {
      for (const h of chainHandles) {
        const seg = state.shapes.get(h.index);
        const densityChanged = seg.density !== mat.density;
        _applyMaterial(seg, mat);
        if (densityChanged) {
          _maybeDirtyMass(state, seg);
        }
      }
      return;
    }

    // Single shape.
    const handle = state.shapeByEntity.get(e.eid);
    if (handle === undefined) {
      return;
    }
    const shape = state.shapes.get(handle.index);
    const densityChanged = shape.density !== mat.density;
    _applyMaterial(shape, mat);
    if (densityChanged) {
      _maybeDirtyMass(state, shape);
    }
  });

  // ── CollisionFilter update ─────────────────────────────────────────────────

  system.update(CollisionFilter, (e, filt) => {
    // Chain shapes.
    const chainHandles = state.chainShapeByEntity.get(e.eid);
    if (chainHandles !== undefined) {
      for (const h of chainHandles) {
        const seg = state.shapes.get(h.index);
        seg.categoryBits = filt.categoryBits;
        seg.maskBits = filt.maskBits;
        seg.groupIndex = filt.groupIndex;
        // NOTE: contact refilter (destroy now-incompatible contacts) is
        // deferred to M3 — no contact graph exists yet.
      }
      return;
    }

    const handle = state.shapeByEntity.get(e.eid);
    if (handle === undefined) {
      return;
    }
    const shape = state.shapes.get(handle.index);
    shape.categoryBits = filt.categoryBits;
    shape.maskBits = filt.maskBits;
    shape.groupIndex = filt.groupIndex;
    // NOTE: contact refilter deferred to M3.
  });

  // NOTE: Sensor is an add/remove component (no data), not an update. The
  // sensor flag is set at shape creation by PhysicsShapeLifecycle (reading
  // `e.get(Sensor) !== undefined`). Dynamic isSensor changes are deferred to
  // M3: box2d forbids them without destroying active contacts first (which
  // requires the contact graph). Shape recreation (remove + add geometry) is
  // the safe way to change sensor status before M3.

  return system;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _applyMaterial(shape: InternalShape, mat: Material): void {
  shape.density = mat.density;
  shape.friction = mat.friction;
  shape.restitution = mat.restitution;
  shape.rollingResistance = mat.rollingResistance;
  shape.tangentSpeed = mat.tangentSpeed;
  shape.userMaterialId = mat.userMaterialId;
}

/** Mark the owning body massDirty. Only called when density actually changed.
 * Static / kinematic bodies do not participate in mass computation. */
function _maybeDirtyMass(state: PhysicsState, shape: InternalShape): void {
  if (shape.bodyHandle.index === NULL_INDEX) {
    return;
  }
  const bodyRec = state.bodies.records[shape.bodyHandle.index];
  if (bodyRec === undefined) {
    return;
  }
  if (bodyRec.type !== DYNAMIC_BODY) {
    return;
  }
  bodyRec.massDirty = true;
}
