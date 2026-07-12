import type Phaser from "phaser";

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

let nextId = 0;

class MockGameObject {
  readonly calls: RecordedCall[] = [];
  destroyed = false;
  displayList: unknown = null;
  parentContainer: unknown = null;
  readonly id: number;

  constructor(
    readonly kind: string = "gameObject",
    readonly createArgs: readonly unknown[] = [],
    ComponentClass: new (...args: any[]) => object = MockGameObject
  ) {
    this.id = nextId++;
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

  setFlip(...args: readonly unknown[]): this {
    return this.record("setFlip", ...args);
  }

  setScale(...args: readonly unknown[]): this {
    return this.record("setScale", ...args);
  }

  setScrollFactor(...args: readonly unknown[]): this {
    return this.record("setScrollFactor", ...args);
  }

  setVisible(...args: readonly unknown[]): this {
    return this.record("setVisible", ...args);
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

  setTint(...args: readonly unknown[]): this {
    return this.record("setTint", ...args);
  }

  setTo(...args: readonly unknown[]): this {
    return this.record("setTo", ...args);
  }

  protected record(method: string, ...args: readonly unknown[]): this {
    this.calls.push({ method, args });
    return this;
  }
}

function registerWithScene(scene: Phaser.Scene, obj: MockGameObject): void {
  const mockScene = scene as unknown as { created: MockGameObject[] };
  if (Array.isArray(mockScene.created)) {
    mockScene.created.push(obj);
  }
}

function makeShapeClass(
  kind: string
): new (scene: Phaser.Scene, ...args: readonly unknown[]) => MockGameObject {
  const cls = class extends MockGameObject {
    constructor(scene: Phaser.Scene, ...args: readonly unknown[]) {
      super(kind, args, cls as new (...args: any[]) => object);
      registerWithScene(scene, this);
    }
  };
  return cls;
}

class Container extends MockGameObject {
  readonly list: MockGameObject[] = [];

  constructor(scene: Phaser.Scene, _x?: number, _y?: number) {
    super("container", [], Container);
    registerWithScene(scene, this);
  }

  add(child: MockGameObject): this {
    // Remove from old parent if any (matching Phaser's exclusive behavior)
    if (child.parentContainer !== null && child.parentContainer !== this) {
      (child.parentContainer as Container).remove(child, false);
    }
    if (!this.list.includes(child)) {
      this.list.push(child);
    }
    child.parentContainer = this;
    child.displayList = this;
    return this;
  }

  remove(child: MockGameObject, _destroyChild?: boolean): this {
    const index = this.list.indexOf(child);
    if (index !== -1) {
      this.list.splice(index, 1);
    }
    child.parentContainer = null;
    child.displayList = null;
    return this;
  }

  override destroy(): void {
    // Phaser's Container.destroy() removes all children from the display list.
    // It does NOT destroy them (destroyChild defaults to false via removeAll).
    [...this.list].forEach((child) => this.remove(child, false));
    super.destroy();
  }
}

const Arc = makeShapeClass("arc");
const Ellipse = makeShapeClass("ellipse");
const Image = makeShapeClass("image");
const Line = makeShapeClass("line");
const Polygon = makeShapeClass("polygon");
const Rectangle = makeShapeClass("rectangle");
const Star = makeShapeClass("star");
const Text = makeShapeClass("text");
const Triangle = makeShapeClass("triangle");

export default {
  GameObjects: {
    Arc,
    Container,
    Ellipse,
    Image,
    Line,
    Polygon,
    Rectangle,
    Star,
    Text,
    Triangle,
  },
};

export { MockGameObject };
