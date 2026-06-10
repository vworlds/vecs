import { Module, PRE_STORE, ON_STORE } from "@vworlds/vecs";
import type Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Star } from "@vworlds/vecs-phaser";
import { removeGameObject, StarGameObject, VGameObject } from "./types.js";

export class StarModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world
      .system("phaser.render.star.teardown")
      .with(Star, VGameObject)
      .phase(PRE_STORE)
      .exit([Star, VGameObject], (entity) => removeGameObject(entity));

    world
      .system("phaser.new.star")
      .with(Star)
      .without(VGameObject)
      .phase(ON_STORE)
      .enter([Star], (entity, [star]) => {
        const obj = scene.add.star(
          0,
          0,
          star.points,
          coords.len(star.innerRadius),
          coords.len(star.outerRadius)
        ) as unknown as StarGameObject;
        entity.set(VGameObject, { obj });
      });

    world
      .system("phaser.render.star.geometry")
      .with(Star, VGameObject)
      .phase(ON_STORE)
      .update(Star, [VGameObject], (_entity, star, [vgo]) => {
        const obj = vgo.obj as StarGameObject;
        obj.setPoints(star.points);
        obj.setInnerRadius(coords.len(star.innerRadius));
        obj.setOuterRadius(coords.len(star.outerRadius));
      });
  }
}
