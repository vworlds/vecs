import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { Image, Size } from "@vworlds/vecs-phaser";
import { CoordSpace } from "../coord_space.js";
import * as m from "../markers.js";

export class ImageModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world.component(Image).onRemove((entity) => entity.remove(Phaser.GameObjects.Image));

    world
      .system("phaser.new.image")
      .with(Image)
      .without(Phaser.GameObjects.Image)
      .phase(ON_STORE)
      .enter([Image], (entity, [image]) => {
        const obj = scene.add.image(0, 0, String(image.texture), image.frame).setOrigin(0.5);
        entity.attach(obj);
      });

    world
      .system("phaser.render.image.texture")
      .with(Image, m.Texture)
      .phase(ON_STORE)
      .update({ watch: Image, inject: [m.Texture] }, (_entity, image, [obj]) =>
        obj.setTexture(String(image.texture), image.frame)
      );

    world
      .system("phaser.render.image.size")
      .with(Image, m.Texture)
      .phase(ON_STORE)
      .update({ watch: Size, onEnter: true, inject: [m.Texture] }, (_entity, size, [obj]) =>
        obj.setDisplaySize(coords.len(size.width), coords.len(size.height))
      );
  }
}
