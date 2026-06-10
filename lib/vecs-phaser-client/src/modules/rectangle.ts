import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Rectangle } from "@vworlds/vecs-phaser";
import * as m from "../markers.js";

export class RectangleModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world.component(Rectangle).onRemove((entity) => {
      if (entity.has(Phaser.GameObjects.Rectangle)) {
        entity.remove(Phaser.GameObjects.Rectangle);
      }
    });

    world
      .system("phaser.new.rectangle")
      .with(Rectangle)
      .without(Phaser.GameObjects.Rectangle)
      .phase(ON_STORE)
      .enter([Rectangle], (entity, [rectangle]) => {
        const obj = scene.add.rectangle(
          0,
          0,
          coords.len(rectangle.width),
          coords.len(rectangle.height)
        );
        entity.attach(obj);
      });

    world
      .system("phaser.render.rectangle.geometry")
      .with(Rectangle, m.Size)
      .phase(ON_STORE)
      .update(Rectangle, [m.Size], (_entity, rectangle, [obj]) => {
        obj.setSize(coords.len(rectangle.width), coords.len(rectangle.height));
      });
  }
}
