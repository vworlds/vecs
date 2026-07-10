import { Module } from "@vworlds/vecs";
import { Rotation as RenderRotation } from "@vworlds/vecs-phaser";
import { Electron, LocalOffsetComponents } from "./components.js";

export class LocalOffsetsModule extends Module {
  public init(): void {
    const world = this.world;
    world.module(LocalOffsetComponents);

    // Orbit electrons by rotating their intermediate Container, not by
    // updating Offset. The electron sits at a fixed Offset inside the
    // orbit Container; rotating the Container orbits the electron around
    // the ball centre. This sends 1 f32/tick (Rotation) instead of 2
    // (Offset.x/y).
    world
      .system("OrbitElectrons")
      .with(Electron, RenderRotation)
      .each([Electron, RenderRotation], (entity, [electron, rotation]) => {
        electron.angle += electron.speed;
        rotation.angle = electron.angle;
        entity.modified(Electron);
        entity.modified(RenderRotation);
      });
  }
}
