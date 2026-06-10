import { Module, PRE_STORE, ON_STORE } from "@vworlds/vecs";
import type Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Triangle } from "@vworlds/vecs-phaser";
import { removeGameObject, TriangleObject, VGameObject } from "./types.js";

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

    world
      .system("phaser.render.triangle.teardown")
      .with(Triangle, VGameObject)
      .phase(PRE_STORE)
      .exit([Triangle, VGameObject], (entity) => removeGameObject(entity));

    world
      .system("phaser.new.triangle")
      .with(Triangle)
      .without(VGameObject)
      .phase(ON_STORE)
      .enter([Triangle], (entity, [triangle]) => {
        const obj = scene.add.triangle(
          0,
          0,
          ...triangleCoordinates(coords, triangle)
        ) as TriangleObject;
        obj.setOrigin(0, 0);
        entity.set(VGameObject, { obj });
      });

    world
      .system("phaser.render.triangle.geometry")
      .with(Triangle, VGameObject)
      .phase(ON_STORE)
      .update(Triangle, [VGameObject], (_entity, triangle, [vgo]) => {
        const obj = vgo.obj as TriangleObject;
        obj.setTo(...triangleCoordinates(coords, triangle));
        obj.setOrigin(0, 0);
      });
  }
}
