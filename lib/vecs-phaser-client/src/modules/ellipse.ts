import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Ellipse, Size } from "@vworlds/vecs-phaser";

export class EllipseModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world.component(Ellipse).onRemove((entity) => entity.remove(Phaser.GameObjects.Ellipse));

    world
      .system("phaser.new.ellipse")
      .with(Ellipse, Size)
      .without(Phaser.GameObjects.Ellipse)
      .phase(ON_STORE)
      .enter([Size], (entity, [size]) => {
        const obj = new Phaser.GameObjects.Ellipse(
          scene,
          0,
          0,
          coords.len(size.width),
          coords.len(size.height)
        );
        entity.attach(obj);
      });
  }
}
