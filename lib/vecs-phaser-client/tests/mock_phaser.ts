import Phaser from "phaser";

type ComponentType = abstract new (...args: any[]) => object;

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export class MockGameObject {
  readonly calls: RecordedCall[] = [];
  destroyed = false;

  constructor(
    readonly kind: string = "gameObject",
    readonly createArgs: readonly unknown[] = [],
    ComponentClass: ComponentType = MockGameObject
  ) {
    Object.defineProperty(this, "constructor", { value: ComponentClass });
  }

  destroy(): void {
    this.destroyed = true;
    this.record("destroy");
  }

  setAlpha(...args: readonly unknown[]): this {
    return this.record("setAlpha", ...args);
  }

  setDepth(...args: readonly unknown[]): this {
    return this.record("setDepth", ...args);
  }

  setFillStyle(...args: readonly unknown[]): this {
    return this.record("setFillStyle", ...args);
  }

  setInnerRadius(...args: readonly unknown[]): this {
    return this.record("setInnerRadius", ...args);
  }

  setDisplayOrigin(...args: readonly unknown[]): this {
    return this.record("setDisplayOrigin", ...args);
  }

  setDisplaySize(...args: readonly unknown[]): this {
    return this.record("setDisplaySize", ...args);
  }

  setOrigin(...args: readonly unknown[]): this {
    return this.record("setOrigin", ...args);
  }

  setPosition(...args: readonly unknown[]): this {
    return this.record("setPosition", ...args);
  }

  setRotation(...args: readonly unknown[]): this {
    return this.record("setRotation", ...args);
  }

  setPoints(...args: readonly unknown[]): this {
    return this.record("setPoints", ...args);
  }

  setOuterRadius(...args: readonly unknown[]): this {
    return this.record("setOuterRadius", ...args);
  }

  setScale(...args: readonly unknown[]): this {
    return this.record("setScale", ...args);
  }

  setEndAngle(...args: readonly unknown[]): this {
    return this.record("setEndAngle", ...args);
  }

  setIterations(...args: readonly unknown[]): this {
    return this.record("setIterations", ...args);
  }

  setRadius(...args: readonly unknown[]): this {
    return this.record("setRadius", ...args);
  }

  setSize(...args: readonly unknown[]): this {
    return this.record("setSize", ...args);
  }

  setStartAngle(...args: readonly unknown[]): this {
    return this.record("setStartAngle", ...args);
  }

  setStyle(...args: readonly unknown[]): this {
    return this.record("setStyle", ...args);
  }

  setText(...args: readonly unknown[]): this {
    return this.record("setText", ...args);
  }

  setStrokeStyle(...args: readonly unknown[]): this {
    return this.record("setStrokeStyle", ...args);
  }

  setTexture(...args: readonly unknown[]): this {
    return this.record("setTexture", ...args);
  }

  setTo(...args: readonly unknown[]): this {
    return this.record("setTo", ...args);
  }

  protected record(method: string, ...args: readonly unknown[]): this {
    this.calls.push({ method, args });
    return this;
  }
}

export interface MockSceneAdd {
  arc: (...args: readonly unknown[]) => MockGameObject;
  ellipse: (...args: readonly unknown[]) => MockGameObject;
  image: (...args: readonly unknown[]) => MockGameObject;
  line: (...args: readonly unknown[]) => MockGameObject;
  polygon: (...args: readonly unknown[]) => MockGameObject;
  rectangle: (...args: readonly unknown[]) => MockGameObject;
  star: (...args: readonly unknown[]) => MockGameObject;
  text: (...args: readonly unknown[]) => MockGameObject;
  triangle: (...args: readonly unknown[]) => MockGameObject;
}

export class MockScene {
  readonly add: MockSceneAdd = {
    arc: (...args) => this.create("arc", Phaser.GameObjects.Arc, args),
    ellipse: (...args) => this.create("ellipse", Phaser.GameObjects.Ellipse, args),
    image: (...args) => this.create("image", Phaser.GameObjects.Image, args),
    line: (...args) => this.create("line", Phaser.GameObjects.Line, args),
    polygon: (...args) => this.create("polygon", Phaser.GameObjects.Polygon, args),
    rectangle: (...args) => this.create("rectangle", Phaser.GameObjects.Rectangle, args),
    star: (...args) => this.create("star", Phaser.GameObjects.Star, args),
    text: (...args) => this.create("text", Phaser.GameObjects.Text, args),
    triangle: (...args) => this.create("triangle", Phaser.GameObjects.Triangle, args),
  };
  readonly created: MockGameObject[] = [];
  readonly scale: { width: number; height: number };

  constructor(width: number = 1024, height: number = 768) {
    this.scale = { width, height };
  }

  create(
    kind: string,
    ComponentClass: ComponentType,
    args: readonly unknown[] = []
  ): MockGameObject {
    const obj = new MockGameObject(kind, args, ComponentClass);
    this.created.push(obj);
    return obj;
  }
}

export function createMockScene(width?: number, height?: number): MockScene & Phaser.Scene {
  return new MockScene(width, height) as MockScene & Phaser.Scene;
}
