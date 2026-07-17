import { Exclusive, Module, POST_UPDATE, Traversable } from "@vworlds/vecs";
import {
  DrawBy,
  DrawIn,
  phaserRenderableComponents,
  Position as RenderPosition,
  Rotation as RenderRotation,
} from "@vworlds/vecs-phaser";
import { Position as PhysicsPosition, Rotation as PhysicsRotation } from "@vworlds/vecs-physics";

export class PhaserServerModule extends Module<undefined> {
  public init(): void {
    const world = this.world;

    world.component(DrawIn).add(Exclusive);
    world.component(DrawBy).add(Exclusive).add(Traversable);
    world.setExclusiveComponents(...phaserRenderableComponents);

    world
      .system("phaser.sync.position")
      .with(PhysicsPosition, RenderPosition)
      .phase(POST_UPDATE)
      .update({ watch: PhysicsPosition, onEnter: true }, (e, p) =>
        e.set(RenderPosition, { x: p.x, y: p.y })
      );

    world
      .system("phaser.sync.rotation")
      .with(PhysicsRotation, RenderRotation)
      .phase(POST_UPDATE)
      .update({ watch: PhysicsRotation, onEnter: true }, (e, r) =>
        e.set(RenderRotation, { angle: r.angle })
      );
  }
}
