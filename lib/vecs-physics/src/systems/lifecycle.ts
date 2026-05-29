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

    const wasDisabled = record.setIndex === DISABLED_SET;
    const targetSetIndex = chooseSetIndex(body);
    const willBeDisabled = targetSetIndex === DISABLED_SET;
    const newType = bodyTypeToNumber(body.type);
    const typeChanged = newType !== record.type;

    // ── Stage 1: Proxy teardown on disable ────────────────────────────────────
    // Contact teardown on disable is deferred to M3.
    if (!wasDisabled && willBeDisabled) {
      destroyBodyShapeProxies(state, record);
    }

    // ── Stage 2: Transfer body between solver sets ────────────────────────────
    if (targetSetIndex !== record.setIndex) {
      transferBody(
        state.bodies,
        state.solverSets[targetSetIndex]!,
        state.solverSets[record.setIndex]!,
        record
      );
    }

    // ── Stage 3: Update stored type ───────────────────────────────────────────
    record.type = newType;

    // ── Stage 4: Proxy management on enable / type change ────────────────────
    if (wasDisabled && !willBeDisabled) {
      // Body just enabled: create proxies for all shapes in the new type tree.
      // Contact creation on enable is deferred to M3.
      createBodyShapeProxies(state, record, newType);
    } else if (!wasDisabled && !willBeDisabled && typeChanged) {
      // Type changed while body stays enabled: move proxies to new type tree.
      // Contact teardown on type change is deferred to M3.
      destroyBodyShapeProxies(state, record);
      createBodyShapeProxies(state, record, newType);
    }
  });

  return system;
}
