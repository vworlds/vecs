// `engineStep` — the per-step orchestrator (VP-18, VP-23 sleep, VP-24 CCD).
//
// Wires the full collision step loop: build the step context, create contacts
// from broad-phase pairs, run the narrow phase + contact state changes (collide),
// run the TGS soft-step solver (solve), gather hit events, finalize bodies
// (fold delta-pose, write transforms, move events, sleep accumulation, CCD
// fast/bullet detection, refit shape AABBs / proxies), run the island-split
// candidate (VP-23), run the sleep loop (VP-23), run the bullet CCD stage
// (VP-24), then run the sensor overlap pass. Mirrors box2d's `b2World_Step` →
// `b2Collide` → `b2Solve` → `b2FinalizeBodiesTask` + the sleep block in
// `b2Solve` (solver.c:2003-2059) + the bullet stage (physics_world.c:1896-1968),
// all serialised.
//
// VP-23 additions:
//   - `finalizeBodies` now runs the sleep accumulation block from
//     `b2FinalizeBodiesTask` (solver.c:556-684): compute sleepVelocity, bump
//     body.sleepTime when sleepy, mark awakeIslandBitSet for awake islands, and
//     pick the sleepiest island with `constraintRemoveCount > 0` as the split
//     candidate.
//   - After finalizeBodies, `engineStep` splits the pending island (if any) via
//     `splitIsland`, then reverse-iterates `awakeSet.islandSims` and calls
//     `trySleepIsland` on each island whose bit is NOT set in `awakeIslandBitSet`.
//     This mirrors the sleep loop in `b2Solve` (solver.c:2039-2053).
//   - `applyPendingImpulses` now calls `wakeBody` when `acc.wake === true` and
//     the target body is in a sleeping set (mirrors body.c:1009-1012).
//   - Sleep hooks are installed on the first step (wires `wakeSolverSet` /
//     `mergeSolverSets` into `state` without a circular import).
//
// VP-24 additions:
//   - `finalizeBodies` now runs the CCD fast/bullet detection block from
//     `b2FinalizeBodiesTask` (solver.c:633-657): if body is not sleepy and
//     `maxMotion > 0.5 * sim.minExtent`, marks `IS_FAST` and either calls
//     `solveContinuous` inline (non-bullet) or pushes onto `state.bulletBodies`
//     (bullet bodies).
//   - After the sleep loop, `engineStep` walks `state.bulletBodies`, calls
//     `solveContinuous` for each, then calls `enlargeBulletProxies` to grow
//     the broad-phase proxies. Mirrors physics_world.c:1896-1968.
//   - The finalize shape-AABB refit block (solver.c:686-732) now honours the
//     `IS_FAST` flag: fast bodies skip the normal refit (solveContinuous already
//     updated their AABBs) and instead mark the sim directly for broad-phase
//     enlargement. Non-fast bodies go through the normal `refitBodyShapeProxies`
//     path (unchanged from VP-23).

import {
  BODY_TRANSIENT_FLAGS,
  DYNAMIC_BODY,
  ENABLE_SLEEP,
  ENLARGE_BOUNDS,
  HAD_TIME_OF_IMPACT,
  IS_BULLET,
  IS_FAST,
  IS_SPEED_CAPPED,
} from "./body.js";
import { enlargeBulletProxies, solveContinuous } from "./ccd.js";
import { collide, makePairCreateCallback } from "./collide.js";
import { splitIsland } from "./island.js";
import { overlapSensors } from "./sensor.js";
import { refitBodyShapeProxies } from "./shape.js";
import { installSleepHooks, trySleepIsland, wakeBody } from "./sleep.js";
import { gatherHitEvents, makeStepContext, solve, type StepContext } from "./solver.js";
import { AWAKE_SET, FIRST_SLEEPING_SET, type SolverSet } from "./solver_set.js";
import { NULL_INDEX, type BodyHandle } from "../util/handle.js";
import { type PhysicsState } from "./state.js";
import { mulRot, normalizeRot, rotateVector } from "../math/rot.js";

// Time-to-sleep threshold: a body must be idle for this many seconds before its
// island is considered sleepy. Mirrors `B2_TIME_TO_SLEEP = 0.5f` (constants.h:68).
const B2_TIME_TO_SLEEP = 0.5;

/** Advance the simulation by one fixed step. Builds the step context, creates
 * contacts from new broad-phase pairs, runs the narrow phase + solver, then
 * finalizes the awake bodies (write-back + AABB refit + sleep accumulation),
 * optionally splits a pending island, puts sleepy islands to sleep, and finally
 * runs the sensor overlap pass. */
export function engineStep(state: PhysicsState, dt: number, subSteps: number): void {
  state.stepIndex += 1;
  // `bodyMoveEvents` is cleared here: it is step-only, consumed by
  // PhysicsPoseSyncOut (physics-post), and must be fresh each step.
  // The five ECS-bound event arrays (contactBeginEvents/contactEndEvents,
  // sensorBeginEvents/sensorEndEvents, contactHitEvents) are cleared at the
  // END of PhysicsEvents (physics-post), AFTER publishing, so that events
  // generated in physics-pre (lifecycle teardown, entity.destroy()) survive
  // until the publish. This is the ARCHITECT RESOLUTION from VP-21a
  // (PROGRESS.md MILESTONE 4 VP-21a ARCHITECT RESOLUTION bullet).
  state.bodyMoveEvents.length = 0;
  // Bullet body collection: cleared each step. Rebuilt by finalizeBodies (VP-24).
  state.bulletBodies.length = 0;
  // fell-asleep tracking: cleared each step so pose-sync-out can skip sleeping bodies.
  state.fellAsleepThisStep.clear();
  // reset split-island bookkeeping for this step.
  state.splitIslandId = NULL_INDEX;
  state.splitSleepTime = 0;

  // Install sleep hooks on the first step (wires wakeSolverSet / mergeSolverSets
  // into state callbacks so island.ts's linkContact can call them without a
  // circular import). Safe to call every step — it just overwrites the same fns.
  installSleepHooks(state);

  if (dt <= 0) {
    return;
  }

  // ── Apply pending impulses BEFORE collide/solve (VP-19) ───────────────────
  // `PhysicsImpulseAccumulate` (physics-pre) sums Impulse/AngularImpulse sets
  // into `state.pendingImpulses`. We apply them here — after `PhysicsMassRecompute`
  // (last pre-step system, so invMass is fresh) and before `collide`/`solve`
  // (so the velocity delta is visible to the solver this step).
  //
  // This mirrors the immediate velocity update in `b2Body_ApplyLinearImpulseToCenter`
  // (body.c:1048): state->linearVelocity = b2MulAdd(state->linearVelocity, invMass, impulse)
  // and `b2Body_ApplyAngularImpulse` (body.c:1077):
  //   state->angularVelocity += invInertia * impulse
  //
  // Only awake bodies have BodyState entries; static/disabled bodies have
  // invMass = 0, so skipping them is both correct and cheap (they are not in
  // the awake set and have no BodyState slot).
  applyPendingImpulses(state);

  const ctx = makeStepContext(state, dt, subSteps);

  // Create contacts for new broad-phase pairs (filtered in the callback).
  state.broadPhase.updatePairs(makePairCreateCallback(state));

  // Narrow phase + contact state changes (link/unlink + graph moves).
  collide(state, ctx);

  // The eight-stage TGS soft-step solver over the awake set + overflow color.
  // Early-returns on an empty awake set.
  solve(state, ctx);

  // Scan touching contacts for high-speed impacts (VP-22). Runs after solve()
  // so storeImpulses has populated normalVelocity + totalNormalImpulse on each
  // manifold point. Mirrors box2d: hit events are emitted from within b2Solve
  // after b2StoreImpulses_Overflow (solver.c:1725-1794). We place it here
  // (between solve and finalizeBodies) because the manifolds are stable and the
  // body transforms have not yet been advanced — the same window box2d uses.
  gatherHitEvents(state);

  // Fold delta-pose, write transforms, push move events, sleep accumulation,
  // refit proxies. Sleep accumulation populates state.splitIslandId and the
  // awakeIslandBitSet used by the sleep loop below.
  const awakeIslandBitSet = finalizeBodies(state, ctx, dt);

  // ── Island split (VP-23, b2SplitIslandTask, island.c:659) ────────────────
  // If a sleepy island needs splitting, do it now (after finalize, before sleep).
  // Mirrors solver.c:2003 comment: "This must be done last because putting
  // islands to sleep invalidates the enlarged body bits."
  if (state.splitIslandId !== NULL_INDEX) {
    splitIsland(state, state.splitIslandId);
    state.splitIslandId = NULL_INDEX;
  }

  // ── VP-24: Bullet CCD stage (solver.c:1896-1968) ─────────────────────────
  // Run solveContinuous for each bullet body collected in finalizeBodies.
  // MUST run BEFORE the sleep loop to match box2d ordering (solver.c:1896 then
  // :2003). The sleep loop's trySleepIsland swap-pops awake-set bodySims, which
  // invalidates the awake-set local indices stored in state.bulletBodies. A
  // bullet body's own island is always marked awake by the awakeIslandBitSet
  // (its sleepTime resets to 0 in the !sleepy branch above), so running bullets
  // first does not let a fast/bullet body sleep — it just keeps the indices
  // valid. (Previously the order was sleep→bullet, with a justification that
  // turned out to be wrong; reproduced by the VP-30 fuzz harness on seeds 2/3/
  // 13/3735928559 with enableSleep:true → undefined sim → throw in makeSweep.)
  if (state.bulletBodies.length > 0) {
    for (const simIndex of state.bulletBodies) {
      solveContinuous(state, simIndex);
    }
    // Enlarge broad-phase proxies for bullet shapes that moved (solver.c:1907-1958).
    enlargeBulletProxies(state, state.bulletBodies);
  }

  // ── Island sleep loop (VP-23, solver.c:2003-2059) ────────────────────────
  // Reverse-iterate the awake set's islandSims; put any island whose bit is NOT
  // set in the awakeIslandBitSet to sleep. Gated on `state.enableSleep`.
  // (solver.c:2006: `if ( world->enableSleep == true )`)
  if (state.enableSleep) {
    const awakeSet = state.solverSets[AWAKE_SET]!;
    // Reverse iteration so swap-removes during trySleepIsland don't skip entries.
    for (let islandIndex = awakeSet.islandSims.length - 1; islandIndex >= 0; islandIndex--) {
      if (awakeIslandBitSet.has(islandIndex)) {
        // This island is still awake — skip.
        continue;
      }
      const islandSim = awakeSet.islandSims[islandIndex];
      if (islandSim === undefined) {
        continue;
      }
      trySleepIsland(state, islandSim.islandId);
    }
  }

  // Sensor overlap pass. Runs AFTER finalizeBodies so shape AABBs are fresh
  // for the current step. Mirrors box2d's b2OverlapSensors call in
  // b2World_Step (physics_world.c), which runs after b2FinalizeBodiesTask.
  // CCD sensor hits queue is a no-op stub (VP-24 deferral — see engine/ccd.ts).
  overlapSensors(state);
}

/** Apply accumulated impulses from `state.pendingImpulses` to awake body
 * velocities, then clear the accumulator. This runs at the TOP of each
 * `engineStep` call — after `PhysicsMassRecompute` has updated invMass — so
 * impulse magnitudes are correct and the solver sees the updated velocity.
 *
 * Mirrors the velocity update in `b2Body_ApplyLinearImpulseToCenter` (body.c:1048):
 *   state->linearVelocity = b2MulAdd(state->linearVelocity, bodySim->invMass, impulse)
 * and `b2Body_ApplyAngularImpulse` (body.c:1077):
 *   state->angularVelocity += bodySim->invInertia * impulse
 *
 * Only dynamic bodies in the awake set have a BodyState; static/disabled bodies
 * are not in the awake set so they are naturally skipped (and their invMass is 0
 * anyway, matching box2d's `body->type != b2_dynamicBody` early-return). */
function applyPendingImpulses(state: PhysicsState): void {
  if (state.pendingImpulses.size === 0) {
    return;
  }

  const awake = state.solverSets[AWAKE_SET]!;

  for (const [bodyIndex, acc] of state.pendingImpulses) {
    // Reject a stale target: if the body was destroyed (and possibly its slot
    // reused) since the impulse was accumulated this frame, the generation no
    // longer matches and the impulse must not be redirected to whatever body
    // now occupies the slot. Mirrors box2d's handle-generation validation.
    if (
      !state.bodies.idPool.isValid({
        index: bodyIndex,
        generation: acc.generation,
      } as unknown as BodyHandle)
    ) {
      continue;
    }
    const record = state.bodies.records[bodyIndex];
    if (record === undefined) {
      continue;
    }

    // Wake sleeping body when wake === true (mirrors body.c:1009-1012 /
    // b2Body_ApplyLinearImpulseToCenter: `if (wake && body->setIndex >= b2_firstSleepingSet)`).
    if (acc.wake && record.setIndex >= FIRST_SLEEPING_SET) {
      wakeBody(state, bodyIndex);
      // Re-fetch record after wake (setIndex / localIndex changed).
    }

    // Skip if the body is not in the awake set.
    if (record.setIndex !== AWAKE_SET) {
      continue;
    }
    // Only dynamic bodies have invMass > 0 (kinematic invMass = 0, static = 0).
    // This mirrors box2d's `body->type != b2_dynamicBody || body->setIndex == b2_disabledSet`
    // guard — we rely on invMass/invInertia being 0 for non-dynamic bodies.
    if (record.type !== DYNAMIC_BODY) {
      continue;
    }

    const sim = awake.bodySims[record.localIndex]!;
    const st = awake.bodyStates[record.localIndex]!;

    // vx += invMass * impulse.x  (b2Body_ApplyLinearImpulseToCenter body.c:1048)
    // vy += invMass * impulse.y
    st.vx += sim.invMass * acc.x;
    st.vy += sim.invMass * acc.y;
    // omega += invInertia * angular  (b2Body_ApplyAngularImpulse body.c:1077)
    st.omega += sim.invInertia * acc.angular;
  }

  state.pendingImpulses.clear();
}

/** Fold the accumulated delta-pose into each body's centre/rotation, derive the
 * origin transform, reset the per-step deltas and applied force, record a move
 * event, run the sleep accumulation + CCD fast/bullet detection block, and
 * refit shape AABBs / proxies.
 *
 * Mirrors `b2FinalizeBodiesTask` (solver.c:544-736) including the sleep block
 * (solver.c:556-684) and the CCD isFast/bullet block (solver.c:633-657).
 * The shape-AABB refit (solver.c:686-732) honours the IS_FAST flag: fast bodies
 * already had their AABBs updated by `solveContinuous` (or will be by the bullet
 * stage) and are added directly to the enlarged-sim set; non-fast bodies go
 * through the normal `refitBodyShapeProxies` path.
 *
 * Returns a `Set<number>` of island local-indices in the awake set that are
 * "still awake" (at least one body's sleepTime < B2_TIME_TO_SLEEP). The sleep
 * loop in `engineStep` puts islands NOT in this set to sleep. Mirrors
 * `awakeIslandBitSet` (solver.c:567). */
function finalizeBodies(state: PhysicsState, _ctx: StepContext, dt: number): Set<number> {
  const awake: SolverSet = state.solverSets[AWAKE_SET]!;
  const sims = awake.bodySims;
  const states = awake.bodyStates;

  // Mirrors box2d's awakeIslandBitSet (solver.c:567): tracks which awake-set island
  // local-indices have at least one non-sleepy body. Using a Set<number> (sufficient
  // for single-threaded; mirrors the single-worker merge path in solver.c:2032-2036).
  // VP-26 perf: hoisted to PhysicsState._awakeIslandBitSet to avoid per-step
  // allocation; cleared here instead of allocating a fresh Set each call.
  const awakeIslandBitSet = state._awakeIslandBitSet;
  awakeIslandBitSet.clear();

  const invDt = dt > 0 ? 1 / dt : 0;
  const enableSleep = state.enableSleep;

  for (let i = 0; i < sims.length; i++) {
    const sim = sims[i]!;
    const st = states[i]!;

    // ── Integrate delta-pose into body transform (solver.c:588-590) ──────────
    sim.centerX += st.deltaPosX;
    sim.centerY += st.deltaPosY;
    const q = normalizeRot(
      mulRot({ c: st.deltaRotCos, s: st.deltaRotSin }, { c: sim.cos, s: sim.sin })
    );
    sim.cos = q.c;
    sim.sin = q.s;

    // ── Compute sleepVelocity (solver.c:592-599) ───────────────────────────
    // sleepVelocity = max( |v| + |omega| * maxExtent,
    //                      0.5 * invDt * (|deltaPos| + |deltaRot.s| * maxExtent) )
    const v = st.vx * st.vx + st.vy * st.vy;
    const speed = Math.sqrt(v);
    const maxVelocity = speed + Math.abs(st.omega) * sim.maxExtent;
    const deltaPos = Math.sqrt(st.deltaPosX * st.deltaPosX + st.deltaPosY * st.deltaPosY);
    const maxDeltaPosition = deltaPos + Math.abs(st.deltaRotSin) * sim.maxExtent;
    const positionSleepFactor = 0.5;
    const sleepVelocity = Math.max(maxVelocity, positionSleepFactor * invDt * maxDeltaPosition);

    // ── Reset solver delta-pose (solver.c:601-604) ────────────────────────
    st.deltaPosX = 0;
    st.deltaPosY = 0;
    st.deltaRotCos = 1;
    st.deltaRotSin = 0;

    // ── Origin transform (solver.c:606) ──────────────────────────────────
    const offset = rotateVector(q, { x: sim.localCenterX, y: sim.localCenterY });
    sim.transformX = sim.centerX - offset.x;
    sim.transformY = sim.centerY - offset.y;

    // ── Reset force and torque (solver.c:616-618) ─────────────────────────
    sim.forceX = 0;
    sim.forceY = 0;
    sim.torque = 0;

    // ── Clear transient body flags (solver.c:622-626) ─────────────────────
    // Mirrors box2d exactly:
    //   body->flags &= ~b2_bodyTransientFlags;
    //   body->flags |= ( sim->flags  & ( b2_isSpeedCapped | b2_hadTimeOfImpact ) );
    //   body->flags |= ( state->flags & ( b2_isSpeedCapped | b2_hadTimeOfImpact ) );
    //   sim->flags   &= ~b2_bodyTransientFlags;
    //   state->flags &= ~b2_bodyTransientFlags;
    // IS_FAST is intentionally NOT propagated to body.flags — box2d sets it on
    // sim->flags after this block (solver.c:638) purely for the refit branch and
    // does not carry it to body->flags here.
    const body = state.bodies.get(sim.bodyId);
    body.flags &= ~BODY_TRANSIENT_FLAGS;
    body.flags |= sim.flags & (IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT);
    body.flags |= st.flags & (IS_SPEED_CAPPED | HAD_TIME_OF_IMPACT);
    sim.flags &= ~BODY_TRANSIENT_FLAGS;
    st.flags &= ~BODY_TRANSIENT_FLAGS;

    // ── Sleep accumulation block + CCD detection (solver.c:628-684) ────────
    // Mirrors: `if (enableSleep == false || !(body->flags & b2_enableSleep) ||
    //              sleepVelocity > body->sleepThreshold)`
    if (!enableSleep || !(body.flags & ENABLE_SLEEP) || sleepVelocity > body.sleepThreshold) {
      // Body is NOT sleepy: reset its sleep timer (solver.c:631).
      body.sleepTime = 0;

      // ── CCD fast/bullet detection (solver.c:633-657) ───────────────────
      // maxMotion = max(maxDeltaPosition, |v| * dt) (solver.c:634)
      const safetyFactor = 0.5;
      const maxMotion = Math.max(maxDeltaPosition, maxVelocity * dt);
      if (
        body.type === DYNAMIC_BODY &&
        state.enableContinuous &&
        maxMotion > safetyFactor * sim.minExtent
      ) {
        // This flag is only retained for debug draw (solver.c:638).
        sim.flags |= IS_FAST;

        if (sim.flags & IS_BULLET) {
          // Collect for the post-solve bullet stage (solver.c:642-645).
          state.bulletBodies.push(i);
        } else {
          // Inline TOI vs the static tree (solver.c:649).
          solveContinuous(state, i);
          // Enlarge proxies for non-bullet fast bodies immediately. This
          // mirrors b2Solve's refit-BVH pass (which runs after finalize for
          // non-bullet fast bodies, solver.c:1801+). We do it inline here
          // because vecs-physics has no separate refit task.
          enlargeBulletProxies(state, [i]);
        }
      } else {
        // Body is safe to advance — advance sweep baseline (solver.c:654-657).
        sim.center0X = sim.centerX;
        sim.center0Y = sim.centerY;
        sim.rotation0Cos = q.c;
        sim.rotation0Sin = q.s;
      }
    } else {
      // Body IS sleepy: accumulate sleep time (solver.c:663-664).
      body.sleepTime += dt;

      // Body is safe to advance (no CCD when sleepy, solver.c:661-664).
      sim.center0X = sim.centerX;
      sim.center0Y = sim.centerY;
      sim.rotation0Cos = q.c;
      sim.rotation0Sin = q.s;
    }

    // ── awakeIslandBitSet marking (solver.c:667-684) ──────────────────────
    // Any body with sleepTime < B2_TIME_TO_SLEEP keeps its island awake.
    if (body.islandId !== NULL_INDEX) {
      const island = state.islands.get(body.islandId);
      if (body.sleepTime < B2_TIME_TO_SLEEP) {
        // Keep the island awake: mark its local-index in the awake set.
        // solver.c:672-674: b2SetBit(awakeIslandBitSet, island->localIndex)
        awakeIslandBitSet.add(island.localIndex);
      } else if (island.constraintRemoveCount > 0) {
        // Body wants to sleep but its island needs splitting first.
        // Pick the sleepiest candidate (solver.c:676-683).
        if (body.sleepTime > state.splitSleepTime) {
          state.splitIslandId = body.islandId;
          state.splitSleepTime = body.sleepTime;
        }
      }
    }

    // ── Record the move event (solver.c:609-613) ──────────────────────────
    body.bodyMoveIndex = state.bodyMoveEvents.length;
    state.bodyMoveEvents.push(sim.bodyId);

    // ── Refit shape AABBs and broad-phase proxies (solver.c:686-732) ──────
    // For fast bodies (isFast = sim.flags & b2_isFast), the AABBs and proxies
    // were already handled:
    //   - Non-bullet fast body: solveContinuous + enlargeBulletProxies ran above.
    //   - Bullet body: will run in the post-solve bullet stage in engineStep.
    // Fast bodies skip the normal refitBodyShapeProxies call. Mirrors
    // solver.c:694-701 ("For fast non-bullet bodies the AABB has already been
    // updated in b2SolveContinuous. For fast bullet bodies the AABB will be
    // updated at a later stage. Add to enlarged shapes regardless of AABB changes.")
    if (!(sim.flags & IS_FAST)) {
      // Normal (slow/sleeping) body: refit via the standard path (solver.c:703-728).
      refitBodyShapeProxies(state.shapes, state.broadPhase, body, sim, "enlarge");
    }
  }

  return awakeIslandBitSet;
}
