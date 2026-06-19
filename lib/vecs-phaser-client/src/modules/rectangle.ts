import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Rectangle, Size } from "@vworlds/vecs-phaser";

export class RectangleModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world.component(Rectangle).onRemove((entity) => entity.remove(Phaser.GameObjects.Rectangle));

    world
      .system("phaser.new.rectangle")
      .with(Rectangle, Size)
      .without(Phaser.GameObjects.Rectangle)
      .phase(ON_STORE)
      .enter([Size], (entity, [size]) => {
        const obj = scene.add.rectangle(0, 0, coords.len(size.width), coords.len(size.height));
        entity.attach(obj);
      });
  }
}
