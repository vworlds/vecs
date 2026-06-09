import { Line } from "@vworlds/vecs-phaser";
import type Phaser from "phaser";

import type { RenderContext } from "../render_context.js";
import {
  applyInitialComponents,
  applyVertexOrigin,
  boundsFromFlatPoints,
  type RenderObject,
} from "./shared.js";

type LineObject = Phaser.GameObjects.Line & RenderObject;

export function installLineRenderer(ctx: RenderContext): void {
  const system = ctx.world
    .system("RenderLine")
    .with(Line)
    .enter((entity) => {
      const line = entity.get(Line);
      if (!line) {
        return;
      }

      const points = linePoints(ctx, line);
      const obj = ctx.scene.add.line(
        0,
        0,
        points[0],
        points[1],
        points[2],
        points[3]
      ) as LineObject;
      applyVertexOrigin(obj, boundsFromFlatPoints(points));
      ctx.setGameObject(entity.eid, obj);
      applyInitialComponents(ctx, entity, obj);
    })
    .update(Line, (entity, line) => {
      const obj = ctx.getGameObject(entity.eid) as LineObject | undefined;
      if (!obj) {
        return;
      }
      const points = linePoints(ctx, line);
      obj.setTo(points[0], points[1], points[2], points[3]);
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

function linePoints(ctx: RenderContext, line: Line): [number, number, number, number] {
  return [
    ctx.coords.rx(line.x1),
    ctx.coords.ry(line.y1),
    ctx.coords.rx(line.x2),
    ctx.coords.ry(line.y2),
  ];
}
