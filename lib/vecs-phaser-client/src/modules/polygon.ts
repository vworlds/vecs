import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Polygon } from "@vworlds/vecs-phaser";
import * as m from "../markers.js";

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

    world.component(Polygon).onRemove((entity) => entity.remove(Phaser.GameObjects.Polygon));

    world
      .system("phaser.new.polygon")
      .with(Polygon)
      .without(Phaser.GameObjects.Polygon)
      .phase(ON_STORE)
      .enter([Polygon], (entity, [polygon]) => {
        const obj = scene.add.polygon(0, 0, polygonPoints(coords, polygon));
        obj.setOrigin(0, 0);
        entity.attach(obj);
      });

    world
      .system("phaser.render.polygon.geometry")
      .with(Polygon, m.Vertices)
      .phase(ON_STORE)
      .update({ watch: Polygon, inject: [m.Vertices] }, (_entity, polygon, [obj]) => {
        obj.setTo(polygonPoints(coords, polygon));
      });
  }
}
