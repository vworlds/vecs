// `PhysicsDebugValidation` — per-step structural validation with warn-once
// semantics. Registered ONLY when `installPhysics` is called with
// `{ debug: true }`. In normal mode this system is never installed, and no
// validation overhead exists.
//
// Phase: `physics-pre`, AFTER all other physics-pre systems (last position).
// This ensures the validator sees the world after lifecycle/sync have run, so
// ephemeral intermediate states during entity construction are not flagged.
//
// Seven issue codes (docs/debug-validation.md):
//   1. shape-without-parent-body     — geometry entity whose immediate parent
//                                      lacks Body (or has no parent at all).
//   2. dynamic-body-without-density  — dynamic Body with no valid shape child:
//                                      either no children, or every child shape
//                                      has Material.density === 0. Sensor shapes
//                                      with positive density DO contribute mass
//                                      (Box2D parity: skip only density === 0).
//   3. chain-too-few-points          — Chain.points.length < 4.
//   4. polygon-invalid               — Polygon.vertices fail validateHull.
//   5. shape-position-on-body        — entity has Body AND ShapePosition or
//                                      ShapeRotation.
//   6. position-on-shape-entity      — entity has a geometry component AND
//                                      Position.
//   7. force-without-target          — force/impulse entity has no Body and no
//                                      immediate Body parent.
//
// Re-arm semantics: when a (eid, code) pair that was previously warned becomes
// valid for that code (issue cleared), we call rearm() so a future relapse can
// warn again. The WarnDedupe key is `(eid, code)`, so each code is independent.
//
// Design points:
//   - Uses world.filter() scans (non-reactive) — same pattern as ForceGather.
//     An entity enters the relevant filter when it carries the matching
//     component(s), and the validator re-checks it every step.
//   - WarnDedupe instance is owned by PhysicsState (survives across systems).
//   - The injectable WarnSink in WarnDedupe is the test hook; pass it via
//     PhysicsOptions.debugSink.
//   - Does NOT modify any engine state — read-only pass.
//
// Upstream docs: docs/debug-validation.md.
// Polygon validity is checked via b2ComputeHull (box2d3-wasm); see isValidPolygon.

import {
  ChildOf,
  type Entity,
  type Filter,
  type IPhase,
  type System,
  type World,
} from "@vworlds/vecs";

import { Body, BodyType, Position } from "../components/body.js";
import { AngularImpulse, Force, Impulse, Torque } from "../components/force.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "../components/geometry.js";
import { Material } from "../components/material.js";
import { ShapePosition, ShapeRotation } from "../components/shape_pose.js";
import { type PhysicsState } from "../adapter/state.js";
import { type WarnDedupe } from "../util/warn.js";

// ─── Issue codes ──────────────────────────────────────────────────────────────

const CODE_SHAPE_WITHOUT_PARENT_BODY = "shape-without-parent-body";
const CODE_DYNAMIC_BODY_WITHOUT_DENSITY = "dynamic-body-without-density";
const CODE_CHAIN_TOO_FEW_POINTS = "chain-too-few-points";
const CODE_POLYGON_INVALID = "polygon-invalid";
const CODE_SHAPE_POSITION_ON_BODY = "shape-position-on-body";
const CODE_POSITION_ON_SHAPE_ENTITY = "position-on-shape-entity";
const CODE_FORCE_WITHOUT_TARGET = "force-without-target";

// ─── System factory ───────────────────────────────────────────────────────────

/** Create `PhysicsDebugValidation` on `world` in `phase`.
 * Returns the system so the caller can tag its entity. */
export function installDebugValidation(world: World, state: PhysicsState, phase: IPhase): System {
  // ── Filters (non-reactive; walked every step) ─────────────────────────────
  // Geometry entities: any entity with at least one geometry component.
  const geomFilter: Filter = world.filter({ any: [Box, Circle, Capsule, Segment, Polygon, Chain] });

  // Body entities: any entity with Body.
  const bodyFilter: Filter = world.filter(Body);

  // Force-class entities: any entity with a force, torque, impulse, or angular impulse.
  const forceFilter: Filter = world.filter({ any: [Force, Torque, Impulse, AngularImpulse] });

  // Body entities that also carry ShapePosition or ShapeRotation.
  const bodyPoseFilter: Filter = world.filter({
    all: [Body, { any: [ShapePosition, ShapeRotation] }],
  });

  // Track body-pose entities seen in the previous step so we can rearm those
  // that leave the filter (ShapePosition/ShapeRotation removed). Re-entry into
  // the filter will then produce a fresh warning, completing the re-arm cycle.
  const prevBodyPoseEids = new Set<number>();

  return world
    .system("PhysicsDebugValidation")
    .phase(phase)
    .run(() => {
      _validateGeomEntities(state, geomFilter, state.warn);
      _validateBodyEntities(geomFilter, bodyFilter, state.warn);
      _validateBodyShapePositionEntities(bodyPoseFilter, prevBodyPoseEids, state.warn);
      _validateForceEntities(forceFilter, state.warn);
    });
}

// ─── Geometry-entity validation ───────────────────────────────────────────────

/** Walk every entity with a geometry component and check:
 *   - shape-without-parent-body (code 1)
 *   - chain-too-few-points      (code 3)
 *   - polygon-invalid           (code 4)
 *   - position-on-shape-entity  (code 6) */
function _validateGeomEntities(state: PhysicsState, geomFilter: Filter, dedupe: WarnDedupe): void {
  geomFilter.forEach((e) => {
    const eid: number = e.eid;

    // ── shape-without-parent-body (code 1) ───────────────────────────────────
    const parent = e.parent(ChildOf);
    const parentHasBody = parent !== undefined && parent.get(Body) !== undefined;
    if (!parentHasBody) {
      dedupe.warnOnce(
        eid,
        CODE_SHAPE_WITHOUT_PARENT_BODY,
        `Entity${eid} has geometry but its immediate parent does not have Body.`
      );
    } else {
      dedupe.rearm(eid, CODE_SHAPE_WITHOUT_PARENT_BODY);
    }

    // ── chain-too-few-points (code 3) ────────────────────────────────────────
    const chain = e.get(Chain) as Chain | undefined;
    if (chain !== undefined) {
      if (chain.points.length < 4) {
        dedupe.warnOnce(
          eid,
          CODE_CHAIN_TOO_FEW_POINTS,
          `Entity${eid} has Chain with ${chain.points.length} point(s); at least 4 are required.`
        );
      } else {
        dedupe.rearm(eid, CODE_CHAIN_TOO_FEW_POINTS);
      }
    }

    // ── polygon-invalid (code 4) ─────────────────────────────────────────────
    const polygon = e.get(Polygon) as Polygon | undefined;
    if (polygon !== undefined) {
      const valid = isValidPolygon(state, polygon.vertices);
      if (!valid) {
        dedupe.warnOnce(
          eid,
          CODE_POLYGON_INVALID,
          `Entity${eid} has Polygon with invalid or non-convex vertices.`
        );
      } else {
        dedupe.rearm(eid, CODE_POLYGON_INVALID);
      }
    }

    // ── position-on-shape-entity (code 6) ────────────────────────────────────
    const hasPosition = e.get(Position) !== undefined;
    if (hasPosition) {
      dedupe.warnOnce(
        eid,
        CODE_POSITION_ON_SHAPE_ENTITY,
        `Entity${eid} has a geometry component and Position; use ShapePosition for shape-local offsets.`
      );
    } else {
      dedupe.rearm(eid, CODE_POSITION_ON_SHAPE_ENTITY);
    }
  });
}

// ─── Body-entity validation ───────────────────────────────────────────────────

/** Walk every entity with a Body component and check:
 *   - dynamic-body-without-density (code 2)
 *
 * A dynamic body must have at least one child shape with density > 0. Sensor
 * shapes count — Box2D parity skips only density === 0, not isSensor shapes.
 *
 * To find child shapes without engine-state access, we build a map of
 * body-eid → geometry child entities by walking the geometry filter and checking
 * which have a direct Body parent. This is a read-only ECS walk with no
 * dependency on PhysicsState internals. */
function _validateBodyEntities(geomFilter: Filter, bodyFilter: Filter, dedupe: WarnDedupe): void {
  // Build a map: body-eid → list of geometry child entities (per this step).
  const geomChildrenByBody = new Map<number, Entity[]>();

  geomFilter.forEach((e) => {
    const parent = e.parent(ChildOf);
    if (parent === undefined || parent.get(Body) === undefined) {
      return;
    }
    const bodyEid: number = parent.eid;
    let list = geomChildrenByBody.get(bodyEid);
    if (list === undefined) {
      list = [];
      geomChildrenByBody.set(bodyEid, list);
    }
    list.push(e);
  });

  // Walk every body entity and check dynamic-body-without-density.
  bodyFilter.forEach((e) => {
    const eid: number = e.eid;
    const body = e.get(Body) as Body;

    if (body.type !== BodyType.Dynamic) {
      return;
    }

    const children = geomChildrenByBody.get(eid);

    // A dynamic body with no geometry children always warns.
    if (children === undefined || children.length === 0) {
      dedupe.warnOnce(
        eid,
        CODE_DYNAMIC_BODY_WITHOUT_DENSITY,
        `Entity${eid} is a dynamic body with no shape children; it will have zero mass.`
      );
      return;
    }

    // Check if ANY child shape has density > 0.
    // Sensor shapes with positive density DO contribute mass (Box2D parity:
    // b2UpdateBodyMassData skips only density === 0, not isSensor shapes).
    // Missing Material means default density = 1 (fine).
    let hasValidDensity = false;
    for (const child of children) {
      const mat = child.get(Material) as Material | undefined;
      const density = mat !== undefined ? mat.density : 1; // default density is 1
      if (density > 0) {
        hasValidDensity = true;
        break;
      }
    }

    if (!hasValidDensity) {
      dedupe.warnOnce(
        eid,
        CODE_DYNAMIC_BODY_WITHOUT_DENSITY,
        `Entity${eid} is a dynamic body whose shapes all have density 0; it will have zero mass.`
      );
    }
  });
}

// ─── Body-with-shape-pose validation ─────────────────────────────────────────

/** Walk entities that have Body AND ShapePosition or ShapeRotation (code 5).
 *
 * Re-arm mechanism: entities that leave this filter (ShapePosition/ShapeRotation
 * removed) are detected via `prevBodyPoseEids`. They are rearmed so re-entry
 * into the filter produces a fresh warning if the issue recurs. */
function _validateBodyShapePositionEntities(
  bodyPoseFilter: Filter,
  prevBodyPoseEids: Set<number>,
  dedupe: WarnDedupe
): void {
  const currentEids = new Set<number>();

  bodyPoseFilter.forEach((e) => {
    const eid: number = e.eid;
    currentEids.add(eid);

    const hasShapePos = e.get(ShapePosition) !== undefined;
    const hasShapeRot = e.get(ShapeRotation) !== undefined;

    const component =
      hasShapePos && hasShapeRot
        ? "ShapePosition and ShapeRotation"
        : hasShapePos
          ? "ShapePosition"
          : "ShapeRotation";

    dedupe.warnOnce(
      eid,
      CODE_SHAPE_POSITION_ON_BODY,
      `Entity${eid} has Body and ${component}; move ${component} to a child shape entity.`
    );
  });

  // Rearm any entities that left the filter this step (ShapePosition/ShapeRotation
  // was removed). If they re-enter in a future step, a fresh warning can fire.
  for (const eid of prevBodyPoseEids) {
    if (!currentEids.has(eid)) {
      dedupe.rearm(eid, CODE_SHAPE_POSITION_ON_BODY);
    }
  }

  // Update the previous-seen set for next step.
  prevBodyPoseEids.clear();
  for (const eid of currentEids) {
    prevBodyPoseEids.add(eid);
  }
}

// ─── Polygon hull validation ──────────────────────────────────────────────────

/**
 * Returns true if `vertices` forms a valid convex polygon according to Box2D.
 * Delegates to `b2ComputeHull` (WASM); a hull with count >= 3 is valid. Allocates
 * and frees temporary b2Vec2 objects via the WASM heap.
 */
function isValidPolygon(
  state: PhysicsState,
  vertices: ReadonlyArray<{ x: number; y: number }>
): boolean {
  if (vertices.length < 3) {
    return false;
  }
  const box2d = state.box2d;
  const points = vertices.map((v) => new box2d.b2Vec2(v.x, v.y));
  try {
    const hull = box2d.b2ComputeHull(points);
    try {
      return hull.count >= 3;
    } finally {
      hull.delete();
    }
  } finally {
    for (const p of points) {
      p.delete();
    }
  }
}

// ─── Force-target validation ─────────────────────────────────────────────────

function _validateForceEntities(forceFilter: Filter, dedupe: WarnDedupe): void {
  forceFilter.forEach((e) => {
    const eid = e.eid;
    const parent = e.parent(ChildOf);
    const hasTarget =
      e.get(Body) !== undefined || (parent !== undefined && parent.get(Body) !== undefined);

    if (!hasTarget) {
      dedupe.warnOnce(
        eid,
        CODE_FORCE_WITHOUT_TARGET,
        `Entity${eid} has Force/Torque/Impulse/AngularImpulse but no Body or immediate Body parent.`
      );
    } else {
      dedupe.rearm(eid, CODE_FORCE_WITHOUT_TARGET);
    }
  });
}
