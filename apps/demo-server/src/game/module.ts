import { Module } from "@vworlds/vecs";
import type { Express } from "express";
import type { AssetManager } from "@vworlds/vecs-phaser-server";
import { ArenaModule } from "./modules/arena/module.js";
import { AssetsModule } from "./modules/assets/module.js";
import { HudModule } from "./modules/hud/module.js";
import { ShellsModule } from "./modules/shells/module.js";
import { TanksModule } from "./modules/tanks/module.js";

export interface TankArenaModuleConfig {
  readonly app: Express;
  readonly assets: AssetManager;
  readonly worldName: string;
}

/**
 * The Tank Arena game, composed of feature modules in dependency order:
 * assets first (everyone reads `GameAssets`), then the static arena, then
 * tanks (players/driving/respawn), shells (firing/impacts), and the HUD.
 */
export class TankArenaModule extends Module<TankArenaModuleConfig> {
  public init(config: TankArenaModuleConfig): void {
    const world = this.world;
    world.module(AssetsModule, config);
    world.module(ArenaModule);
    world.module(TanksModule);
    world.module(ShellsModule);
    world.module(HudModule);
  }
}
