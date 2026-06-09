import { Arc } from "@vworlds/vecs-phaser";
import type Phaser from "phaser";

import type { RenderContext } from "../render_context.js";
import { applyInitialComponents, type RenderObject } from "./shared.js";

type ArcObject = Phaser.GameObjects.Arc & RenderObject;

export function installArcRenderer(ctx: RenderContext): void {
  const system = ctx.world
    .system("RenderArc")
    .with(Arc)
    .enter((entity) => {
      const arc = entity.get(Arc);
      if (!arc) {
        return;
      }

      const obj = ctx.scene.add.arc(
        0,
        0,
        ctx.coords.len(arc.radius),
        ctx.coords.deg(arc.startAngle),
        ctx.coords.deg(arc.endAngle),
        arc.anticlockwise
      ) as ArcObject;
      obj.setIterations(arc.iterations);
      ctx.setGameObject(entity.eid, obj);
      applyInitialComponents(ctx, entity, obj);
    })
    .update(Arc, (entity, arc) => {
      const obj = ctx.getGameObject(entity.eid) as ArcObject | undefined;
      if (!obj) {
        return;
      }
      obj
        .setRadius(ctx.coords.len(arc.radius))
        .setStartAngle(ctx.coords.deg(arc.startAngle), arc.anticlockwise)
        .setEndAngle(ctx.coords.deg(arc.endAngle), arc.anticlockwise)
        .setIterations(arc.iterations);
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
