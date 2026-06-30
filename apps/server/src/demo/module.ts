import type { Express } from "express";
import { Module } from "@vworlds/vecs";
import type { AssetManager } from "@vworlds/vecs-phaser-server";
import { ArenaModule } from "./modules/arena/module.js";
import { AssetsModule } from "./modules/assets/module.js";
import { BallsModule } from "./modules/balls/module.js";
import { BrickShowcaseModule } from "./modules/brick-showcase/module.js";
import { DecorationShowcaseModule } from "./modules/decoration-showcase/module.js";
import { JointShowcaseModule } from "./modules/joint-showcase/module.js";
import { LocalOffsetsModule } from "./modules/local-offsets/module.js";
import { PlayerBallCollectionModule } from "./modules/player-ball-collection/module.js";
import { PlayersModule } from "./modules/players/module.js";
import { SpatialInterestModule } from "./modules/spatial-interest/module.js";

export interface DemoModuleConfig {
  app: Express;
  assets: AssetManager;
  worldName: string;
}

export class DemoModule extends Module<DemoModuleConfig> {
  public init(config: DemoModuleConfig): void {
    const world = this.world;

    world.module(AssetsModule, config);

    // Interactive demo.
    world.module(ArenaModule);
    world.module(PlayersModule);
    world.module(PlayerBallCollectionModule);
    world.module(BallsModule);

    // Independent showcases. Comment out any line here to disable that slice.
    world.module(DecorationShowcaseModule);

    // Shared demo plumbing. Local offsets register first so child positions are
    // current before spatial interest assigns cells and views in PRE_STORE.
    world.module(LocalOffsetsModule);
    world.module(SpatialInterestModule);

    world.module(BrickShowcaseModule);
    world.module(JointShowcaseModule);
  }
}
