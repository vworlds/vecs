import { Module, PRE_STORE, ON_STORE } from "@vworlds/vecs";
import type Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Arc } from "@vworlds/vecs-phaser";
import { ArcObject, type RenderObject, removeGameObject, VGameObject } from "./types.js";

export class ArcModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world
      .system("phaser.render.arc.teardown")
      .with(Arc, VGameObject)
      .phase(PRE_STORE)
      .exit([Arc, VGameObject], (entity) => removeGameObject(entity));

    world
      .system("phaser.new.arc")
      .with(Arc)
      .without(VGameObject)
      .phase(ON_STORE)
      .enter([Arc], (entity, [arc]) => {
        const obj = scene.add.arc(
          0,
          0,
          coords.len(arc.radius),
          coords.deg(arc.startAngle),
          coords.deg(arc.endAngle),
          arc.anticlockwise
        ) as ArcObject;
        obj.setIterations(arc.iterations);
        entity.set(VGameObject, { obj: obj as RenderObject });
      });

    world
      .system("phaser.render.arc.geometry")
      .with(Arc, VGameObject)
      .phase(ON_STORE)
      .update(Arc, [VGameObject], (_entity, arc, [vgo]) => {
        (vgo.obj as ArcObject)
          .setRadius(coords.len(arc.radius))
          .setStartAngle(coords.deg(arc.startAngle), arc.anticlockwise)
          .setEndAngle(coords.deg(arc.endAngle), arc.anticlockwise)
          .setIterations(arc.iterations);
      });
  }
}
