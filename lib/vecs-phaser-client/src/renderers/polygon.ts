import { Polygon } from "@vworlds/vecs-phaser";
import type Phaser from "phaser";

import type { RenderContext } from "../render_context.js";
import {
  applyInitialComponents,
  applyVertexOrigin,
  boundsFromFlatPoints,
  type RenderObject,
} from "./shared.js";

type PolygonObject = Phaser.GameObjects.Polygon & RenderObject;

export function installPolygonRenderer(ctx: RenderContext): void {
  const system = ctx.world
    .system("RenderPolygon")
    .with(Polygon)
    .enter((entity) => {
      const polygon = entity.get(Polygon);
      if (!polygon) {
        return;
      }

      const points = polygonPoints(ctx, polygon);
      const obj = ctx.scene.add.polygon(0, 0, points) as PolygonObject;
      applyVertexOrigin(obj, boundsFromFlatPoints(points));
      ctx.setGameObject(entity.eid, obj);
      applyInitialComponents(ctx, entity, obj);
    })
    .update(Polygon, (entity, polygon) => {
      const obj = ctx.getGameObject(entity.eid) as PolygonObject | undefined;
      if (!obj) {
        return;
      }
      const points = polygonPoints(ctx, polygon);
      obj.setTo(points);
      applyVertexOrigin(obj, boundsFromFlatPoints(points));
    })
    .exit((entity) => {
      const obj = ctx.getGameObject(entity.eid);
      if (!obj) {
        return;
      }
      obj.destroy();
      ctx.deleteGameObject(entity.eid);
    });

  ctx.trackSystem(system);
}

function polygonPoints(ctx: RenderContext, polygon: Polygon): number[] {
  const points: number[] = [];
  for (let i = 0; i < polygon.points.length; i += 2) {
    points.push(ctx.coords.rx(polygon.points[i] ?? 0), ctx.coords.ry(polygon.points[i + 1] ?? 0));
  }
  return points;
}
