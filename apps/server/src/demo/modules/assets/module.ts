import type { Express } from "express";
import { Module } from "@vworlds/vecs";
import type { AssetManager } from "@vworlds/vecs-phaser-server";
import { DemoAssets } from "./components.js";

export interface AssetsModuleConfig {
  app: Express;
  assets: AssetManager;
  worldName: string;
}

export class AssetsModule extends Module<AssetsModuleConfig> {
  public init(config: AssetsModuleConfig): void {
    const world = this.world;
    world.component(DemoAssets);

    const bricks = config.assets.getTileset("bricks");
    world.entity().set(DemoAssets, { bricks });
    config.assets.mount(config.app, config.worldName);
  }
}
