import { Star } from "@vworlds/vecs-phaser";

import type { RenderContext, RenderSystemInstaller } from "../render_context.js";
import {
  applyInitialComponents,
  destroyMappedGameObject,
  getMappedGameObject,
  initialPosition,
  type StarGameObject,
} from "./utils.js";

export const installStarRenderer: RenderSystemInstaller = (ctx: RenderContext): void => {
  const system = ctx.world
    .system("phaser.render.star")
    .with(Star)
    .enter([Star], (entity, [star]) => {
      const [x, y] = initialPosition(ctx, entity);
      const obj = ctx.scene.add.star(
        x,
        y,
        star.points,
        ctx.coords.len(star.innerRadius),
        ctx.coords.len(star.outerRadius)
      ) as unknown as StarGameObject;
      ctx.setGameObject(entity.eid, obj);
      applyInitialComponents(ctx, entity, obj);
    })
    .update(Star, (entity, star) => {
      const obj = getMappedGameObject<StarGameObject>(ctx, entity.eid);
      if (obj === undefined) {
        return;
      }
      obj.setPoints(star.points);
      obj.setRadius(ctx.coords.len(star.innerRadius), ctx.coords.len(star.outerRadius));
    })
    .exit((entity) => destroyMappedGameObject(ctx, entity.eid));

  ctx.trackSystem(system);
};
