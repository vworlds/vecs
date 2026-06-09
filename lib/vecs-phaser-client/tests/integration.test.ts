import type { Entity } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import { Arc, FillStyle, phaserNetworkComponents, Position, Rectangle } from "@vworlds/vecs-phaser";
import { describe, expect, it } from "vitest";

import { PhaserVecsRuntime } from "../src/runtime.js";
import { createMockScene, type MockGameObject, type MockScene } from "./mock_phaser.js";

function setup() {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(1024, 768);
  const runtime = new PhaserVecsRuntime({ world, scene, pixelsPerMeter: 64 });
  runtime.start();
  return { runtime, scene, world };
}

function methods(obj: MockGameObject, method: string): readonly (readonly unknown[])[] {
  return obj.calls.filter((call) => call.method === method).map((call) => call.args);
}

function liveObjects(scene: MockScene): readonly MockGameObject[] {
  return scene.created.filter((obj) => !obj.destroyed);
}

describe("PhaserVecsRuntime integration", () => {
  it("initializes a newly entered renderable from pre-present components", () => {
    const { runtime, scene, world } = setup();
    const entity = world.entity();

    entity.set(Position, { x: 2, y: -1 });
    entity.set(FillStyle, { alpha: 0.4, color: 0x336699 });
    entity.set(Arc, { radius: 0.5 });
    world.progress(0, 0);

    const obj = scene.created[0]!;
    expect(obj.kind).toBe("arc");
    expect(runtime.getGameObject(entity.eid)).toBe(obj);
    expect(methods(obj, "setPosition")).toContainEqual([640, 448]);
    expect(methods(obj, "setFillStyle")).toContainEqual([0x336699, 0.4]);
  });

  it("recreates the mapped object when the renderable type changes", () => {
    const { runtime, scene, world } = setup();
    const entity = world.entity();

    entity.set(Position, { x: 0.25, y: 0.5 });
    entity.set(FillStyle, { alpha: 0.75, color: 0xffcc00 });
    entity.set(Arc, { radius: 0.25 });
    world.progress(0, 0);

    const arc = scene.created[0]!;
    expect(runtime.getGameObject(entity.eid)).toBe(arc);

    entity.remove(Arc);
    entity.set(Rectangle, { height: 0.5, width: 1.5 });
    world.progress(1, 0);

    const rectangle = scene.created[1]!;
    expect(arc.destroyed).toBe(true);
    expect(rectangle.kind).toBe("rectangle");
    expect(rectangle.destroyed).toBe(false);
    expect(runtime.getGameObject(entity.eid)).toBe(rectangle);
    expect(liveObjects(scene)).toEqual([rectangle]);
  });

  it("clears mapped objects on reset and rebuilds fresh objects on re-enter", () => {
    const { runtime, scene, world } = setup();
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
    expect(runtime.getGameObject(arcEntity.eid)).toBe(initialArc);
    expect(runtime.getGameObject(rectangleEntity.eid)).toBe(initialRectangle);

    world.events.emit("reset", { initial: false, fromFrame: 10, toFrame: 20 });

    expect(initialArc.destroyed).toBe(true);
    expect(initialRectangle.destroyed).toBe(true);
    expect(runtime.getGameObject(arcEntity.eid)).toBeUndefined();
    expect(runtime.getGameObject(rectangleEntity.eid)).toBeUndefined();
    expect(liveObjects(scene)).toEqual([]);

    arcEntity.remove(Arc);
    rectangleEntity.remove(Rectangle);
    world.progress(1, 0);

    setArcEntity(arcEntity, { x: -2, y: 0 }, { alpha: 0.8, color: 0x111111 }, { radius: 0.4 });
    setRectangleEntity(
      rectangleEntity,
      { x: 2, y: 0 },
      { alpha: 0.6, color: 0x222222 },
      { height: 1, width: 2 }
    );
    world.progress(2, 0);

    const rebuiltArc = scene.created[2]!;
    const rebuiltRectangle = scene.created[3]!;
    expect(rebuiltArc).not.toBe(initialArc);
    expect(rebuiltRectangle).not.toBe(initialRectangle);
    expect(rebuiltArc.destroyed).toBe(false);
    expect(rebuiltRectangle.destroyed).toBe(false);
    expect(runtime.getGameObject(arcEntity.eid)).toBe(rebuiltArc);
    expect(runtime.getGameObject(rectangleEntity.eid)).toBe(rebuiltRectangle);
    expect(liveObjects(scene)).toEqual([rebuiltArc, rebuiltRectangle]);
  });
});

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
  rectangle: Partial<Rectangle>
): void {
  entity.set(Position, position);
  entity.set(FillStyle, fill);
  entity.set(Rectangle, rectangle);
}
