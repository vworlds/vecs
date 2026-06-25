import type Phaser from "phaser";

export abstract class GameObject {
  public abstract destroy(): void;
}

export abstract class Shape {}

export abstract class Transform {
  public abstract setPosition(x: number, y: number): this;
  public abstract setRotation(radians: number): this;
  public abstract setScale(x: number, y?: number): this;
}

export abstract class Alpha {
  public abstract setAlpha(value: number): this;
}

export abstract class Depth {
  public abstract setDepth(value: number): this;
}

export abstract class Fill {
  public abstract setFillStyle(color: number, alpha?: number): this;
}

export abstract class Stroke {
  public abstract setStrokeStyle(lineWidth: number, color: number, alpha?: number): this;
}

export abstract class Size {
  public abstract setSize(width: number, height: number): this;
}

export abstract class Arc {
  public abstract setEndAngle(degrees: number, anticlockwise?: boolean): this;
  public abstract setIterations(iterations: number): this;
  public abstract setRadius(radius: number): this;
  public abstract setStartAngle(degrees: number, anticlockwise?: boolean): this;
}

export abstract class Vertices {
  public abstract setTo(...coordinates: readonly (number | readonly number[])[]): this;
}

export abstract class Star {
  public abstract setInnerRadius(value: number): this;
  public abstract setOuterRadius(value: number): this;
  public abstract setPoints(points: number): this;
}

export abstract class Text {
  public abstract setStyle(style: Phaser.Types.GameObjects.Text.TextStyle): this;
  public abstract setText(value: string): this;
}

export abstract class Texture {
  public abstract setTexture(key: string, frame?: string | number): this;
  public abstract setDisplaySize(width: number, height: number): this;
}

export abstract class Tint {
  public abstract setTint(
    topLeft?: number,
    topRight?: number,
    bottomLeft?: number,
    bottomRight?: number
  ): this;
}
