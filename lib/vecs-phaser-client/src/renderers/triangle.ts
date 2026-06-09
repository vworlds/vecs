import { Triangle } from "@vworlds/vecs-phaser";

import type { RenderContext, RenderSystemInstaller } from "../render_context.js";
import {
  applyInitialComponents,
  destroyMappedGameObject,
  getMappedGameObject,
  initialPosition,
  pinVertexOrigin,
  type VertexGameObject,
} from "./utils.js";

export const installTriangleRenderer: RenderSystemInstaller = (ctx: RenderContext): void => {
  const system = ctx.world
    .system("phaser.render.triangle")
    .with(Triangle)
    .enter([Triangle], (entity, [triangle]) => {
      const [x, y] = initialPosition(ctx, entity);
      const obj = ctx.scene.add.triangle(
        x,
        y,
        ...triangleCoordinates(ctx, triangle)
      ) as unknown as VertexGameObject;
      pinVertexOrigin(obj);
      ctx.setGameObject(entity.eid, obj);
      applyInitialComponents(ctx, entity, obj);
    })
    .update(Triangle, (entity, triangle) => {
      getMappedGameObject<VertexGameObject>(ctx, entity.eid)?.setTo(
        ...triangleCoordinates(ctx, triangle)
      );
    })
    .exit((entity) => destroyMappedGameObject(ctx, entity.eid));

  ctx.trackSystem(system);
};

function triangleCoordinates(
  ctx: RenderContext,
  triangle: Triangle
): readonly [number, number, number, number, number, number] {
  return [
    ctx.coords.rx(triangle.x1),
    ctx.coords.ry(triangle.y1),
    ctx.coords.rx(triangle.x2),
    ctx.coords.ry(triangle.y2),
    ctx.coords.rx(triangle.x3),
    ctx.coords.ry(triangle.y3),
  ];
}
