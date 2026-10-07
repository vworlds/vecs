import type { Entity } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  Arc,
  DrawBy,
  Ellipse,
  InheritRotation,
  Offset,
  phaserNetworkComponents,
  Position,
  Rotation,
  Size,
} from "@vworlds/vecs-phaser";
import { expect } from "vitest";

import { PhaserRenderModule } from "../../src/index.js";
import * as m from "../../src/markers.js";
import { createMockScene, type MockGameObject } from "../mock_phaser.js";

// Shared fixtures for the computed-parenting (`DrawBy` / `InheritRotation`) tests.

export const PPM = 64;
export const SCENE_WIDTH = 1024;
export const SCENE_HEIGHT = 768;
export const HALF_PI = Math.PI / 2;

export function setup(): { scene: ReturnType<typeof createMockScene>; world: ClientWorld } {
  const world = new ClientWorld({ networkComponents: phaserNetworkComponents });
  const scene = createMockScene(SCENE_WIDTH, SCENE_HEIGHT);
  world.module(PhaserRenderModule, { scene, pixelsPerMeter: PPM });
  return { scene, world };
}

/** A renderable parent at (x, y) with an optional `Rotation`. */
export function spawnParent(world: ClientWorld, x: number, y: number, angle?: number): Entity {
  const parent = world.entity().set(Position, { x, y }).set(Arc, { radius: 0.5 });
  if (angle !== undefined) {
    parent.set(Rotation, { angle });
  }
  return parent;
}

/** A `DrawBy` child of `parent`, tagged with `InheritRotation` when `tag` is given. */
export function spawnChild(
  world: ClientWorld,
  parent: Entity,
  options: {
    offset?: { x: number; y: number };
    tag?: number;
    shape?: (entity: Entity) => Entity;
  } = {}
): Entity {
  const child = world.entity();
  (options.shape ?? ellipse)(child).add(DrawBy, parent);
  if (options.offset !== undefined) {
    child.set(Offset, options.offset);
  }
  if (options.tag !== undefined) {
    child.set(InheritRotation, { angle: options.tag });
  }
  return child;
}

/** Turn an already created entity into a tagged `DrawBy` child of `parent`. */
export function tagChild(
  child: Entity,
  parent: Entity,
  offset: { x: number; y: number },
  angle: number
): void {
  ellipse(child).add(DrawBy, parent).set(Offset, offset).set(InheritRotation, { angle });
}

export function ellipse(entity: Entity): Entity {
  return entity.add(Ellipse).set(Size, { width: 0.1, height: 0.1 });
}

export function gameObjectOf(entity: Entity): MockGameObject {
  const obj = entity.get(m.GameObject);
  if (obj === undefined) {
    throw new Error(`${entity.toString()} has no GameObject`);
  }
  return obj as unknown as MockGameObject;
}

/** The component-space pose of `entity`; omitted fields are not checked. */
export function expectPose(entity: Entity, pose: { x?: number; y?: number; angle?: number }): void {
  if (pose.x !== undefined) {
    expect(entity.get(Position)?.x).toBeCloseTo(pose.x, 9);
  }
  if (pose.y !== undefined) {
    expect(entity.get(Position)?.y).toBeCloseTo(pose.y, 9);
  }
  if (pose.angle !== undefined) {
    expect(entity.get(Rotation)?.angle).toBeCloseTo(pose.angle, 9);
  }
}

/** What Phaser was told: pixels from the scene centre, +y down, and the rotation negated. */
export function expectRendered(
  obj: MockGameObject,
  pose: { x: number; y: number; angle: number }
): void {
  const position = lastCall(obj, "setPosition");
  expect(position?.[0]).toBeCloseTo(SCENE_WIDTH / 2 + PPM * pose.x, 6);
  expect(position?.[1]).toBeCloseTo(SCENE_HEIGHT / 2 - PPM * pose.y, 6);
  expect(lastCall(obj, "setRotation")?.[0]).toBeCloseTo(-pose.angle, 9);
}

export function lastCall(obj: MockGameObject, method: string): readonly unknown[] | undefined {
  const calls = methods(obj, method);
  return calls[calls.length - 1];
}

export function methods(obj: MockGameObject, method: string): readonly (readonly unknown[])[] {
  return obj.calls.filter((call) => call.method === method).map((call) => call.args);
}
