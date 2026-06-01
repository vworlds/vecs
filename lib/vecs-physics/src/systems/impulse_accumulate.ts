import { ChildOf, type Entity, type IPhase, type System, type World } from "@vworlds/vecs";

import { Body } from "../components/body.js";
import { AngularImpulse, Impulse } from "../components/force.js";
import { type b2BodyId, type PhysicsState } from "../adapter/state.js";

type LinearImpulseAccumulator = { x: number; y: number; wake: boolean };
type AngularImpulseAccumulator = { value: number; wake: boolean };

export function installImpulseAccumulate(world: World, state: PhysicsState, phase: IPhase): System {
  return world
    .system("PhysicsImpulseAccumulate")
    .phase(phase)
    .run(() => {
      drainLinearImpulses(state);
      drainAngularImpulses(state);
    });
}

export function registerImpulseHooks(world: World, state: PhysicsState): void {
  world.component(Impulse).onSet((entity, impulse) => {
    const bodyId = resolveBodyId(entity, state);
    if (bodyId === undefined) {
      return;
    }

    state.impulseEntitiesThisStep.add(entity.eid);
    const accumulator = getLinearAccumulator(state, bodyId);
    accumulator.x += impulse.x;
    accumulator.y += impulse.y;
    accumulator.wake ||= impulse.wake;
  });

  world.component(AngularImpulse).onSet((entity, impulse) => {
    const bodyId = resolveBodyId(entity, state);
    if (bodyId === undefined) {
      return;
    }

    state.impulseEntitiesThisStep.add(entity.eid);
    const accumulator = getAngularAccumulator(state, bodyId);
    accumulator.value += impulse.value;
    accumulator.wake ||= impulse.wake;
  });
}

function drainLinearImpulses(state: PhysicsState): void {
  const pending = pendingLinearImpulse(state);
  for (const [bodyId, impulse] of pending) {
    if (!state.entityByBody.has(bodyId)) {
      continue;
    }
    state.scratchVec2.Set(impulse.x, impulse.y);
    state.box2d.b2Body_ApplyLinearImpulseToCenter(bodyId, state.scratchVec2, impulse.wake);
  }
  pending.clear();
}

function drainAngularImpulses(state: PhysicsState): void {
  const pending = pendingAngularImpulse(state);
  for (const [bodyId, impulse] of pending) {
    if (!state.entityByBody.has(bodyId)) {
      continue;
    }
    state.box2d.b2Body_ApplyAngularImpulse(bodyId, impulse.value, impulse.wake);
  }
  pending.clear();
}

function getLinearAccumulator(state: PhysicsState, bodyId: b2BodyId): LinearImpulseAccumulator {
  const pending = pendingLinearImpulse(state);
  let accumulator = pending.get(bodyId);
  if (accumulator === undefined) {
    accumulator = { x: 0, y: 0, wake: false };
    pending.set(bodyId, accumulator);
  }
  return accumulator;
}

function getAngularAccumulator(state: PhysicsState, bodyId: b2BodyId): AngularImpulseAccumulator {
  const pending = pendingAngularImpulse(state);
  let accumulator = pending.get(bodyId);
  if (accumulator === undefined) {
    accumulator = { value: 0, wake: false };
    pending.set(bodyId, accumulator);
  }
  return accumulator;
}

function pendingLinearImpulse(state: PhysicsState): Map<b2BodyId, LinearImpulseAccumulator> {
  return state.pendingLinearImpulse as unknown as Map<b2BodyId, LinearImpulseAccumulator>;
}

function pendingAngularImpulse(state: PhysicsState): Map<b2BodyId, AngularImpulseAccumulator> {
  return state.pendingAngularImpulse as unknown as Map<b2BodyId, AngularImpulseAccumulator>;
}

function resolveBodyId(entity: Entity, state: PhysicsState): b2BodyId | undefined {
  if (entity.get(Body) !== undefined) {
    return state.bodyByEntityWasm.get(entity.eid);
  }

  const parent = entity.parent(ChildOf);
  if (parent === undefined || parent.get(Body) === undefined) {
    return undefined;
  }
  return state.bodyByEntityWasm.get(parent.eid);
}
