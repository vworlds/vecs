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
import { Damping, GravityScale } from "../components/body_tuning.js";
import { makeRot } from "../math/rot.js";
import { DYNAMIC_BODY, KINEMATIC_BODY, STATIC_BODY, writeBodyTransform } from "../engine/body.js";
import {
  AWAKE_SET,
  DISABLED_SET,
  STATIC_SET,
  createBody,
  destroyBody,
  transferBody,
} from "../engine/solver_set.js";
import { type PhysicsState } from "../engine/state.js";

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

/** Create `PhysicsBodyLifecycle` on `world`, bound to `state` and `phase`.
 * Returns the system so the caller can tag its entity. */
export function installBodyLifecycle(world: World, state: PhysicsState, phase: IPhase): System {
  const system = world.system("PhysicsBodyLifecycle").requires(Body).phase(phase);

  system.enter((e) => {
    const body = e.get(Body)!;
    const type = bodyTypeToNumber(body.type);
    const setIndex = chooseSetIndex(body);
    const set = state.solverSets[setIndex]!;

    const handle = createBody(state.bodies, set, e, type);
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
    // Shapes, contacts, and island links are torn down by their own systems
    // once they exist (VP-11+); a VP-6 body owns none of them.
    destroyBody(state.bodies, state.solverSets[record.setIndex]!, handle);
    state.bodyByEntity.delete(e.eid);
  });

  system.update(Body, (e, body) => {
    const handle = state.bodyByEntity.get(e.eid);
    if (handle === undefined) {
      return;
    }
    const record = state.bodies.get(handle.index);

    // Type and enable changes relocate the body between solver sets — the part
    // of `b2Body_SetType` / `b2Body_Enable`/`Disable` that is fully portable
    // today. Their contact-destruction, mass re-init, and proxy re-creation
    // arrive with the contact/mass/broad-phase tickets.
    const targetSetIndex = chooseSetIndex(body);
    if (targetSetIndex !== record.setIndex) {
      transferBody(
        state.bodies,
        state.solverSets[targetSetIndex]!,
        state.solverSets[record.setIndex]!,
        record
      );
    }
    record.type = bodyTypeToNumber(body.type);
  });

  return system;
}
