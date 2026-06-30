import type { Express } from "express";
import { World } from "@vworlds/vecs";
import {
  Image,
  Position as RenderPosition,
  Rotation as RenderRotation,
  Tint,
} from "@vworlds/vecs-phaser";
import type { AssetManager, TilesetAsset } from "@vworlds/vecs-phaser-server";
import {
  AngularVelocity as PhysicsAngularVelocity,
  Body,
  Box,
  LinearVelocity as PhysicsVelocity,
  Material,
  Position as PhysicsPosition,
  Rotation as PhysicsRotation,
} from "@vworlds/vecs-physics";
import { Networked } from "@vworlds/vecs-server";
import { describe, expect, it, vi } from "vitest";
import { AssetsModule } from "../../src/demo/modules/assets/module.js";
import { BrickShowcaseModule } from "../../src/demo/modules/brick-showcase/module.js";

describe("BrickShowcaseModule", () => {
  it("creates static and dynamic brick images from assets loaded by AssetsModule", () => {
    const world = new World();
    registerBrickShowcaseFoundation(world);
    const assets = createAssetManager();

    world.module(AssetsModule, {
      app: createExpressApp(),
      assets,
      worldName: "main",
    });
    world.module(BrickShowcaseModule);

    expect(countEntities(world, Image)).toBe(10);
  });
});

function registerBrickShowcaseFoundation(world: World): void {
  [
    Networked,
    Image,
    RenderPosition,
    RenderRotation,
    Tint,
    PhysicsAngularVelocity,
    Body,
    Box,
    PhysicsVelocity,
    Material,
    PhysicsPosition,
    PhysicsRotation,
  ].forEach((component) => world.component(component));
}

function createAssetManager(): AssetManager {
  return {
    getTileset: vi.fn(() => createTileset()),
    mount: vi.fn(),
  } as unknown as AssetManager;
}

function createExpressApp(): Express {
  return {
    get: vi.fn(),
    use: vi.fn(),
  } as unknown as Express;
}

function createTileset(): TilesetAsset {
  return {
    id: 7,
    tileCount: 8,
    sizeInMeters: vi.fn(() => ({ w: 0.64, h: 0.64 })),
  } as unknown as TilesetAsset;
}

function countEntities(world: World, component: typeof Image): number {
  let count = 0;
  world.filter([component]).forEach([], () => {
    count += 1;
  });
  return count;
}
