import { Module, ON_STORE } from "@vworlds/vecs";
import Phaser from "phaser";
import { Text as TextComponent } from "@vworlds/vecs-phaser";
import * as m from "../markers.js";
import { textStyle } from "./types.js";

export class TextModule extends Module<{ scene: Phaser.Scene }> {
  public init(config: { scene: Phaser.Scene }): void {
    const { scene } = config;
    const world = this.world;

    world.component(TextComponent).onRemove((entity) => {
      if (entity.has(Phaser.GameObjects.Text)) {
        entity.remove(Phaser.GameObjects.Text);
      }
    });

    world
      .system("phaser.new.text")
      .with(TextComponent)
      .without(Phaser.GameObjects.Text)
      .phase(ON_STORE)
      .enter([TextComponent], (entity, [text]) => {
        const obj = scene.add.text(0, 0, text.value, textStyle(text));
        obj.setOrigin(0.5);
        entity.attach(obj);
      });

    world
      .system("phaser.render.text.geometry")
      .with(TextComponent, m.Text)
      .phase(ON_STORE)
      .update({ watch: TextComponent, enter: true, inject: [m.Text] }, (_entity, text, [obj]) => {
        obj.setText(text.value);
        obj.setStyle(textStyle(text));
      });
  }
}
