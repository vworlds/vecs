// `PhysicsModule` is the public umbrella for vecs-physics. It keeps startup to
// `await preloadPhysics(); world.module(PhysicsModule, options);` while the
// implementation is split into feature modules that own their components and
// systems.

import { Module } from "@vworlds/vecs";

import { BodyMassModule } from "./body/mass.js";
import { BodyModule } from "./body/module.js";
import { BodyPoseInModule } from "./body/pose_in.js";
import { BodyPoseOutModule } from "./body/pose_out.js";
import { PhysicsCoreModule, type PhysicsOptions } from "./core/module.js";
import { PhysicsReaperModule } from "./core/reaper.js";
import { PhysicsSnapshotModule } from "./core/snapshot.js";
import { PhysicsStepModule } from "./core/step.js";
import { DebugModule } from "./debug/validation.js";
import { EventsModule } from "./events/module.js";
import { EventOptInModule } from "./events/opt_in.js";
import { EventPublishModule } from "./events/publish.js";
import { ForcesModule } from "./forces/module.js";
import { ImpulseZeroModule } from "./forces/zero.js";
import { JointsModule } from "./joints/module.js";
import { KinematicModule } from "./kinematic/module.js";
import { MaterialsModule } from "./materials/module.js";
import { ShapesModule } from "./shapes/module.js";
import { ShapePoseModule } from "./shapes/pose_sync.js";

export type { PhysicsOptions } from "./core/module.js";

/** World module that installs physics when registered with `world.module`. */
export class PhysicsModule extends Module<PhysicsOptions | undefined> {
  public init(options: PhysicsOptions | undefined): void {
    const world = this.world;

    // Install physics policies before the rest of the physics modules. Capture
    // binds each policy's materializer, so this ordering is a package-local
    // convention rather than a cross-world transfer requirement.
    world.module(PhysicsSnapshotModule);
    world.module(PhysicsCoreModule, options ?? {});

    // physics-pre: lifecycle + sync systems in dependency order.
    world.module(BodyModule);
    world.module(ShapesModule);
    world.module(JointsModule);
    world.module(MaterialsModule);
    world.module(EventsModule);
    world.module(EventOptInModule);
    world.module(PhysicsReaperModule);
    world.module(ShapePoseModule);
    world.module(BodyPoseInModule);
    world.module(KinematicModule);
    world.module(ForcesModule);
    world.module(BodyMassModule);
    world.module(DebugModule);

    // physics-step: integrator.
    world.module(PhysicsStepModule);

    // physics-post: writeback, events, and one-shot cleanup.
    world.module(BodyPoseOutModule);
    world.module(EventPublishModule);
    world.module(ImpulseZeroModule);
  }
}
