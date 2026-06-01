import { type IPhase, type System, type World } from "@vworlds/vecs";

import { AngularImpulse, Impulse } from "../components/force.js";
import { type b2BodyId, type PhysicsState } from "../adapter/state.js";
import { resolveBodyId } from "../util/resolve_body.js";

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
  for (const [bodyId, impulse] of state.pendingLinearImpulse) {
    if (!state.entityByBodyIndex.has(bodyId.index1)) {
      continue;
    }
    state.scratchVec2.Set(impulse.x, impulse.y);
    state.box2d.b2Body_ApplyLinearImpulseToCenter(bodyId, state.scratchVec2, impulse.wake);
  }
  state.pendingLinearImpulse.clear();
}

function drainAngularImpulses(state: PhysicsState): void {
  for (const [bodyId, impulse] of state.pendingAngularImpulse) {
    if (!state.entityByBodyIndex.has(bodyId.index1)) {
      continue;
    }
    state.box2d.b2Body_ApplyAngularImpulse(bodyId, impulse.value, impulse.wake);
  }
  state.pendingAngularImpulse.clear();
}

function getLinearAccumulator(state: PhysicsState, bodyId: b2BodyId): LinearImpulseAccumulator {
  let accumulator = state.pendingLinearImpulse.get(bodyId);
  if (accumulator === undefined) {
    accumulator = { x: 0, y: 0, wake: false };
    state.pendingLinearImpulse.set(bodyId, accumulator);
  }
  return accumulator;
}

function getAngularAccumulator(state: PhysicsState, bodyId: b2BodyId): AngularImpulseAccumulator {
  let accumulator = state.pendingAngularImpulse.get(bodyId);
  if (accumulator === undefined) {
    accumulator = { value: 0, wake: false };
    state.pendingAngularImpulse.set(bodyId, accumulator);
  }
  return accumulator;
}
