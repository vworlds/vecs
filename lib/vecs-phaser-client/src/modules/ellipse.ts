import { Module, PRE_STORE, ON_STORE } from "@vworlds/vecs";
import type Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Ellipse } from "@vworlds/vecs-phaser";
import { removeGameObject, SizeGameObject, VGameObject } from "./types.js";

export class EllipseModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world
      .system("phaser.render.ellipse.teardown")
      .with(Ellipse, VGameObject)
      .phase(PRE_STORE)
      .exit([Ellipse, VGameObject], (entity) => removeGameObject(entity));

    world
      .system("phaser.new.ellipse")
      .with(Ellipse)
      .without(VGameObject)
      .phase(ON_STORE)
      .enter([Ellipse], (entity, [ellipse]) => {
        const obj = scene.add.ellipse(
          0,
          0,
          coords.len(ellipse.width),
          coords.len(ellipse.height)
        ) as unknown as SizeGameObject;
        entity.set(VGameObject, { obj });
      });

    world
      .system("phaser.render.ellipse.geometry")
      .with(Ellipse, VGameObject)
      .phase(ON_STORE)
      .update(Ellipse, [VGameObject], (_entity, ellipse, [vgo]) => {
        (vgo.obj as SizeGameObject).setSize(coords.len(ellipse.width), coords.len(ellipse.height));
      });
  }
}
