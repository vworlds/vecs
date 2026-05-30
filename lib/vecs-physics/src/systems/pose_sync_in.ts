// `PhysicsPoseSyncIn` — user pose/velocity writes flow into the engine.
//
// A user `entity.set(Position/Rotation/LinearVelocity/AngularVelocity, ...)` is
// always treated as a teleport (Box2D `b2Body_SetTransform` / `SetVelocity`
// semantics). The hard part is *not* mistaking the engine's own write-back
// (`PhysicsPoseSyncOut`) for a user teleport. That is solved at the source
// level: every physics system entity carries `PhysicsSystemTag`, and this system
// declares `ignoreSource([PhysicsSystemTag])`, so updates that originated from a
// physics system are dropped before they reach a callback. Anything this system
// *does* see is, by construction, an outside (user) write. See PLAN.md → _Pose
// And Velocity Synchronization_.

import { type IPhase, type System, type World } from "@vworlds/vecs";

import { AngularVelocity, Body, LinearVelocity, Position, Rotation } from "../components/body.js";
import { STATIC_BODY, writeBodyTransform } from "../engine/body.js";
import { refitBodyShapeProxies } from "../engine/shape.js";
import { AWAKE_SET } from "../engine/solver_set.js";
import { PhysicsSystemTag, type PhysicsState } from "../engine/state.js";
import { makeRot } from "../math/rot.js";
import { type BodyHandle } from "../util/handle.js";

// ─── Refit helper ─────────────────────────────────────────────────────────────
//
// The shape-AABB refit on a user teleport (box2d `b2Body_SetTransform`,
// body.c:727-756) is shared with the per-step finalize (VP-18 `finalizeBodies`)
// via `refitBodyShapeProxies` in `engine/shape.ts`, so the refit rule lives in
// one place. The teleport path uses the "move" proxy op (remove + reinsert);
// finalize uses "enlarge". This wrapper resolves the body's sim and calls it.
function refitForTeleport(state: PhysicsState, bodyHandle: BodyHandle): void {
  const bodyRec = state.bodies.get(bodyHandle.index);
  const sim = state.solverSets[bodyRec.setIndex]!.bodySims[bodyRec.localIndex]!;
  refitBodyShapeProxies(state.shapes, state.broadPhase, bodyRec, sim, "move");
}

/** Create `PhysicsPoseSyncIn` on `world`, bound to `state` and `phase`. Returns
 * the system so the caller can tag its entity. */
export function installPoseSyncIn(world: World, state: PhysicsState, phase: IPhase): System {
  const system = world.system("PhysicsPoseSyncIn").requires(Body).phase(phase);

  // Drop updates that originated from any physics system (the engine's own
  // write-back). Must be declared during setup, before `world.start()`.
  system.ignoreSource([PhysicsSystemTag]);

  system.update(Position, (e, pos) => {
    const handle = state.bodyByEntity.get(e.eid);
    if (handle === undefined) {
      return;
    }
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[record.setIndex]!.bodySims[record.localIndex]!;
    // Teleport the origin, keeping the current rotation.
    writeBodyTransform(sim, pos.x, pos.y, sim.cos, sim.sin);
    // Refit all child shape AABBs and broad-phase proxies for the new transform
    // (mirrors b2Body_SetTransform in box2d/src/body.c).
    refitForTeleport(state, handle);
  });

  system.update(Rotation, (e, rot) => {
    const handle = state.bodyByEntity.get(e.eid);
    if (handle === undefined) {
      return;
    }
    const record = state.bodies.get(handle.index);
    const sim = state.solverSets[record.setIndex]!.bodySims[record.localIndex]!;
    const q = makeRot(rot.angle);
    writeBodyTransform(sim, sim.transformX, sim.transformY, q.c, q.s);
    refitForTeleport(state, handle);
  });

  system.update(LinearVelocity, (e, linear) => {
    const bodyState = awakeBodyState(state, e.eid);
    if (bodyState === undefined) {
      return;
    }
    bodyState.vx = linear.x;
    bodyState.vy = linear.y;
    // Box2D wakes the body on a nonzero velocity write; sleep is not ported yet.
  });

  system.update(AngularVelocity, (e, angular) => {
    const bodyState = awakeBodyState(state, e.eid);
    if (bodyState === undefined) {
      return;
    }
    bodyState.omega = angular.value;
  });

  return system;
}

/** The body sim for the body keyed by `eid`, or `undefined` when the entity has
 * no internal body. */
function bodySim(state: PhysicsState, eid: number) {
  const handle = state.bodyByEntity.get(eid);
  if (handle === undefined) {
    return undefined;
  }
  const record = state.bodies.get(handle.index);
  return state.solverSets[record.setIndex]!.bodySims[record.localIndex];
}

/** The body state for the body keyed by `eid`, but only when it can hold one: a
 * non-static body in the awake set. Static bodies ignore velocity (Box2D does);
 * disabled / sleeping bodies have no body state. */
function awakeBodyState(state: PhysicsState, eid: number) {
  const handle = state.bodyByEntity.get(eid);
  if (handle === undefined) {
    return undefined;
  }
  const record = state.bodies.get(handle.index);
  if (record.type === STATIC_BODY || record.setIndex !== AWAKE_SET) {
    return undefined;
  }
  return state.solverSets[record.setIndex]!.bodyStates[record.localIndex];
}
