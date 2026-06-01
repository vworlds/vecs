// `PhysicsImpulseAccumulate` — intercepts Impulse/AngularImpulse writes and sums
// them into per-body pending accumulators on PhysicsState.
//
// Phase: `physics-pre`. The system is a named entity/tag for `PhysicsSystemTag`
// purposes; the actual accumulation is done via `onSet` hooks (see below).
//
// IMPORTANT — why `onSet` hooks and not `.update()` callbacks:
//
// A Vecs `.update(Impulse, cb)` inbox event stores a REFERENCE to the component
// instance. When multiple `entity.set(Impulse, ...)` calls happen in the same
// frame, all inbox events accumulate but, by drain time, every event's `c`
// reference has been overwritten by `Object.assign` to the LAST set value.
// This means three sets (x:1, x:2, x:3) all fire `cb(e, {x:3})` → the
// accumulator would sum 3+3+3=9 instead of the intended 1+2+3=6.
//
// `world.component(Impulse).onSet(handler)` fires SYNCHRONOUSLY inside
// `_notifyComponentSet`, which is called AFTER `Object.assign` for EACH Set
// command, before the next Set command is processed. Each call therefore sees
// the value at its exact set-time: x=1 first, x=2 second, x=3 third. Total = 6.
//
// This is safe because we only mutate PhysicsState accumulators (no structural
// ECS mutations like entity creation that could cause re-entrant issues).
//
// Immediate-parent rule (same as PhysicsForceGather / PhysicsShapeLifecycle):
//   - Entity itself has Body → it IS the body.
//   - Else its immediate ChildOf parent has Body → that parent is the body.
//   - Grandparents are never consulted.
//
// Wake flag: carried structurally; no-op until sleep lands (M5). Mirrors
// `b2Body_ApplyLinearImpulseToCenter` (body.c:1037-1040) and
// `b2Body_ApplyAngularImpulse` (body.c:1065-1068) wake-guard blocks.
//
// Box2D reference lines mirrored:
//   b2Body_ApplyLinearImpulseToCenter (body.c:1027-1052):
//     state->linearVelocity = b2MulAdd(state->linearVelocity, invMass, impulse); // body.c:1048
//   b2Body_ApplyAngularImpulse (body.c:1054-1079):
//     state->angularVelocity += invInertia * impulse;                             // body.c:1077

import { ChildOf, type Entity, type IPhase, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { AngularImpulse, Impulse } from "../components/force.js";
import { type PhysicsState } from "../engine/state.js";
import type { BodyHandle } from "../util/handle.js";

/** Resolve the body handle for entity `e` by the immediate-parent rule:
 * the entity itself if it has Body, else its immediate ChildOf parent if that
 * has Body. Returns the full `(index, generation)` handle (the generation lets
 * `applyPendingImpulses` reject a stale impulse whose target body was destroyed
 * and whose slot was reused before the step consumed the accumulator).
 * Returns `undefined` if neither applies. */
function resolveBodyHandle(e: Entity, state: PhysicsState): BodyHandle | undefined {
  let bodyEid: number;
  if (e.get(Body) !== undefined) {
    bodyEid = e.eid;
  } else {
    const parent = e.parent(ChildOf);
    if (parent === undefined || parent.get(Body) === undefined) {
      return undefined;
    }
    bodyEid = parent.eid;
  }
  return state.bodyByEntity.get(bodyEid);
}

/** Get (or create) the pending-impulse accumulator for `handle`, keyed by the
 * stable slot index. If an existing accumulator carries a different generation
 * (the slot was freed and reused since the last set this frame), it belonged to
 * a now-dead body — reset it to the current generation so the stale magnitude
 * is discarded. */
function getAccumulator(
  state: PhysicsState,
  handle: BodyHandle
): { x: number; y: number; angular: number; wake: boolean; generation: number } {
  let acc = state.pendingImpulses.get(handle.index);
  if (acc === undefined || acc.generation !== handle.generation) {
    acc = { x: 0, y: 0, angular: 0, wake: false, generation: handle.generation };
    state.pendingImpulses.set(handle.index, acc);
  }
  return acc;
}

/** Create `PhysicsImpulseAccumulate` on `world`, bound to `state` and `phase`.
 * Returns the system so the caller can tag its entity. */
export function installImpulseAccumulate(world: World, state: PhysicsState, phase: IPhase): System {
  // Register onSet hooks that fire synchronously at each set(), capturing the
  // value BEFORE the next set() overwrites it. This is the only mechanism that
  // gives correct per-set accumulation within a single frame.
  world.component(Impulse).onSet((e, imp) => {
    const handle = resolveBodyHandle(e, state);
    if (handle === undefined) {
      return;
    }

    // Record the eid so PhysicsImpulseZero can silently zero it after the step.
    state.impulseEntitiesThisStep.add(e.eid);

    // Accumulate into the pending impulse map, keyed by body handle index and
    // tagged with the handle generation for same-frame stale-target rejection.
    const acc = getAccumulator(state, handle);
    acc.x += imp.x; // mirrors: b2MulAdd(linearVelocity, invMass, impulse) [body.c:1048]
    acc.y += imp.y;
    if (imp.wake) {
      acc.wake = true;
    }
  });

  world.component(AngularImpulse).onSet((e, ai) => {
    const handle = resolveBodyHandle(e, state);
    if (handle === undefined) {
      return;
    }

    state.impulseEntitiesThisStep.add(e.eid);

    const acc = getAccumulator(state, handle);
    acc.angular += ai.value; // mirrors: angularVelocity += invInertia * impulse [body.c:1077]
    if (ai.wake) {
      acc.wake = true;
    }
  });

  // The system itself is a named entity that: (a) gets tagged with PhysicsSystemTag
  // for the ignoreSource domain, and (b) registers the hooks above at install time
  // (they run regardless of phase). A .run() callback is provided for structural
  // completeness; the actual accumulation work is done by the onSet hooks above.
  return world
    .system("PhysicsImpulseAccumulate")
    .phase(phase)
    .run(() => {
      // No per-frame work needed: onSet hooks accumulate synchronously at set-time.
    });
}
