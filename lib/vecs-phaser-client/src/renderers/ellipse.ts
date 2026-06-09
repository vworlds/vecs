import { Ellipse } from "@vworlds/vecs-phaser";

import type { RenderContext, RenderSystemInstaller } from "../render_context.js";
import {
  applyInitialComponents,
  destroyMappedGameObject,
  getMappedGameObject,
  initialPosition,
  type SizeGameObject,
} from "./utils.js";

export const installEllipseRenderer: RenderSystemInstaller = (ctx: RenderContext): void => {
  const system = ctx.world
    .system("phaser.render.ellipse")
    .with(Ellipse)
    .enter([Ellipse], (entity, [ellipse]) => {
      const [x, y] = initialPosition(ctx, entity);
      const obj = ctx.scene.add.ellipse(
        x,
        y,
        ctx.coords.len(ellipse.width),
        ctx.coords.len(ellipse.height)
      ) as unknown as SizeGameObject;
      ctx.setGameObject(entity.eid, obj);
      applyInitialComponents(ctx, entity, obj);
    })
    .update(Ellipse, (entity, ellipse) => {
      getMappedGameObject<SizeGameObject>(ctx, entity.eid)?.setSize(
        ctx.coords.len(ellipse.width),
        ctx.coords.len(ellipse.height)
      );
    })
    .exit((entity) => destroyMappedGameObject(ctx, entity.eid));

  ctx.trackSystem(system);
};
