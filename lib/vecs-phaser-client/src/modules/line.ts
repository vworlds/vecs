import { Module, PRE_STORE, ON_STORE } from "@vworlds/vecs";
import type Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Line } from "@vworlds/vecs-phaser";
import { LineObject, removeGameObject, VGameObject } from "./types.js";

function linePoints(coords: CoordSpace, line: Line): [number, number, number, number] {
  return [coords.rx(line.x1), coords.ry(line.y1), coords.rx(line.x2), coords.ry(line.y2)];
}

export class LineModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world
      .system("phaser.render.line.teardown")
      .with(Line, VGameObject)
      .phase(PRE_STORE)
      .exit([Line, VGameObject], (entity) => removeGameObject(entity));

    world
      .system("phaser.new.line")
      .with(Line)
      .without(VGameObject)
      .phase(ON_STORE)
      .enter([Line], (entity, [line]) => {
        const points = linePoints(coords, line);
        const obj = scene.add.line(0, 0, points[0], points[1], points[2], points[3]) as LineObject;
        obj.setOrigin(0, 0);
        entity.set(VGameObject, { obj });
      });

    world
      .system("phaser.render.line.geometry")
      .with(Line, VGameObject)
      .phase(ON_STORE)
      .update(Line, [VGameObject], (_entity, line, [vgo]) => {
        if (vgo === undefined) {
          return;
        }
        const obj = vgo.obj as LineObject;
        obj.setTo(...linePoints(coords, line));
        obj.setOrigin(0, 0);
      });
  }
}
