import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Arc } from "@vworlds/vecs-phaser";
import * as m from "../markers.js";

export class ArcModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world.component(Arc).onRemove((entity) => {
      if (entity.has(Phaser.GameObjects.Arc)) {
        entity.remove(Phaser.GameObjects.Arc);
      }
    });

    world
      .system("phaser.new.arc")
      .with(Arc)
      .without(Phaser.GameObjects.Arc)
      .phase(ON_STORE)
      .enter([Arc], (entity, [arc]) => {
        const obj = scene.add.arc(
          0,
          0,
          coords.len(arc.radius),
          coords.deg(arc.startAngle),
          coords.deg(arc.endAngle),
          arc.anticlockwise
        );
        obj.setIterations(arc.iterations);
        entity.attach(obj);
      });

    world
      .system("phaser.render.arc.geometry")
      .with(Arc, m.Arc)
      .phase(ON_STORE)
      .update({ component: Arc, inject: [m.Arc] }, (_entity, arc, [obj]) => {
        obj
          .setRadius(coords.len(arc.radius))
          .setStartAngle(coords.deg(arc.startAngle), arc.anticlockwise)
          .setEndAngle(coords.deg(arc.endAngle), arc.anticlockwise)
          .setIterations(arc.iterations);
      });
  }
}
