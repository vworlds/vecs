import { Module, PRE_STORE } from "@vworlds/vecs";
import {
  phaserRenderableComponents,
  Position as RenderPosition,
  Rotation as RenderRotation,
} from "@vworlds/vecs-phaser";
import { Position as PhysicsPosition, Rotation as PhysicsRotation } from "@vworlds/vecs-physics";

export class PhaserServerModule extends Module<undefined> {
  public init(): void {
    const world = this.world;

    world.setExclusiveComponents(...phaserRenderableComponents);

    world
      .system("phaser.sync.position")
      .with(PhysicsPosition, RenderPosition)
      .phase(PRE_STORE)
      .update(PhysicsPosition, (e, p) => e.set(RenderPosition, { x: p.x, y: p.y }));

    world
      .system("phaser.sync.rotation")
      .with(PhysicsRotation, RenderRotation)
      .phase(PRE_STORE)
      .update(PhysicsRotation, (e, r) => e.set(RenderRotation, { angle: r.angle }));
  }
}
