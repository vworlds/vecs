import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Star } from "@vworlds/vecs-phaser";
import * as m from "../markers.js";

export class StarModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world.component(Star).onRemove((entity) => {
      if (entity.has(Phaser.GameObjects.Star)) {
        entity.remove(Phaser.GameObjects.Star);
      }
    });

    world
      .system("phaser.new.star")
      .with(Star)
      .without(Phaser.GameObjects.Star)
      .phase(ON_STORE)
      .enter([Star], (entity, [star]) => {
        const obj = scene.add.star(
          0,
          0,
          star.points,
          coords.len(star.innerRadius),
          coords.len(star.outerRadius)
        );
        entity.attach(obj);
      });

    world
      .system("phaser.render.star.geometry")
      .with(Star, m.Star)
      .phase(ON_STORE)
      .update({ watch: Star, enter: true, inject: [m.Star] }, (_entity, star, [obj]) => {
        obj.setPoints(star.points);
        obj.setInnerRadius(coords.len(star.innerRadius));
        obj.setOuterRadius(coords.len(star.outerRadius));
      });
  }
}
