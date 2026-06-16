import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Triangle } from "@vworlds/vecs-phaser";
import * as m from "../markers.js";

function triangleCoordinates(
  coords: CoordSpace,
  triangle: Triangle
): readonly [number, number, number, number, number, number] {
  return [
    coords.rx(triangle.x1),
    coords.ry(triangle.y1),
    coords.rx(triangle.x2),
    coords.ry(triangle.y2),
    coords.rx(triangle.x3),
    coords.ry(triangle.y3),
  ];
}

export class TriangleModule extends Module<{ scene: Phaser.Scene; coords: CoordSpace }> {
  public init(config: { scene: Phaser.Scene; coords: CoordSpace }): void {
    const { scene, coords } = config;
    const world = this.world;

    world.component(Triangle).onRemove((entity) => {
      if (entity.has(Phaser.GameObjects.Triangle)) {
        entity.remove(Phaser.GameObjects.Triangle);
      }
    });

    world
      .system("phaser.new.triangle")
      .with(Triangle)
      .without(Phaser.GameObjects.Triangle)
      .phase(ON_STORE)
      .enter([Triangle], (entity, [triangle]) => {
        const obj = scene.add.triangle(0, 0, ...triangleCoordinates(coords, triangle));
        obj.setOrigin(0, 0);
        entity.attach(obj);
      });

    world
      .system("phaser.render.triangle.geometry")
      .with(Triangle, m.Vertices)
      .phase(ON_STORE)
      .update({ component: Triangle, inject: [m.Vertices] }, (_entity, triangle, [obj]) => {
        obj.setTo(...triangleCoordinates(coords, triangle));
      });
  }
}
