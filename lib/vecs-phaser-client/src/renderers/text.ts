import { Text as TextComponent } from "@vworlds/vecs-phaser";
import type Phaser from "phaser";

import type { RenderContext } from "../render_context.js";
import { applyInitialComponents, hexColor, textAlign, type RenderObject } from "./shared.js";

type TextObject = Phaser.GameObjects.Text & RenderObject;

export function installTextRenderer(ctx: RenderContext): void {
  const system = ctx.world
    .system("RenderText")
    .with(TextComponent)
    .enter((entity) => {
      const text = entity.get(TextComponent);
      if (!text) {
        return;
      }

      const obj = ctx.scene.add.text(0, 0, text.value, textStyle(text)) as TextObject;
      obj.setOrigin(0.5);
      ctx.setGameObject(entity.eid, obj);
      applyInitialComponents(ctx, entity, obj);
    })
    .update(TextComponent, (entity, text) => {
      const obj = ctx.getGameObject(entity.eid) as TextObject | undefined;
      if (!obj) {
        return;
      }
      obj.setText(text.value);
      obj.setStyle(textStyle(text));
      obj.setOrigin(0.5);
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

function textStyle(text: TextComponent): Phaser.Types.GameObjects.Text.TextStyle {
  const style: Phaser.Types.GameObjects.Text.TextStyle = {
    align: textAlign(text.align),
    color: hexColor(text.color),
    fontFamily: text.fontFamily,
    fontSize: text.fontSize,
  };
  if (text.backgroundAlpha > 0) {
    style.backgroundColor = hexColor(text.backgroundColor);
  }
  return style;
}
