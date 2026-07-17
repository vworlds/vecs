import { Module } from "@vworlds/vecs";

import { AngularImpulse, Impulse } from "./components.js";
import { scr_b2Vec2 } from "../adapter/runtime.js";
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
      .add(PhysicsSystemTag);
  }
}

function drainLinearImpulses(engine: PhysicsEngine): void {
  for (const [bodyId, impulse] of engine.pendingLinearImpulse) {
    if (!engine.entityByBodyIndex.has(bodyId.index1)) {
      continue;
    }
    const vec = scr_b2Vec2[0];
    vec.Set(impulse.x, impulse.y);
    engine.box2d.b2Body_ApplyLinearImpulseToCenter(bodyId, vec, impulse.wake);
  }
  engine.pendingLinearImpulse.clear();
}

function drainAngularImpulses(engine: PhysicsEngine): void {
  for (const [bodyId, impulse] of engine.pendingAngularImpulse) {
    if (!engine.entityByBodyIndex.has(bodyId.index1)) {
      continue;
    }
    engine.box2d.b2Body_ApplyAngularImpulse(bodyId, impulse.value, impulse.wake);
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
