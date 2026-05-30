// `PhysicsKinematicTargets` — drive kinematic bodies toward target pose each step.
//
// Phase: `physics-pre`, after `PhysicsPoseSyncIn` and before `PhysicsForceGather`.
//
// NON-REACTIVE: we re-scan every step because the contract is "converge toward the
// target every physics step while the component is present" — a reactive approach
// would miss the steady-state where the target has not changed but the body is
// still in transit. Matches `PhysicsForceGather` and box2d's
// `b2Body_SetTargetTransform` (body.c:831), which is also called each step.
//
// Target lives on the body entity (confirmed in docs/kinematic-motion.md).
// A filter scan of `{ any: [KinematicTargetPosition, KinematicTargetRotation] }`
// finds all kinematic (and any misplaced non-kinematic) target entities; we skip
// any that are not KINEMATIC_BODY in the AWAKE_SET.
//
// Per-body velocity calculation (mirrors b2Body_SetTargetTransform, body.c:831):
//
//   Linear (DEVIATION from box2d — see below):
//     box2d: center2 = transformPoint(target, localCenter); v = (center2 − center1) / dt
//     vecs-physics: dx = target.x − sim.transformX; v = dx / dt
//
//   DEVIATION: box2d uses the centre of mass for the velocity calculation (body.c:856-863),
//   so moving the CoM to the target's implied CoM. vecs-physics uses the body ORIGIN
//   (transformX/transformY), because `KinematicTargetPosition.x/y` is the target ORIGIN
//   and `Position` = body origin. This is consistent with the public contract
//   (docs/kinematic-motion.md), which says "target world x position in metres" — the
//   same space as `Position`. Bodies with a zero local centre (no shapes, or shapes whose
//   CoM coincides with the origin) are unaffected by the difference.
//
//   Angular (identical to box2d):
//     deltaAngle = relativeAngle(currentRot, targetRot) [b2RelativeAngle, body.c:866]
//     omega = deltaAngle / dt
//
// Tolerance:
//   Linear: if hypot(dx, dy) <= tolerance → vx = vy = 0 (stop; leave component attached).
//   Angular: if |dAngle| <= tolerance → omega = 0.
//
// Speed clamp:
//   Linear: clamp the speed to `state.maximumLinearSpeed` (mirrors the per-step
//   integration clamp in b2IntegratePositionsTask, solver.c:130-135).
//
// Wake flag: structural no-op until sleep (M5). See forces.ts note.
//
// Box2D reference lines mirrored:
//   b2Body_SetTargetTransform (body.c:831-887)
//     body.c:856: center2 = b2TransformPoint(target, sim->localCenter)
//     body.c:857: linearVelocity = b2MulSV(invTimeStep, b2Sub(center2, center1)) [ORIGIN DEVIATION]
//     body.c:863: deltaAngle = b2RelativeAngle(q1, q2)      — body.c:863
//     body.c:864: angularVelocity = invTimeStep * deltaAngle — body.c:864
//     body.c:885: state->linearVelocity = linearVelocity     — body.c:885
//     body.c:886: state->angularVelocity = angularVelocity   — body.c:886

import { type IPhase, type System, type World } from "@vworlds/vecs";

import { KinematicTargetPosition, KinematicTargetRotation } from "../components/target.js";
import { KINEMATIC_BODY } from "../engine/body.js";
import { AWAKE_SET } from "../engine/solver_set.js";
import { type PhysicsState } from "../engine/state.js";
import { makeRot, relativeAngle } from "../math/rot.js";

/** Create `PhysicsKinematicTargets` on `world`, bound to `state` and `phase`.
 * Returns the system so the caller can tag its entity. */
export function installKinematicTargets(world: World, state: PhysicsState, phase: IPhase): System {
  // Non-reactive filter: walked from scratch every step. Matches any entity
  // carrying at least one of the two target components.
  const targetFilter = world.filter({ any: [KinematicTargetPosition, KinematicTargetRotation] });

  return world
    .system("PhysicsKinematicTargets")
    .phase(phase)
    .run(() => {
      const dt = state.fixedTimeStep;
      if (dt <= 0) {
        return;
      }
      const invDt = 1 / dt;

      targetFilter.forEach((e) => {
        // ── Resolve the body record ──────────────────────────────────────────
        const handle = state.bodyByEntity.get(e.eid);
        if (handle === undefined) {
          return;
        }
        const record = state.bodies.get(handle.index);

        // Only act on kinematic bodies in the awake set.
        if (record.type !== KINEMATIC_BODY || record.setIndex !== AWAKE_SET) {
          return; // static/dynamic ignored; disabled/sleeping ignored (M5)
        }

        const sim = state.solverSets[AWAKE_SET]!.bodySims[record.localIndex]!;
        const bState = state.solverSets[AWAKE_SET]!.bodyStates[record.localIndex]!;

        // ── Linear convergence ───────────────────────────────────────────────
        const tpos = e.get(KinematicTargetPosition) as KinematicTargetPosition | undefined;
        if (tpos !== undefined) {
          // Read the authoritative current body-origin position from BodySim
          // (not from the Position component, which may lag behind by one step).
          const dx = tpos.x - sim.transformX; // b2Sub(center2, center1) [ORIGIN DEVIATION — see header]
          const dy = tpos.y - sim.transformY;
          const dist = Math.hypot(dx, dy);
          if (dist > tpos.tolerance) {
            let vx = dx * invDt; // mirrors: linearVelocity = b2MulSV(invTimeStep, b2Sub(…)) [body.c:857]
            let vy = dy * invDt;
            // Clamp to maximum linear speed (mirrors b2IntegratePositionsTask
            // speed cap, solver.c:130-135; applied here so the target never
            // causes runaway velocity on a coarse time step).
            const speed = Math.hypot(vx, vy);
            const maxSpeed = state.maximumLinearSpeed;
            if (speed > maxSpeed) {
              const ratio = maxSpeed / speed;
              vx *= ratio;
              vy *= ratio;
            }
            bState.vx = vx; // mirrors: state->linearVelocity = linearVelocity [body.c:885]
            bState.vy = vy;
            // Wake flag: a no-op until sleep lands (M5).
          } else {
            // Within tolerance — stop linear motion but keep the component.
            bState.vx = 0;
            bState.vy = 0;
          }
        }

        // ── Angular convergence ──────────────────────────────────────────────
        const trot = e.get(KinematicTargetRotation) as KinematicTargetRotation | undefined;
        if (trot !== undefined) {
          // Current rotation from the authoritative BodySim (cos/sin pair).
          const currentRot = { c: sim.cos, s: sim.sin };
          const targetRot = makeRot(trot.angle);
          // Shortest arc in [-π, π] — mirrors b2RelativeAngle(q1, q2) [body.c:863].
          const dAngle = relativeAngle(currentRot, targetRot);
          if (Math.abs(dAngle) > trot.tolerance) {
            bState.omega = dAngle * invDt; // mirrors: state->angularVelocity = invTimeStep * deltaAngle [body.c:864,886]
            // Wake flag: a no-op until sleep lands (M5).
          } else {
            bState.omega = 0;
          }
        }
      });
    });
}
