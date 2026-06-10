import type { Entity } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  Arc,
  FillStyle,
  phaserNetworkComponents,
  Position,
  Rectangle,
  Size,
} from "@vworlds/vecs-phaser";
import Phaser from "phaser";
import { describe, expect, it } from "vitest";

import * as m from "../src/markers.js";
import { PhaserRenderModule } from "../src/index.js";
import { createMockScene, type MockGameObject, type MockScene } from "./mock_phaser.js";

describe("PhaserRenderModule integration", () => {
  it("initializes a newly entered renderable from pre-present components", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Position, { x: 2, y: -1 });
    entity.set(FillStyle, { alpha: 0.4, color: 0x336699 });
    entity.set(Arc, { radius: 0.5 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    expect(obj.kind).toBe("arc");
    expect(entity.get(Phaser.GameObjects.Arc)).toBe(obj);
    expect(entity.get(m.GameObject)).toBe(obj);
    expect(methods(obj, "setPosition")).toContainEqual([640, 448]);
    expect(methods(obj, "setFillStyle")).toContainEqual([0x336699, 0.4]);
  });

  it("recreates the component-stored object when the renderable type changes", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Position, { x: 0.25, y: 0.5 });
    entity.set(FillStyle, { alpha: 0.75, color: 0xffcc00 });
    entity.set(Arc, { radius: 0.25 });
    world.progress(0, 0);

    const arc = scene.created[0]!;
    expect(entity.get(Phaser.GameObjects.Arc)).toBe(arc);

    entity.remove(Arc);
    entity.add(Rectangle).set(Size, { height: 0.5, width: 1.5 });
    world.progress(1, 0);

    const rectangle = scene.created[1]!;
    expect(arc.destroyed).toBe(true);
    expect(rectangle.kind).toBe("rectangle");
    expect(rectangle.destroyed).toBe(false);
    expect(entity.get(Phaser.GameObjects.Arc)).toBeUndefined();
    expect(entity.get(Phaser.GameObjects.Rectangle)).toBe(rectangle);
    expect(entity.get(m.GameObject)).toBe(rectangle);
    expect(methods(rectangle, "setPosition")).toContainEqual([528, 352]);
    expect(methods(rectangle, "setFillStyle")).toContainEqual([0xffcc00, 0.75]);
    expect(liveObjects(scene)).toEqual([rectangle]);
  });

  it("evicts the previous concrete object when another shape object is attached", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    entity.set(Arc, { radius: 0.5 });
    world.progress(0, 0);

    const arc = scene.created[0]!;
    const rectangle = scene.add.rectangle(0, 0, 10, 20);
    entity.attach(rectangle);

    expect(arc.destroyed).toBe(true);
    expect(methods(arc, "destroy")).toHaveLength(1);
    expect(rectangle.destroyed).toBe(false);
    expect(entity.has(Phaser.GameObjects.Arc)).toBe(false);
    expect(entity.get(Phaser.GameObjects.Rectangle)).toBe(rectangle);
    expect(entity.get(m.GameObject)).toBe(rectangle);
  });

  it("destroys GameObjects on entity destroy and rebuilds on re-enter", () => {
    const { scene, world } = setup();
    const entity = world.entity();

    setArcEntity(entity, { x: -1, y: 1 }, { alpha: 1, color: 0x00ff00 }, { radius: 0.2 });
    world.progress(0, 0);

    const initialArc = scene.created[0]!;
    expect(entity.get(Phaser.GameObjects.Arc)).toBe(initialArc);

    entity.destroy();
    world.progress(1, 0);

    expect(initialArc.destroyed).toBe(true);
    expect(methods(initialArc, "destroy")).toHaveLength(1);
    expect(liveObjects(scene)).toEqual([]);

    const rebuiltEntity = world.entity();
    setArcEntity(rebuiltEntity, { x: -2, y: 0 }, { alpha: 0.8, color: 0x111111 }, { radius: 0.4 });
    world.progress(2, 0);

    const rebuiltArc = scene.created[1]!;
    expect(rebuiltArc).not.toBe(initialArc);
    expect(rebuiltArc.destroyed).toBe(false);
    expect(rebuiltEntity.get(Phaser.GameObjects.Arc)).toBe(rebuiltArc);
    expect(liveObjects(scene)).toEqual([rebuiltArc]);
  });

  it("clearAllEntities destroys GameObjects immediately through concrete removal", () => {
    const { scene, world } = setup();
    const arcEntity = world.entity();
    const rectangleEntity = world.entity();

    setArcEntity(arcEntity, { x: -1, y: 1 }, { alpha: 1, color: 0x00ff00 }, { radius: 0.2 });
    setRectangleEntity(
      rectangleEntity,
      { x: 1, y: -1 },
      { alpha: 0.5, color: 0x0000ff },
      { height: 0.25, width: 0.75 }
    );
    world.progress(0, 0);

    const initialArc = scene.created[0]!;
    const initialRectangle = scene.created[1]!;

    world.clearAllEntities();

    expect(initialArc.destroyed).toBe(true);
    expect(initialRectangle.destroyed).toBe(true);
    expect(methods(initialArc, "destroy")).toHaveLength(1);
    expect(methods(initialRectangle, "destroy")).toHaveLength(1);
    expect(liveObjects(scene)).toEqual([]);
  });
});

function liveObjects(scene: MockScene): readonly MockGameObject[] {
  return scene.created.filter((obj) => !obj.destroyed);
}

function methods(obj: MockGameObject, method: string): readonly (readonly unknown[])[] {
  return obj.calls.filter((call) => call.method === method).map((call) => call.args);
}

function setArcEntity(
  entity: Entity,
  position: Partial<Position>,
  fill: Partial<FillStyle>,
  arc: Partial<Arc>
): void {
  entity.set(Position, position);
  entity.set(FillStyle, fill);
  entity.set(Arc, arc);
}

function setRectangleEntity(
  entity: Entity,
  position: Partial<Position>,
  fill: Partial<FillStyle>,
  size: Partial<Size>
): void {
  entity.set(Position, position);
  entity.set(FillStyle, fill);
  entity.add(Rectangle).set(Size, size);
}

function setup(): { scene: ReturnType<typeof createMockScene>; world: ClientWorld } {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  world.module(PhaserRenderModule, { scene, pixelsPerMeter: 64 });
  return { scene, world };
}
