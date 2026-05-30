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
import { Damping, GravityScale, MotionLocks, Sleep } from "../components/body_tuning.js";
import { destroyBodyContacts } from "../engine/contact.js";
import { makeRot } from "../math/rot.js";
import {
  ALLOW_FAST_ROTATION,
  DYNAMIC_BODY,
  DYNAMIC_FLAG,
  ENABLE_SLEEP,
  KINEMATIC_BODY,
  LOCK_ANGULAR_Z,
  LOCK_LINEAR_X,
  LOCK_LINEAR_Y,
  STATIC_BODY,
  writeBodyTransform,
} from "../engine/body.js";
import { createIslandForBody, removeBodyFromIsland } from "../engine/island.js";
import { wakeBody } from "../engine/sleep.js";
import { updateShapeAABBs } from "../engine/shape.js";
import {
  AWAKE_SET,
  DISABLED_SET,
  FIRST_SLEEPING_SET,
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
      currentIndex,
      true // force pair creation (Box2D b2Body_Enable/SetType, shape.c:1307)
    );
  }
}

// ─── Motion-lock / fast-rotation helpers ─────────────────────────────────────

/** Compute the motion-lock flag bits from an entity's `MotionLocks` component.
 * Returns 0 when `MotionLocks` is absent or all axes are unlocked. */
function _motionLockBits(e: { get: (c: any) => any }): number {
  const locks = e.get(MotionLocks) as MotionLocks | undefined;
  if (!locks) {
    return 0;
  }
  let bits = 0;
  if (locks.x) {
    bits |= LOCK_LINEAR_X;
  }
  if (locks.y) {
    bits |= LOCK_LINEAR_Y;
  }
  if (locks.rotation) {
    bits |= LOCK_ANGULAR_Z;
  }
  return bits;
}

/** Sync motion-lock and fast-rotation flag bits to a body's sim and (when in the
 * awake set) its body state. Clears the old bits then applies the new ones so
 * unlocking an axis works correctly. */
function _syncMotionFlags(
  state: PhysicsState,
  bodyHandleIndex: number,
  lockBits: number,
  fastRotFlag: number
): void {
  const record = state.bodies.get(bodyHandleIndex);
  const sim = state.solverSets[record.setIndex]!.bodySims[record.localIndex]!;
  const lockMask = LOCK_LINEAR_X | LOCK_LINEAR_Y | LOCK_ANGULAR_Z | ALLOW_FAST_ROTATION;
  sim.flags = (sim.flags & ~lockMask) | lockBits | fastRotFlag;
  if (record.setIndex === AWAKE_SET) {
    const st = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex];
    if (st !== undefined) {
      st.flags = (st.flags & ~lockMask) | lockBits | fastRotFlag;
    }
  }
}

/** Create `PhysicsBodyLifecycle` on `world`, bound to `state` and `phase`.
 * Returns the system so the caller can tag its entity. */
export function installBodyLifecycle(world: World, state: PhysicsState, phase: IPhase): System {
  const system = world.system("PhysicsBodyLifecycle").requires(Body).phase(phase);

  system.enter((e) => {
    const body = e.get(Body)!;
    const type = bodyTypeToNumber(body.type);
    const sleepComp = e.get(Sleep) as Sleep | undefined;

    // Determine whether this body starts asleep. A body starts asleep when:
    //   - sleep is enabled for this world (state.enableSleep)
    //   - the body is dynamic or kinematic (non-static)
    //   - Sleep.awake === false (user explicitly requested start-asleep)
    //   - Sleep.enabled !== false (per-body sleep is not disabled)
    const setIndex = chooseSetIndex(body);
    const set = state.solverSets[setIndex]!;

    const handle = createBody(state, set, e, type);
    const record = state.bodies.get(handle.index);
    const sim = set.bodySims[record.localIndex]!;

    // ── Sleep fields (VP-23) ───────────────────────────────────────────────
    // Set ENABLE_SLEEP flag from Sleep.enabled (default true when Sleep absent).
    // Mirrors b2Body_EnableSleep (body.c): sets/clears b2_enableSleep flag.
    const sleepEnabled = sleepComp?.enabled !== false; // absent = true
    if (sleepEnabled) {
      record.flags |= ENABLE_SLEEP;
    }
    // Set sleep threshold from Sleep.threshold (default 0.05, already set in createBody).
    if (sleepComp?.threshold !== undefined) {
      record.sleepThreshold = sleepComp.threshold;
    }
    // If Sleep.awake === false, set sleepTime above B2_TIME_TO_SLEEP so the body
    // is immediately eligible for sleeping on the first step. Box2D's
    // `b2Body_SetAwake(false)` calls `b2TrySleepIsland` directly; we cannot do that
    // here because the island may not be fully set up yet (no contacts, no
    // constraintRemoveCount issue). Setting a high sleepTime causes finalizeBodies
    // to elect this island for sleep on the very first step. This avoids the
    // Vecs `update(Body)` race condition where the enter-replay fires and transfers
    // the body back to AWAKE_SET if it was placed in a sleeping set at creation.
    const wantsSleepAtStart =
      state.enableSleep &&
      body.type !== BodyType.Static &&
      body.enabled &&
      sleepComp !== undefined &&
      sleepComp.awake === false &&
      sleepEnabled;
    if (wantsSleepAtStart) {
      // B2_TIME_TO_SLEEP is 0.5; set 1.0 to ensure the body qualifies.
      record.sleepTime = 1.0;
    }

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

    // Motion locks and fast-rotation flag — set on both sim.flags and
    // bodyState.flags so transferBody's seeding from sim.flags propagates
    // them correctly if the body later moves between sets. Mirrors the
    // b2SyncBodyFlags approach (body.c:91-104). Must be set after createBody
    // returns (the bodyState has already been allocated from sim.flags at
    // that point), so we patch both objects directly.
    const lockBits = _motionLockBits(e);
    const fastRot = body.allowFastRotation ? ALLOW_FAST_ROTATION : 0;
    const extraFlags = lockBits | fastRot;
    if (extraFlags !== 0) {
      sim.flags |= extraFlags;
      if (setIndex === AWAKE_SET) {
        set.bodyStates[record.localIndex]!.flags |= extraFlags;
      }
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

    // If only allowFastRotation changed (type and enabled unchanged), just update
    // that flag bit and return early — no solver-set transfer needed.
    if (!typeChanged && targetSetIndex === record.setIndex) {
      const fastRotFlag = body.allowFastRotation ? ALLOW_FAST_ROTATION : 0;
      const simOnly = state.solverSets[record.setIndex]!.bodySims[record.localIndex]!;
      if (fastRotFlag) {
        simOnly.flags |= ALLOW_FAST_ROTATION;
      } else {
        simOnly.flags &= ~ALLOW_FAST_ROTATION;
      }
      if (record.setIndex === AWAKE_SET) {
        const stateOnly = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex];
        if (stateOnly !== undefined) {
          if (fastRotFlag) {
            stateOnly.flags |= ALLOW_FAST_ROTATION;
          } else {
            stateOnly.flags &= ~ALLOW_FAST_ROTATION;
          }
        }
      }
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

    // ── Stage 12: allowFastRotation flag on Body update ───────────────────────
    // Body.allowFastRotation may change without a type/enabled change. Update
    // ALLOW_FAST_ROTATION on both sim and state, preserving the lock bits.
    const fastRotFlag = body.allowFastRotation ? ALLOW_FAST_ROTATION : 0;
    const currentSimAfter = state.solverSets[record.setIndex]!.bodySims[record.localIndex]!;
    if (fastRotFlag) {
      currentSimAfter.flags |= ALLOW_FAST_ROTATION;
    } else {
      currentSimAfter.flags &= ~ALLOW_FAST_ROTATION;
    }
    if (record.setIndex === AWAKE_SET) {
      const stateAfter = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex];
      if (stateAfter !== undefined) {
        if (fastRotFlag) {
          stateAfter.flags |= ALLOW_FAST_ROTATION;
        } else {
          stateAfter.flags &= ~ALLOW_FAST_ROTATION;
        }
      }
    }
  });

  // ── MotionLocks update ─────────────────────────────────────────────────────

  // Fires when MotionLocks changes on any entity that matches requires(Body).
  // Updates LOCK_LINEAR_X/Y and LOCK_ANGULAR_Z on both sim.flags and bodyState.flags.
  system.update(MotionLocks, (e, locks) => {
    const handle = state.bodyByEntity.get(e.eid);
    if (handle === undefined) {
      return;
    }
    const lockBits =
      (locks.x ? LOCK_LINEAR_X : 0) |
      (locks.y ? LOCK_LINEAR_Y : 0) |
      (locks.rotation ? LOCK_ANGULAR_Z : 0);
    // Preserve the ALLOW_FAST_ROTATION bit and DYNAMIC_FLAG; only update lock bits.
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[record.setIndex]!.bodySims[record.localIndex]!;
    const lockMask = LOCK_LINEAR_X | LOCK_LINEAR_Y | LOCK_ANGULAR_Z;
    sim.flags = (sim.flags & ~lockMask) | lockBits;
    if (record.setIndex === AWAKE_SET) {
      const st = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex];
      if (st !== undefined) {
        st.flags = (st.flags & ~lockMask) | lockBits;
      }
    }
  });

  // ── Sleep update (VP-23) ───────────────────────────────────────────────────
  //
  // Fires when Sleep is toggled on a body entity:
  //   - Sleep.enabled toggle → set/clear ENABLE_SLEEP on InternalBody.flags.
  //     Also: `b2Body_EnableSleep(false)` wakes a sleeping body (box2d body.c).
  //   - Sleep.awake = true → wake the body if sleeping.
  //   - Sleep.threshold change → update record.sleepThreshold.
  system.update(Sleep, (e, sleep) => {
    const handle = state.bodyByEntity.get(e.eid);
    if (handle === undefined) {
      return;
    }
    const record = state.bodies.get(handle.index);

    // Update ENABLE_SLEEP flag.
    if (sleep.enabled) {
      record.flags |= ENABLE_SLEEP;
    } else {
      record.flags &= ~ENABLE_SLEEP;
      // b2Body_EnableSleep (body.c): disabling sleep wakes a sleeping body.
      if (record.setIndex >= FIRST_SLEEPING_SET) {
        wakeBody(state, handle.index);
      }
    }

    // Update sleep threshold.
    record.sleepThreshold = sleep.threshold;

    // Wake the body on Sleep.awake = true.
    if (sleep.awake && record.setIndex >= FIRST_SLEEPING_SET) {
      wakeBody(state, handle.index);
    }
  });

  return system;
}
