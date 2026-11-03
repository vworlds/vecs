import { Implements, PRE_STORE } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  Alpha,
  Depth,
  phaserNetworkComponents,
  Position,
  Rotation,
  Tint,
} from "@vworlds/vecs-phaser";
import Phaser from "phaser";
import { describe, expect, it } from "vitest";

import { markers, PhaserRenderModule } from "../src/index.js";
import { createMockScene, MockGameObject, type RecordedCall } from "./mock_phaser.js";

// A game-owned Phaser class the package knows nothing about, such as a sprite drawn from a
// texture the scene painted at runtime.
class PaintedShip extends MockGameObject {
  constructor() {
    super("painted-ship", [], PaintedShip);
  }
}

class Ship {
  accent = 0;
}

describe("Phaser objects attached by the game", () => {
  it("drives a Sprite created outside the package through the built-in declaration", () => {
    const { scene, world } = setup();
    const sprite = new Phaser.GameObjects.Sprite(scene, 0, 0, "painted:ship:red");
    const entity = world.entity().attach(sprite);

    entity.set(Position, { x: 1.5, y: -2 });
    entity.set(Rotation, { angle: Math.PI / 4 });
    entity.set(Alpha, { value: 0.4 });
    entity.set(Depth, { value: 9 });
    entity.set(Tint, { value: 0xff8800 } as Partial<Tint>);
    world.progress(0, 0);

    const obj = sprite as unknown as MockGameObject;
    expect(entity.get(markers.Transform)).toBe(sprite);
    expectCall(obj, "setPosition", [608, 512]);
    expectCall(obj, "setRotation", [-Math.PI / 4]);
    expectCall(obj, "setAlpha", [0.4]);
    expectCall(obj, "setDepth", [9]);
    expectCall(obj, "setTint", [0xff8800, 0xff8800, 0xff8800, 0xff8800]);

    obj.calls.length = 0;
    entity.set(Position, { x: -1, y: 1 });
    entity.set(Rotation, { angle: 0 });
    world.progress(1, 0);

    expectCall(obj, "setPosition", [448, 320]);
    expectCall(obj, "setRotation", [-0]);
  });

  it("syncs a Sprite that a game system attaches before ON_STORE in the same tick", () => {
    const { scene, world } = setup();
    world.component(Ship);
    world
      .system("ship.sprite")
      .with(Ship)
      .without(Phaser.GameObjects.Sprite)
      .phase(PRE_STORE)
      .enter([Ship], (entity, [ship]) => {
        entity.attach(new Phaser.GameObjects.Sprite(scene, 0, 0, `ship:${ship.accent}`));
      });
    const entity = world.entity().set(Ship, { accent: 2 });
    entity.set(Position, { x: 1, y: 1 });
    entity.set(Depth, { value: 4 });
    world.progress(0, 0);

    const sprite = entity.get(Phaser.GameObjects.Sprite) as unknown as MockGameObject;
    expect(sprite.createArgs).toEqual([0, 0, "ship:2"]);
    expectCall(sprite, "setPosition", [576, 320]);
    expectCall(sprite, "setDepth", [4]);
  });

  it("drives a game class that declares its interfaces with the exported markers", () => {
    const { world } = setup();
    world.component(PaintedShip).set(Implements, {
      interfaces: [markers.GameObject, markers.Transform, markers.Alpha, markers.Depth],
    });
    const ship = new PaintedShip();
    const entity = world.entity().attach(ship);

    entity.set(Position, { x: 0, y: 0 });
    entity.set(Rotation, { angle: Math.PI / 2 });
    entity.set(Alpha, { value: 0.5 });
    entity.set(Depth, { value: 3 });
    world.progress(0, 0);

    expectCall(ship, "setPosition", [512, 384]);
    expectCall(ship, "setRotation", [-Math.PI / 2]);
    expectCall(ship, "setAlpha", [0.5]);
    expectCall(ship, "setDepth", [3]);
  });

  it("leaves interfaces the game did not declare unsynced", () => {
    const { world } = setup();
    world.component(PaintedShip).set(Implements, {
      interfaces: [markers.GameObject, markers.Transform],
    });
    const ship = new PaintedShip();
    const entity = world.entity().attach(ship);

    entity.set(Position, { x: 0, y: 0 });
    entity.set(Alpha, { value: 0.5 });
    world.progress(0, 0);

    expectCall(ship, "setPosition", [512, 384]);
    expect(ship.calls.some((call) => call.method === "setAlpha")).toBe(false);
  });

  it("destroys an attached object when its entity is destroyed", () => {
    const { scene, world } = setup();
    const sprite = new Phaser.GameObjects.Sprite(scene, 0, 0, "painted:ship:red");
    const entity = world.entity().attach(sprite);
    world.progress(0, 0);

    entity.destroy();
    world.progress(1, 0);

    expect((sprite as unknown as MockGameObject).isDestroyed).toBe(true);
  });
});

function setup(): { scene: ReturnType<typeof createMockScene>; world: ClientWorld } {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  world.module(PhaserRenderModule, { scene, pixelsPerMeter: 64 });
  return { scene, world };
}

function expectCall(obj: MockGameObject, method: string, args: readonly unknown[]): void {
  expect(obj.calls).toContainEqual({ method, args } satisfies RecordedCall);
}
