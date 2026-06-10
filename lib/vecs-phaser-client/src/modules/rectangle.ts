import { Module, PRE_STORE, ON_STORE } from "@vworlds/vecs";
import type Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Rectangle } from "@vworlds/vecs-phaser";
import { RectangleObject, removeGameObject, VGameObject } from "./types.js";

export class RectangleModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world
      .system("phaser.render.rectangle.teardown")
      .with(Rectangle, VGameObject)
      .phase(PRE_STORE)
      .exit([Rectangle, VGameObject], (entity) => removeGameObject(entity));

    world
      .system("phaser.new.rectangle")
      .with(Rectangle)
      .without(VGameObject)
      .phase(ON_STORE)
      .enter([Rectangle], (entity, [rectangle]) => {
        const obj = scene.add.rectangle(
          0,
          0,
          coords.len(rectangle.width),
          coords.len(rectangle.height)
        ) as RectangleObject;
        entity.set(VGameObject, { obj });
      });

    world
      .system("phaser.render.rectangle.geometry")
      .with(Rectangle, VGameObject)
      .phase(ON_STORE)
      .update(Rectangle, [VGameObject], (_entity, rectangle, [vgo]) => {
        (vgo.obj as RectangleObject).setSize(
          coords.len(rectangle.width),
          coords.len(rectangle.height)
        );
      });
  }
}
