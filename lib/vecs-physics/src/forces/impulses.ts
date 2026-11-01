import { Module } from "@vworlds/vecs";

import { AngularImpulse, Impulse } from "./components.js";
import { rev } from "../adapter/runtime.js";
import {
  getPhysicsEngine,
  PhysicsSystemTag,
  type b2BodyId,
  type PhysicsEngine,
} from "../adapter/engine.js";
import { PhysicsCoreModule } from "../core/module.js";
import { resolveBodyId } from "../util/resolve_body.js";

type LinearImpulseAccumulator = { x: number; y: number; wake: boolean };
type AngularImpulseAccumulator = { value: number; wake: boolean };

export class ImpulseAccumulateModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    world.component(Impulse).on("set", (entity, impulse) => {
      // A zero impulse adds nothing and its `wake` must not count, so ignore it before any
      // lookup: no body resolve, no accumulator, nothing for PhysicsImpulseZero to clear.
      if (impulse.x === 0 && impulse.y === 0) {
        return;
      }

      const bodyId = resolveBodyId(entity);
      if (bodyId === undefined) {
        return;
      }

      engine.impulseEntitiesThisStep.add(entity.eid);
      const accumulator = getLinearAccumulator(engine, bodyId);
      accumulator.x += impulse.x;
      accumulator.y += impulse.y;
      accumulator.wake ||= impulse.wake;
    });

    world.component(AngularImpulse).on("set", (entity, impulse) => {
      // Same as a zero linear impulse above.
      if (impulse.value === 0) {
        return;
      }

      const bodyId = resolveBodyId(entity);
      if (bodyId === undefined) {
        return;
      }

      engine.impulseEntitiesThisStep.add(entity.eid);
      const accumulator = getAngularAccumulator(engine, bodyId);
      accumulator.value += impulse.value;
      accumulator.wake ||= impulse.wake;
    });

    world
      .system("PhysicsImpulseAccumulate")
      .phase(engine.phases.preStep)
      .run(() => {
        drainLinearImpulses(engine);
        drainAngularImpulses(engine);
      })
      .entity.add(PhysicsSystemTag);
  }
}

function drainLinearImpulses(engine: PhysicsEngine): void {
  // Avoid allocating an iterator for an empty queue.
  if (engine.pendingLinearImpulse.size === 0) {
    return;
  }
  for (const [bodyId, impulse] of engine.pendingLinearImpulse) {
    // Impulses that cancel out are physically a no-op: skip the wasm call and its wake.
    if (impulse.x === 0 && impulse.y === 0) {
      continue;
    }
    if (!engine.entityByBodyIndex.has(bodyId.index1)) {
      continue;
    }
    engine.fast.module._b2x_Body_ApplyLinearImpulseToCenter(
      bodyId.index1,
      rev(bodyId),
      impulse.x,
      impulse.y,
      impulse.wake ? 1 : 0
    );
  }
  engine.pendingLinearImpulse.clear();
}

function drainAngularImpulses(engine: PhysicsEngine): void {
  if (engine.pendingAngularImpulse.size === 0) {
    return;
  }
  for (const [bodyId, impulse] of engine.pendingAngularImpulse) {
    if (impulse.value === 0) {
      continue;
    }
    if (!engine.entityByBodyIndex.has(bodyId.index1)) {
      continue;
    }
    engine.fast.module._b2x_Body_ApplyAngularImpulse(
      bodyId.index1,
      rev(bodyId),
      impulse.value,
      impulse.wake ? 1 : 0
    );
  }
  engine.pendingAngularImpulse.clear();
}

function getLinearAccumulator(engine: PhysicsEngine, bodyId: b2BodyId): LinearImpulseAccumulator {
  let accumulator = engine.pendingLinearImpulse.get(bodyId);
  if (accumulator === undefined) {
    accumulator = { x: 0, y: 0, wake: false };
    engine.pendingLinearImpulse.set(bodyId, accumulator);
  }
  return accumulator;
}

function getAngularAccumulator(engine: PhysicsEngine, bodyId: b2BodyId): AngularImpulseAccumulator {
  let accumulator = engine.pendingAngularImpulse.get(bodyId);
  if (accumulator === undefined) {
    accumulator = { value: 0, wake: false };
    engine.pendingAngularImpulse.set(bodyId, accumulator);
  }
  return accumulator;
}
