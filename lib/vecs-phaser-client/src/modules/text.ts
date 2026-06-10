import { Module, PRE_STORE, ON_STORE } from "@vworlds/vecs";
import type Phaser from "phaser";
import { Text as TextComponent } from "@vworlds/vecs-phaser";
import { removeGameObject, TextObject, textStyle, VGameObject } from "./types.js";

export class TextModule extends Module<{ scene: Phaser.Scene }> {
  public init(config: { scene: Phaser.Scene }): void {
    const { scene } = config;
    const world = this.world;

    world
      .system("phaser.render.text.teardown")
      .with(TextComponent, VGameObject)
      .phase(PRE_STORE)
      .exit([TextComponent, VGameObject], (entity) => removeGameObject(entity));

    world
      .system("phaser.new.text")
      .with(TextComponent)
      .without(VGameObject)
      .phase(ON_STORE)
      .enter([TextComponent], (entity, [text]) => {
        const obj = scene.add.text(0, 0, text.value, textStyle(text)) as unknown as TextObject;
        obj.setOrigin(0.5);
        entity.set(VGameObject, { obj });
      });

    world
      .system("phaser.render.text.geometry")
      .with(TextComponent, VGameObject)
      .phase(ON_STORE)
      .update(TextComponent, [VGameObject], (_entity, text, [vgo]) => {
        if (vgo === undefined) {
          return;
        }
        const obj = vgo.obj as TextObject;
        obj.setText(text.value);
        obj.setStyle(textStyle(text));
        obj.setOrigin(0.5);
      });
  }
}
