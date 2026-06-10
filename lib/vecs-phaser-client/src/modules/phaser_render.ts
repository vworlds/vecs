import { Module } from "@vworlds/vecs";
import type Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { VGameObject } from "./types.js";
import { ArcModule } from "./arc.js";
import { EllipseModule } from "./ellipse.js";
import { LineModule } from "./line.js";
import { PolygonModule } from "./polygon.js";
import { RectangleModule } from "./rectangle.js";
import { StarModule } from "./star.js";
import { TextModule } from "./text.js";
import { TriangleModule } from "./triangle.js";
import { SyncModule } from "./sync.js";

export interface PhaserRenderModuleConfig {
  readonly scene: Phaser.Scene;
  readonly pixelsPerMeter?: number;
}

export class PhaserRenderModule extends Module<PhaserRenderModuleConfig> {
  public init(config: PhaserRenderModuleConfig): void {
    const coords = new CoordSpace(config.scene, config.pixelsPerMeter);
    const world = this.world;

    world.component(VGameObject).onRemove((_entity, vgo) => vgo.obj.destroy());

    world.module(ArcModule, { scene: config.scene, coords });
    world.module(EllipseModule, { scene: config.scene, coords });
    world.module(RectangleModule, { scene: config.scene, coords });
    world.module(PolygonModule, { scene: config.scene, coords });
    world.module(LineModule, { scene: config.scene, coords });
    world.module(TriangleModule, { scene: config.scene, coords });
    world.module(StarModule, { scene: config.scene, coords });
    world.module(TextModule, { scene: config.scene });

    world.module(SyncModule, { coords });
  }
}
