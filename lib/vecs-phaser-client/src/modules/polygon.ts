import { Module, PRE_STORE, ON_STORE } from "@vworlds/vecs";
import type Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Polygon } from "@vworlds/vecs-phaser";
import { PolygonObject, removeGameObject, VGameObject } from "./types.js";

function polygonPoints(coords: CoordSpace, polygon: Polygon): number[] {
  const points: number[] = [];
  for (let i = 0; i < polygon.points.length; i += 2) {
    points.push(coords.rx(polygon.points[i] ?? 0), coords.ry(polygon.points[i + 1] ?? 0));
  }
  return points;
}

export class PolygonModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world
      .system("phaser.render.polygon.teardown")
      .with(Polygon, VGameObject)
      .phase(PRE_STORE)
      .exit([Polygon, VGameObject], (entity) => removeGameObject(entity));

    world
      .system("phaser.new.polygon")
      .with(Polygon)
      .without(VGameObject)
      .phase(ON_STORE)
      .enter([Polygon], (entity, [polygon]) => {
        const obj = scene.add.polygon(0, 0, polygonPoints(coords, polygon)) as PolygonObject;
        obj.setOrigin(0, 0);
        entity.set(VGameObject, { obj });
      });

    world
      .system("phaser.render.polygon.geometry")
      .with(Polygon, VGameObject)
      .phase(ON_STORE)
      .update(Polygon, [VGameObject], (_entity, polygon, [vgo]) => {
        if (vgo === undefined) {
          return;
        }
        const obj = vgo.obj as PolygonObject;
        obj.setTo(polygonPoints(coords, polygon));
        obj.setOrigin(0, 0);
      });
  }
}
