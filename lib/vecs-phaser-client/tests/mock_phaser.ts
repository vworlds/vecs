import Phaser from "phaser";

export type { RecordedCall } from "./phaser_stub.js";
export { MockGameObject } from "./phaser_stub.js";
import { MockGameObject } from "./phaser_stub.js";

type ComponentType = abstract new (...args: any[]) => object;

export interface MockSceneAdd {
  arc: (...args: readonly unknown[]) => MockGameObject;
  ellipse: (...args: readonly unknown[]) => MockGameObject;
  existing: (child: MockGameObject) => MockGameObject;
  image: (...args: readonly unknown[]) => MockGameObject;
  line: (...args: readonly unknown[]) => MockGameObject;
  polygon: (...args: readonly unknown[]) => MockGameObject;
  rectangle: (...args: readonly unknown[]) => MockGameObject;
  star: (...args: readonly unknown[]) => MockGameObject;
  text: (...args: readonly unknown[]) => MockGameObject;
  triangle: (...args: readonly unknown[]) => MockGameObject;
}

export class MockKey {
  isDown = false;
}

export class MockPointer {
  worldX = 0;
  worldY = 0;
  isDown = false;
}

export class MockKeyboard {
  private readonly _keys = new Map<string | number, MockKey>();

  addKey(ref: string | number, _enableCapture?: boolean): MockKey {
    let key = this._keys.get(ref);
    if (!key) {
      key = new MockKey();
      this._keys.set(ref, key);
    }
    return key;
  }
}

export class MockScene {
  readonly input = {
    activePointer: new MockPointer(),
    keyboard: new MockKeyboard(),
  };
  readonly add: MockSceneAdd = {
    arc: (...args) => this.create("arc", Phaser.GameObjects.Arc, args),
    ellipse: (...args) => this.create("ellipse", Phaser.GameObjects.Ellipse, args),
    existing: (child: MockGameObject) => {
      if (child.displayList === null) {
        child.displayList = this;
      }
      return child;
    },
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
    const obj = new MockGameObject(kind, args, ComponentClass as new (...args: any[]) => object);
    this.created.push(obj);
    return obj;
  }
}

export function createMockScene(width?: number, height?: number): MockScene & Phaser.Scene {
  return new MockScene(width, height) as MockScene & Phaser.Scene;
}
