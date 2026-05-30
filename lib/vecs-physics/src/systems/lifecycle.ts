// `PhysicsBodyLifecycle` — body creation, destruction, and type/enable changes.
//
// This is the body half of `PhysicsLifecycle` (PLAN.md → _System And Phase
// Pipeline_). It runs in the pre-step phase and owns the entity ↔ internal-body
// binding: `enter` creates an internal body and reads the entity's components
// into its sim/state, `exit` tears it down, and `update(Body)` propagates
// type/enable changes by moving the body between solver sets.
//
// This system is the components/ → engine/ boundary: it reads the public string
// `Body.type` and translates it to the engine's numeric body type and solver-set
// placement (the engine layer never sees components). Shape teardown, contact
// graph cleanup, mass recompute, and broad-phase refits referenced by the PLAN's
// lifecycle are deferred to the tickets that build those subsystems.

import { type IPhase, type System, type World } from "@vworlds/vecs";

import {
  Body,
  BodyType,
  LinearVelocity,
  AngularVelocity,
  Position,
  Rotation,
} from "../components/body.js";
import { Damping, GravityScale, MotionLocks } from "../components/body_tuning.js";
import { destroyBodyContacts } from "../engine/contact.js";
import { makeRot } from "../math/rot.js";
import {
  DYNAMIC_BODY,
  DYNAMIC_FLAG,
  KINEMATIC_BODY,
  STATIC_BODY,
  writeBodyTransform,
} from "../engine/body.js";
import { createIslandForBody, removeBodyFromIsland } from "../engine/island.js";
import { updateShapeAABBs } from "../engine/shape.js";
import {
  AWAKE_SET,
  DISABLED_SET,
  STATIC_SET,
  createBody,
  destroyBody,
  transferBody,
} from "../engine/solver_set.js";
import { type PhysicsState } from "../engine/state.js";
import { mulTransforms, type Transform } from "../math/transform.js";
import { NULL_INDEX } from "../util/handle.js";

/** Translate the public string {@link BodyType} to the engine's numeric type. */
export function bodyTypeToNumber(type: BodyType): number {
  switch (type) {
    case BodyType.Static:
      return STATIC_BODY;
    case BodyType.Kinematic:
      return KINEMATIC_BODY;
    case BodyType.Dynamic:
      return DYNAMIC_BODY;
  }
}

/** Pick the solver set a body belongs in, mirroring the placement logic in
 * `b2CreateBody`: a disabled body goes to the disabled set whatever its type, a
 * static body to the static set, and everything else (dynamic / kinematic) to
 * the awake set. Creating a body already asleep (its own sleeping set) lands
 * with sleep support (M5); until then enabled non-static bodies are always
 * awake. */
function chooseSetIndex(body: Readonly<Body>): number {
  if (!body.enabled) {
    return DISABLED_SET;
  }
  if (body.type === BodyType.Static) {
    return STATIC_SET;
  }
  return AWAKE_SET;
}

// ─── Body proxy helpers ───────────────────────────────────────────────────────

/** Destroy the broad-phase proxy for every shape attached to `bodyHandle`.
 * Leaves `shape.proxyKey = -1` so re-creation is idempotent.
 * Mirrors the loop in `b2Body_Disable` (box2d/src/body.c). */
function destroyBodyShapeProxies(
  state: PhysicsState,
  bodyRecord: ReturnType<typeof state.bodies.get>
): void {
  let shapeIndex = bodyRecord.shapeHead;
  while (shapeIndex !== NULL_INDEX) {
    const shape = state.shapes.get(shapeIndex);
    shapeIndex = shape.nextShape;
    if (shape.proxyKey !== -1) {
      state.broadPhase.destroyProxy(shape.proxyKey);
      shape.proxyKey = -1;
    }
  }
}

/** Create a broad-phase proxy for every shape attached to `bodyRecord` using
 * `newBodyType` as the tree selector (fat-AABB margin depends on body type).
 * Computes world AABBs from the current BodySim transform.
 * Mirrors the loop in `b2Body_Enable` and `b2Body_SetType` (box2d/src/body.c). */
function createBodyShapeProxies(
  state: PhysicsState,
  bodyRecord: ReturnType<typeof state.bodies.get>,
  newBodyType: number
): void {
  const sim = state.solverSets[bodyRecord.setIndex]!.bodySims[bodyRecord.localIndex]!;
  const bodyXf: Transform = {
    p: { x: sim.transformX, y: sim.transformY },
    q: { c: sim.cos, s: sim.sin },
  };

  let shapeIndex = bodyRecord.shapeHead;
  while (shapeIndex !== NULL_INDEX) {
    const currentIndex = shapeIndex;
    const shape = state.shapes.get(currentIndex);
    shapeIndex = shape.nextShape;
    const localXf: Transform = {
      p: { x: shape.localX, y: shape.localY },
      q: { c: shape.localCos, s: shape.localSin },
    };
    const worldXf = mulTransforms(bodyXf, localXf);
    const fatAABB = updateShapeAABBs(shape, worldXf, newBodyType);
    // proxyKey must be -1 before calling createProxy (assert-equivalent).
    shape.proxyKey = state.broadPhase.createProxy(
      newBodyType,
      fatAABB,
      shape.categoryBits,
      currentIndex
    );
  }
}

/** Create `PhysicsBodyLifecycle` on `world`, bound to `state` and `phase`.
 * Returns the system so the caller can tag its entity. */
export function installBodyLifecycle(world: World, state: PhysicsState, phase: IPhase): System {
  const system = world.system("PhysicsBodyLifecycle").requires(Body).phase(phase);

  system.enter((e) => {
    const body = e.get(Body)!;
    const type = bodyTypeToNumber(body.type);
    const setIndex = chooseSetIndex(body);
    const set = state.solverSets[setIndex]!;

    const handle = createBody(state, set, e, type);
    const record = state.bodies.get(handle.index);
    const sim = set.bodySims[record.localIndex]!;

    // Pose: from Position/Rotation, defaulting to the origin / no rotation.
    const pos = e.get(Position);
    const rot = e.get(Rotation);
    const q = makeRot(rot?.angle ?? 0);
    writeBodyTransform(sim, pos?.x ?? 0, pos?.y ?? 0, q.c, q.s);

    // Integration inputs that the engine reads straight off the sim.
    const damping = e.get(Damping);
    if (damping) {
      sim.linearDamping = damping.linear;
      sim.angularDamping = damping.angular;
    }
    const gravityScale = e.get(GravityScale);
    if (gravityScale) {
      sim.gravityScale = gravityScale.value;
    }

    // Velocity lives in the body state, which exists only in the awake set.
    if (setIndex === AWAKE_SET) {
      const bodyState = set.bodyStates[record.localIndex]!;
      const linear = e.get(LinearVelocity);
      if (linear) {
        bodyState.vx = linear.x;
        bodyState.vy = linear.y;
      }
      const angular = e.get(AngularVelocity);
      if (angular) {
        bodyState.omega = angular.value;
      }
    }

    state.bodyByEntity.set(e.eid, handle);
  });

  system.exit((e) => {
    const handle = state.bodyByEntity.get(e.eid);
    if (handle === undefined) {
      return;
    }
    const record = state.bodies.get(handle.index);
    // Destroy all contacts on this body before removing it from its island and
    // freeing the body slot. Mirrors b2DestroyBody → b2DestroyBodyContacts
    // (body.c). The island must be a singleton (no contacts) before
    // removeBodyFromIsland runs; without this teardown it throws.
    destroyBodyContacts(state, handle.index, false);
    destroyBody(state, state.solverSets[record.setIndex]!, handle);
    state.bodyByEntity.delete(e.eid);
  });

  system.update(Body, (e, body) => {
    const handle = state.bodyByEntity.get(e.eid);
    if (handle === undefined) {
      return;
    }
    const record = state.bodies.get(handle.index);

    const wasDisabled = record.setIndex === DISABLED_SET;
    const wasStatic = record.type === STATIC_BODY;
    const targetSetIndex = chooseSetIndex(body);
    const willBeDisabled = targetSetIndex === DISABLED_SET;
    const willBeStatic = targetSetIndex === STATIC_SET;
    const newType = bodyTypeToNumber(body.type);
    const typeChanged = newType !== record.type;

    // No-op if neither type nor enabled changed.
    if (!typeChanged && targetSetIndex === record.setIndex) {
      return;
    }

    // ── Stage 1: Destroy all contacts (before any set transfer) ───────────────
    // Mirrors b2Body_SetType stage 2 (contact teardown) and b2Body_Disable
    // stage 1 (destroy contacts before removing proxies and transferring).
    // Disabled bodies never have contacts (no proxies), so this is a no-op there.
    if (!wasDisabled) {
      destroyBodyContacts(state, handle.index, false);
    }

    // ── Stage 2: For disabled body changing type only: update flags + mass ────
    // Mirrors b2Body_SetType's early return for disabled bodies (body.c:1126-1145).
    // Island membership does NOT change for disabled bodies.
    if (wasDisabled && willBeDisabled && typeChanged) {
      record.type = newType;
      // Update DYNAMIC_FLAG on the sim (disabled bodies have no bodyState).
      const sim = state.solverSets[DISABLED_SET]!.bodySims[record.localIndex]!;
      if (newType === DYNAMIC_BODY) {
        sim.flags |= DYNAMIC_FLAG;
      } else {
        sim.flags &= ~DYNAMIC_FLAG;
      }
      record.massDirty = true;
      return;
    }

    // ── Stage 3: Proxy teardown on disable ────────────────────────────────────
    // Mirrors b2Body_Disable: remove proxies before transferring the body.
    if (!wasDisabled && willBeDisabled) {
      destroyBodyShapeProxies(state, record);
    }

    // ── Stage 4: Island teardown before leaving awake non-static ──────────────
    // Mirrors b2Body_Disable (body.c:1670-1671): remove from island before
    // transferring. Also mirrors b2Body_SetType (body.c:1216-1219): when going
    // static, remove from the island.
    if (!wasDisabled && (willBeDisabled || willBeStatic)) {
      removeBodyFromIsland(state, record);
    }

    // ── Stage 5: Update stored type ───────────────────────────────────────────
    record.type = newType;

    // ── Stage 6: Update DYNAMIC_FLAG on the sim ───────────────────────────────
    // Mirrors b2Body_SetType (body.c:1194-1201) / b2SyncBodyFlags (body.c:91-104).
    // Must happen before transferBody so the new bodyState gets the correct flags.
    const currentSim = state.solverSets[record.setIndex]!.bodySims[record.localIndex]!;
    if (newType === DYNAMIC_BODY) {
      currentSim.flags |= DYNAMIC_FLAG;
    } else {
      currentSim.flags &= ~DYNAMIC_FLAG;
    }

    // ── Stage 7: Transfer body between solver sets ────────────────────────────
    if (targetSetIndex !== record.setIndex) {
      transferBody(
        state.bodies,
        state.solverSets[targetSetIndex]!,
        state.solverSets[record.setIndex]!,
        record
      );
    }

    // ── Stage 8: Mass dirty on type change ────────────────────────────────────
    // Mirrors b2Body_SetType (body.c:1294-1295): type change affects mass.
    if (typeChanged) {
      record.massDirty = true;
    }

    // ── Stage 9: Proxy management on enable / type change ────────────────────
    if (wasDisabled && !willBeDisabled) {
      // Body just enabled: create proxies for all shapes in the new type tree.
      // forcePairCreation (b2Body_Enable, body.c:1704) is handled by the broad
      // phase emitting pairs for newly created proxies — contact creation happens
      // through the normal collide() pair-create callback.
      createBodyShapeProxies(state, record, newType);
    } else if (!wasDisabled && !willBeDisabled && typeChanged) {
      // Type changed while body stays enabled: move proxies to new type tree.
      destroyBodyShapeProxies(state, record);
      createBodyShapeProxies(state, record, newType);
    }

    // ── Stage 10: Island creation for newly enabled / non-static bodies ───────
    // Mirrors b2Body_Enable (body.c:1714-1716) and b2Body_SetType (body.c:1211-1214).
    if (!willBeDisabled && !willBeStatic) {
      // Entering the awake set from disabled or static.
      if (wasDisabled || wasStatic) {
        createIslandForBody(state, AWAKE_SET, record);
      }
    }

    // ── Stage 11: Sync the existing bodyState flags (if awake and no transfer) ─
    // transferBody creates a fresh bodyState seeded from sim.flags (Stage 6),
    // so the transferred case is already correct. For bodies that stay in the
    // awake set across the type change (e.g. dynamic↔kinematic), the bodyState
    // object is the SAME instance and its flags need updating in place. Mirrors
    // b2SyncBodyFlags (body.c:91-104): set bodySim->flags and bodyState->flags.
    if (record.setIndex === AWAKE_SET) {
      const existingState = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex];
      if (existingState !== undefined) {
        if (newType === DYNAMIC_BODY) {
          existingState.flags |= DYNAMIC_FLAG;
        } else {
          existingState.flags &= ~DYNAMIC_FLAG;
        }
      }
    }
  });

  return system;
}
