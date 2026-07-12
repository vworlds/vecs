import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { Animation, Size, Sprite } from "@vworlds/vecs-phaser";
import { CoordSpace } from "../coord_space.js";
import * as m from "../markers.js";

export class SpriteModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world.component(Sprite).onRemove((entity) => entity.remove(Phaser.GameObjects.Sprite));

    // Stopping is hook-driven so it fires at the mutation site: removing
    // Animation stops playback and restores the static Sprite.frame.
    world.component(Animation).onRemove((entity) => {
      const obj = entity.get(Phaser.GameObjects.Sprite);
      const sprite = entity.get(Sprite);
      if (!obj || !sprite) {
        return;
      }
      obj.stop();
      obj.setTexture(String(sprite.texture), sprite.frame);
    });

    world
      .system("phaser.new.sprite")
      .with(Sprite)
      .without(Phaser.GameObjects.Sprite)
      .phase(ON_STORE)
      .enter([Sprite], (entity, [sprite]) => {
        const obj = new Phaser.GameObjects.Sprite(
          scene,
          0,
          0,
          String(sprite.texture),
          sprite.frame
        ).setOrigin(0.5);
        entity.attach(obj);
      });

    // Texture/frame changes only apply while no animation is playing — the
    // animation owns the displayed frame otherwise.
    world
      .system("phaser.render.sprite.texture")
      .with(Sprite, m.Texture)
      .without(Animation)
      .phase(ON_STORE)
      .update({ watch: Sprite, inject: [m.Texture] }, (_entity, sprite, [obj]) =>
        obj.setTexture(String(sprite.texture), sprite.frame)
      );

    world
      .system("phaser.render.sprite.size")
      .with(Sprite, m.Texture)
      .phase(ON_STORE)
      .update({ watch: Size, onEnter: true, inject: [m.Texture] }, (_entity, size, [obj]) =>
        obj.setDisplaySize(coords.len(size.width), coords.len(size.height))
      );

    world
      .system("phaser.render.sprite.animation")
      .with(Sprite, Animation, m.Animated)
      .phase(ON_STORE)
      .update(
        { watch: Animation, onEnter: true, inject: [m.Animated, Sprite] },
        (_entity, animation, [obj, sprite]) => {
          obj.play(`${sprite.texture}:${animation.tile}`, true);
          obj.anims.timeScale = animation.speed;
        }
      );
  }
}
