// `PhysicsDebugValidation` — per-step structural validation with warn-once
// semantics. Registered ONLY when `installPhysics` is called with
// `{ debug: true }`. In normal mode this system is never installed, and no
// validation overhead exists.
//
// Phase: `physics-pre`, AFTER all other physics-pre systems (last position).
// This ensures the validator sees the world after lifecycle/sync have run, so
// ephemeral intermediate states during entity construction are not flagged.
//
// Six issue codes (docs/debug-validation.md):
//   1. shape-without-parent-body     — geometry entity whose immediate parent
//                                      lacks Body (or has no parent at all).
//   2. dynamic-body-without-density  — dynamic Body with no valid shape child:
//                                      either no children, or every non-sensor
//                                      child shape has Material.density === 0.
//   3. chain-too-few-points          — Chain.points.length < 4.
//   4. polygon-invalid               — Polygon.vertices fail validateHull.
//   5. shape-position-on-body        — entity has Body AND ShapePosition or
//                                      ShapeRotation.
//   6. position-on-shape-entity      — entity has a geometry component AND
//                                      Position.
//
// Re-arm semantics: when a (eid, code) pair that was previously warned becomes
// valid for that code (issue cleared), we call rearm() so a future relapse can
// warn again. The WarnDedupe key is `(eid, code)`, so each code is independent.
//
// Design points:
//   - Uses world.filter() scans (non-reactive) — same pattern as ForceGather.
//     An entity enters the relevant filter when it carries the matching
//     component(s), and the validator re-checks it every step.
//   - WarnDedupe instance is owned by this system (survives across steps).
//   - The injectable WarnSink in WarnDedupe is the test hook; pass it via the
//     `sink` option of installDebugValidation.
//   - Does NOT modify any engine state — read-only pass.
//
// Upstream docs: docs/debug-validation.md.
// Re-uses: validateHull / computeHull from engine/geometry.ts.

import { ChildOf, type Filter, type IPhase, type System, type World } from "@vworlds/vecs";

import { Body, BodyType, Position } from "../components/body.js";
import { Box, Capsule, Chain, Circle, Polygon, Segment } from "../components/geometry.js";
import { Material, Sensor } from "../components/material.js";
import { ShapePosition, ShapeRotation } from "../components/shape_pose.js";
import { computeHull, validateHull } from "../engine/geometry.js";
import { type WarnSink, WarnDedupe } from "../util/warn.js";

// ─── Issue codes ──────────────────────────────────────────────────────────────

const CODE_SHAPE_WITHOUT_PARENT_BODY = "shape-without-parent-body";
const CODE_DYNAMIC_BODY_WITHOUT_DENSITY = "dynamic-body-without-density";
const CODE_CHAIN_TOO_FEW_POINTS = "chain-too-few-points";
const CODE_POLYGON_INVALID = "polygon-invalid";
const CODE_SHAPE_POSITION_ON_BODY = "shape-position-on-body";
const CODE_POSITION_ON_SHAPE_ENTITY = "position-on-shape-entity";

// ─── Options ──────────────────────────────────────────────────────────────────

/** Options for {@link installDebugValidation}. */
export interface DebugValidationOptions {
  /** Override the warning sink (default `console.warn`). Primarily for tests. */
  sink?: WarnSink;
}

// ─── System factory ───────────────────────────────────────────────────────────

/** Create `PhysicsDebugValidation` on `world` in `phase`.
 * Returns the system so the caller can tag its entity. */
export function installDebugValidation(
  world: World,
  phase: IPhase,
  opts: DebugValidationOptions = {}
): System {
  const dedupe = new WarnDedupe(opts.sink);

  // ── Filters (non-reactive; walked every step) ─────────────────────────────
  // Geometry entities: any entity with at least one geometry component.
  const geomFilter: Filter = world.filter({ any: [Box, Circle, Capsule, Segment, Polygon, Chain] });

  // Body entities: any entity with Body.
  const bodyFilter: Filter = world.filter(Body);

  // Body entities that also carry ShapePosition or ShapeRotation.
  const bodyPoseFilter: Filter = world.filter({
    all: [Body, { any: [ShapePosition, ShapeRotation] }],
  });

  return world
    .system("PhysicsDebugValidation")
    .phase(phase)
    .run(() => {
      _validateGeomEntities(geomFilter, dedupe);
      _validateBodyEntities(geomFilter, bodyFilter, dedupe);
      _validateBodyShapePositionEntities(bodyPoseFilter, dedupe);
    });
}

// ─── Geometry-entity validation ───────────────────────────────────────────────

/** Walk every entity with a geometry component and check:
 *   - shape-without-parent-body (code 1)
 *   - chain-too-few-points      (code 3)
 *   - polygon-invalid           (code 4)
 *   - position-on-shape-entity  (code 6) */
function _validateGeomEntities(geomFilter: Filter, dedupe: WarnDedupe): void {
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
      const hull = computeHull(polygon.vertices);
      const valid = hull.count > 0 && validateHull(hull);
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
 * To find child shapes without engine-state access, we build a map of
 * body-eid → geometry child entities by walking the geometry filter and checking
 * which have a direct Body parent. This is a read-only ECS walk with no
 * dependency on PhysicsState internals. */
function _validateBodyEntities(geomFilter: Filter, bodyFilter: Filter, dedupe: WarnDedupe): void {
  // Build a map: body-eid → list of geometry child entities (per this step).
  const geomChildrenByBody = new Map<number, ReturnType<typeof geomFilter.forEach>[]>();

  geomFilter.forEach((e) => {
    const parent = e.parent(ChildOf);
    if (parent === undefined) {
      return;
    }
    if (parent.get(Body) === undefined) {
      return;
    }
    const bodyEid: number = parent.eid;
    let list = geomChildrenByBody.get(bodyEid);
    if (list === undefined) {
      list = [];
      geomChildrenByBody.set(bodyEid, list);
    }
    // Store the entity itself for later inspection.
    (list as any[]).push(e);
  });

  // Walk every body entity and check dynamic-body-without-density.
  bodyFilter.forEach((e) => {
    const eid: number = e.eid;
    const body = e.get(Body) as Body;

    if (body.type !== BodyType.Dynamic) {
      // Only dynamic bodies require density — re-arm so a type change back to
      // Dynamic can warn again if the body still has no valid shapes.
      dedupe.rearm(eid, CODE_DYNAMIC_BODY_WITHOUT_DENSITY);
      return;
    }

    const children = geomChildrenByBody.get(eid) as any[] | undefined;

    // A dynamic body with no geometry children always warns.
    if (children === undefined || children.length === 0) {
      dedupe.warnOnce(
        eid,
        CODE_DYNAMIC_BODY_WITHOUT_DENSITY,
        `Entity${eid} is a dynamic body with no shape children; it will have zero mass.`
      );
      return;
    }

    // Check if ANY non-sensor child has density > 0.
    // Missing Material means default density = 1 (fine).
    let hasValidDensity = false;
    for (const child of children) {
      const isSensor = child.get(Sensor) !== undefined;
      if (isSensor) {
        continue; // sensors do not contribute mass
      }
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
        `Entity${eid} is a dynamic body whose non-sensor shapes all have density 0; it will have zero mass.`
      );
    } else {
      dedupe.rearm(eid, CODE_DYNAMIC_BODY_WITHOUT_DENSITY);
    }
  });
}

// ─── Body-with-shape-pose validation ─────────────────────────────────────────

/** Walk entities that have Body AND ShapePosition or ShapeRotation (code 5). */
function _validateBodyShapePositionEntities(bodyPoseFilter: Filter, dedupe: WarnDedupe): void {
  bodyPoseFilter.forEach((e) => {
    const eid: number = e.eid;
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
    // No rearm: if the entity leaves this filter (ShapePosition/ShapeRotation
    // removed), it won't be visited. If it re-enters, the prior warning is
    // preserved (correct — same entity, same structural issue).
  });
}
