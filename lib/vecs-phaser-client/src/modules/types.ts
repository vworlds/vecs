import { TextAlign, type Text as TextComponent } from "@vworlds/vecs-phaser";
import type Phaser from "phaser";

export function hexColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function textAlign(value: TextAlign): "center" | "left" | "right" {
  switch (value) {
    case TextAlign.Center:
      return "center";
    case TextAlign.Right:
      return "right";
    default:
      return "left";
  }
}

export function textStyle(text: TextComponent): Phaser.Types.GameObjects.Text.TextStyle {
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
