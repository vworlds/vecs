import { Module, Singleton } from "@vworlds/vecs";
import type { Express } from "express";
import { AssetManager, type AudioAsset, type TilesetAsset } from "@vworlds/vecs-phaser-server";

/**
 * World-global handles to the loaded assets. Stored on the component entity
 * (`world.get(GameAssets)`) — server-local state, never networked; the wire
 * only ever carries the numeric asset ids.
 */
export class GameAssets {
  public arena!: TilesetAsset;
  public explosionSound!: AudioAsset;
  public fireSound!: AudioAsset;
  public bounceSound!: AudioAsset;
}

export interface AssetsModuleConfig {
  readonly app: Express;
  readonly assets: AssetManager;
  readonly worldName: string;
}

/**
 * Loads the arena tileset + sound effects by human key, stores the typed
 * handles as world-global state, and mounts the catalog + static file routes
 * on the app. Loaded first by the umbrella module so every other feature can
 * rely on `world.get(GameAssets)`.
 */
export class AssetsModule extends Module<AssetsModuleConfig> {
  public init(config: AssetsModuleConfig): void {
    const world = this.world;
    world.component(GameAssets).add(Singleton);

    config.assets.mount(config.app, config.worldName);
    world.set(GameAssets, {
      arena: config.assets.getTileset("arena"),
      bounceSound: config.assets.getAudio("bounce"),
      explosionSound: config.assets.getAudio("explosion"),
      fireSound: config.assets.getAudio("fire"),
    });
  }
}
