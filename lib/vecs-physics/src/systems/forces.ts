// `PhysicsForceGather` — persistent forces/torques flow into the engine each step.
//
// Phase: `physics-pre`, after `PhysicsPoseSyncIn` and before `PhysicsMassRecompute`.
//
// NON-REACTIVE: we re-scan every step because the contract is "Force/Torque applies
// to the body every physics step while the component is present" (mirrors
// `b2Body_ApplyForceToCenter` / `b2Body_ApplyTorque`). A reactive approach would
// miss the steady-state case where the same force persists frame after frame.
//
// Immediate-parent rule (same as PhysicsShapeLifecycle):
//   - If the entity itself has Body → it IS the body.
//   - Else if its immediate ChildOf parent has Body → the parent is the body.
//   - Grandparents are never consulted (`e.parent(ChildOf)` is a single hop).
//
// Forces are summed into `BodySim.forceX/forceY` and `torque`. Multiple Force
// components on different entities that resolve to the same body accumulate
// naturally. `finalizeBodies` (engine/step.ts) already zeroes force/torque each
// step, so re-accumulation is correct — we do NOT zero them here.
//
// Wake flag: `b2Body_ApplyForceToCenter` (body.c:961) and `b2Body_ApplyTorque`
// (body.c:983) both check `wake && body->setIndex >= b2_firstSleepingSet` and
// call `b2WakeBody`. Sleep is not yet ported (M5), so the `wake` field is
// carried structurally but is a no-op until sleep lands. Comment left at the
// accumulation site.
//
// Box2D reference lines mirrored:
//   b2Body_ApplyForceToCenter (body.c:946-966):
//     bodySim->force = b2Add(bodySim->force, force);   // body.c:964
//   b2Body_ApplyTorque (body.c:968-988):
//     bodySim->torque += torque;                       // body.c:986

import { ChildOf, type IPhase, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { Force, Torque } from "../components/force.js";
import { AWAKE_SET } from "../engine/solver_set.js";
import { type PhysicsState } from "../engine/state.js";

/** Create `PhysicsForceGather` on `world`, bound to `state` and `phase`.
 * Returns the system so the caller can tag its entity. */
export function installForceGather(world: World, state: PhysicsState, phase: IPhase): System {
  // Non-reactive filter: walked from scratch every step. The DSL `{ any: [Force, Torque] }`
  // matches entities that carry at least one of the two force components.
  const forceFilter = world.filter({ any: [Force, Torque] });

  return world
    .system("PhysicsForceGather")
    .phase(phase)
    .run(() => {
      forceFilter.forEach((e) => {
        // ── Resolve the target body (immediate-parent rule) ────────────────────
        // The entity itself is the body target if it carries Body; otherwise its
        // immediate ChildOf parent (if that parent has Body). Grandparents are
        // never consulted. This mirrors the single-hop contract used by
        // PhysicsShapeLifecycle.enter (shape_lifecycle.ts:420).
        let bodyEid: number;
        if (e.get(Body) !== undefined) {
          bodyEid = e.eid;
        } else {
          const parent = e.parent(ChildOf);
          if (parent === undefined) {
            return;
          }
          if (parent.get(Body) === undefined) {
            return;
          }
          bodyEid = parent.eid;
        }

        const handle = state.bodyByEntity.get(bodyEid);
        if (handle === undefined) {
          return;
        }
        const record = state.bodies.get(handle.index);
        // Only accumulate into bodies in the awake set (mirrors box2d's check:
        // "if (body->setIndex == b2_awakeSet)" — body.c:961, body.c:983).
        if (record.setIndex !== AWAKE_SET) {
          return;
        }
        const sim = state.solverSets[record.setIndex]!.bodySims[record.localIndex]!;

        // ── Accumulate force (b2Body_ApplyForceToCenter, body.c:964) ──────────
        const force = e.get(Force) as Force | undefined;
        if (force !== undefined) {
          // Wake flag: a no-op until sleep lands (M5). See PROGRESS.md M4 note.
          sim.forceX += force.x; // mirrors: bodySim->force = b2Add(bodySim->force, force) [body.c:964]
          sim.forceY += force.y;
        }

        // ── Accumulate torque (b2Body_ApplyTorque, body.c:986) ────────────────
        const torque = e.get(Torque) as Torque | undefined;
        if (torque !== undefined) {
          // Wake flag: a no-op until sleep lands (M5).
          sim.torque += torque.value; // mirrors: bodySim->torque += torque [body.c:986]
        }
      });
    });
}
