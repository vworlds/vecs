import { Module } from "@vworlds/vecs";

import { getPhysicsEngine, PhysicsSystemTag } from "../adapter/engine.js";
import { PhysicsCoreModule } from "./module.js";

export class PhysicsReaperModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(PhysicsCoreModule);

    const engine = getPhysicsEngine(world);
    world
      .system("PhysicsReaper")
      .phase(engine.phases.cleanup)
      .run(() => {
        // Joints first: a body destroy below cascade-destroys its joints, so we
        // tear down explicitly-removed joints before their bodies disappear. Guard
        // with b2Joint_IsValid because a joint queued from a cascaded body entity
        // may already be gone.
        const joints = engine.pendingJointDestroys;
        if (joints.length > 0) {
          for (const jointId of joints) {
            if (engine.box2d.b2Joint_IsValid(jointId)) {
              engine.box2d.b2DestroyJoint(jointId, true);
            }
          }
          joints.length = 0;
        }

        const shapes = engine.pendingShapeDestroys;
        if (shapes.length > 0) {
          for (const shapeId of shapes) {
            engine.entityByShapeIndex.delete(shapeId.index1);
            engine.box2d.b2DestroyShape(shapeId, true);
          }
          shapes.length = 0;
        }

        const chains = engine.pendingChainDestroys;
        if (chains.length > 0) {
          for (const chainId of chains) {
            engine.box2d.b2DestroyChain(chainId);
          }
          chains.length = 0;
        }

        const bodies = engine.pendingBodyDestroys;
        if (bodies.length > 0) {
          for (const bodyId of bodies) {
            engine.entityByBodyIndex.delete(bodyId.index1);
            engine.box2d.b2DestroyBody(bodyId);
          }
          bodies.length = 0;
        }
      })
      .add(PhysicsSystemTag);
  }
}
