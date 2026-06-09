import { Rectangle } from "@vworlds/vecs-phaser";
import type Phaser from "phaser";

import type { RenderContext } from "../render_context.js";
import { applyInitialComponents, type RenderObject } from "./shared.js";

type RectangleObject = Phaser.GameObjects.Rectangle & RenderObject;

export function installRectangleRenderer(ctx: RenderContext): void {
  const system = ctx.world
    .system("RenderRectangle")
    .with(Rectangle)
    .enter((entity) => {
      const rectangle = entity.get(Rectangle);
      if (!rectangle) {
        return;
      }

      const obj = ctx.scene.add.rectangle(
        0,
        0,
        ctx.coords.len(rectangle.width),
        ctx.coords.len(rectangle.height)
      ) as RectangleObject;
      ctx.setGameObject(entity.eid, obj);
      applyInitialComponents(ctx, entity, obj);
    })
    .update(Rectangle, (entity, rectangle) => {
      const obj = ctx.getGameObject(entity.eid) as RectangleObject | undefined;
      if (!obj) {
        return;
      }
      obj.setSize(ctx.coords.len(rectangle.width), ctx.coords.len(rectangle.height));
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
