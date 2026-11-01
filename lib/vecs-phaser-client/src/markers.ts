import type Phaser from "phaser";

/**
 * Interface markers the render systems query instead of concrete Phaser classes. Declare the
 * markers a Phaser class satisfies with `world.component(Class).set(Implements, { interfaces })`;
 * every object of that class attached with `entity.attach(obj)` is then driven by the systems
 * listed on each marker. Exported from the package entry as `markers`.
 *
 * @module
 */

/** Any attached Phaser object; its remove hook destroys the object when the entity loses it. */
export abstract class GameObject {
  public abstract destroy(): void;
}

/**
 * Phaser primitive shapes; implies `GameObject`, `Transform`, `Alpha`, `Depth`, `Fill` and
 * `Stroke`.
 */
export abstract class Shape {}

/**
 * Driven by `phaser.sync.position`, `phaser.sync.rotation`, `phaser.sync.scale` and
 * `phaser.sync.offset`.
 */
export abstract class Transform {
  public abstract setPosition(x: number, y: number): this;
  public abstract setRotation(radians: number): this;
  public abstract setScale(x: number, y?: number): this;
}

/** Driven by `phaser.sync.alpha` from the `Alpha` component. */
export abstract class Alpha {
  public abstract setAlpha(value: number): this;
}

/** Driven by `phaser.sync.depth` from the `Depth` component. */
export abstract class Depth {
  public abstract setDepth(value: number): this;
}

/** Driven by `phaser.sync.fill-style` from the `FillStyle` component. */
export abstract class Fill {
  public abstract setFillStyle(color: number, alpha?: number): this;
}

/** Driven by `phaser.sync.stroke-style` from the `StrokeStyle` component. */
export abstract class Stroke {
  public abstract setStrokeStyle(lineWidth: number, color: number, alpha?: number): this;
}

/**
 * Driven by `phaser.sync.open-path`: the `OpenPath` tag opens the stroke, removing it closes the
 * stroke.
 */
export abstract class OpenPath {
  public abstract setClosePath(value: boolean): this;
}

/** Driven by `phaser.sync.size` from the `Size` component, converted to pixels. */
export abstract class Size {
  public abstract setSize(width: number, height: number): this;
}

/** Driven by the `Arc` geometry system. */
export abstract class Arc {
  public abstract setEndAngle(degrees: number, anticlockwise?: boolean): this;
  public abstract setIterations(iterations: number): this;
  public abstract setRadius(radius: number): this;
  public abstract setStartAngle(degrees: number, anticlockwise?: boolean): this;
}

/** Driven by the `Line`, `Polygon` and `Triangle` geometry systems. */
export abstract class Vertices {
  public abstract setTo(...coordinates: readonly (number | readonly number[])[]): this;
}

/** Driven by the `Star` geometry system. */
export abstract class Star {
  public abstract setInnerRadius(value: number): this;
  public abstract setOuterRadius(value: number): this;
  public abstract setPoints(points: number): this;
}

/** Driven by the `Text` content system. */
export abstract class Text {
  public abstract setStyle(style: Phaser.Types.GameObjects.Text.TextStyle): this;
  public abstract setText(value: string): this;
}

/** Driven by the `Image` texture and display-size systems, so it needs the `Image` component. */
export abstract class Texture {
  public abstract setTexture(key: string, frame?: string | number): this;
  public abstract setDisplaySize(width: number, height: number): this;
}

/** Driven by `phaser.sync.tint` from the `Tint` component. */
export abstract class Tint {
  public abstract setTint(
    topLeft?: number,
    topRight?: number,
    bottomLeft?: number,
    bottomRight?: number
  ): this;
}
