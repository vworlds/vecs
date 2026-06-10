import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Ellipse } from "@vworlds/vecs-phaser";
import * as m from "../markers.js";

export class EllipseModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world.component(Ellipse).onRemove((entity) => {
      if (entity.has(Phaser.GameObjects.Ellipse)) {
        entity.remove(Phaser.GameObjects.Ellipse);
      }
    });

    world
      .system("phaser.new.ellipse")
      .with(Ellipse)
      .without(Phaser.GameObjects.Ellipse)
      .phase(ON_STORE)
      .enter([Ellipse], (entity, [ellipse]) => {
        const obj = scene.add.ellipse(0, 0, coords.len(ellipse.width), coords.len(ellipse.height));
        entity.attach(obj);
      });

    world
      .system("phaser.render.ellipse.geometry")
      .with(Ellipse, m.Size)
      .phase(ON_STORE)
      .update(Ellipse, [m.Size], (_entity, ellipse, [obj]) => {
        obj.setSize(coords.len(ellipse.width), coords.len(ellipse.height));
      });
  }
}
