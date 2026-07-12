import { Implements, Module } from "@vworlds/vecs";
import Phaser from "phaser";
import { CoordSpace } from "../coord_space.js";
import { Catalog } from "../load_assets.js";
import * as m from "../markers.js";
import { ArcModule } from "./arc.js";
import { DisplaySetupModule } from "./display_setup.js";
import { DisplayModule } from "./display.js";
import { EllipseModule } from "./ellipse.js";
import { ImageModule } from "./image.js";
import { LineModule } from "./line.js";
import { OffsetResolveModule } from "./offset_resolve.js";
import { PolygonModule } from "./polygon.js";
import { RectangleModule } from "./rectangle.js";
import { StarModule } from "./star.js";
import { TextModule } from "./text.js";
import { TriangleModule } from "./triangle.js";
import { SyncModule } from "./sync.js";

export interface PhaserRenderModuleConfig {
  readonly catalog?: Catalog;
  readonly scene: Phaser.Scene;
  readonly pixelsPerMeter?: number;
}

export class PhaserRenderModule extends Module<PhaserRenderModuleConfig> {
  public init(config: PhaserRenderModuleConfig): void {
    const coords = new CoordSpace(config.scene, config.pixelsPerMeter);
    const world = this.world;

    [
      m.GameObject,
      m.Shape,
      m.Transform,
      m.Alpha,
      m.Depth,
      m.Fill,
      m.Stroke,
      m.Size,
      m.Arc,
      m.Vertices,
      m.Star,
      m.Text,
      m.Texture,
      m.Tint,
      m.Visible,
      m.Flip,
      m.Origin,
    ].forEach((Marker) => world.component(Marker));

    world.component(m.Shape).set(Implements, {
      interfaces: [m.GameObject, m.Transform, m.Alpha, m.Depth, m.Fill, m.Stroke, m.Visible],
    });
    world.component(Phaser.GameObjects.Arc).set(Implements, { interfaces: [m.Shape, m.Arc] });
    world.component(Phaser.GameObjects.Rectangle).set(Implements, {
      interfaces: [m.Shape, m.Size],
    });
    world.component(Phaser.GameObjects.Ellipse).set(Implements, {
      interfaces: [m.Shape, m.Size],
    });
    world.component(Phaser.GameObjects.Line).set(Implements, { interfaces: [m.Shape, m.Vertices] });
    world.component(Phaser.GameObjects.Polygon).set(Implements, {
      interfaces: [m.Shape, m.Vertices],
    });
    world.component(Phaser.GameObjects.Triangle).set(Implements, {
      interfaces: [m.Shape, m.Vertices],
    });
    world.component(Phaser.GameObjects.Star).set(Implements, { interfaces: [m.Shape, m.Star] });
    world.component(Phaser.GameObjects.Text).set(Implements, {
      interfaces: [
        m.GameObject,
        m.Transform,
        m.Alpha,
        m.Depth,
        m.Text,
        m.Tint,
        m.Visible,
        m.Flip,
        m.Origin,
      ],
    });
    world.component(Phaser.GameObjects.Image).set(Implements, {
      interfaces: [
        m.GameObject,
        m.Transform,
        m.Alpha,
        m.Depth,
        m.Texture,
        m.Tint,
        m.Visible,
        m.Flip,
        m.Origin,
      ],
    });
    // TODO: when renderers are added for Sprite, TileSprite, Video, Extern,
    // BitmapText, or Stamp, declare m.Tint on each — Phaser mixes the Tint
    // component into all of them. Primitive shapes (Arc, Ellipse, Rectangle,
    // Triangle, Polygon, Star, Line) do not have setTint and must NOT declare
    // m.Tint (adding Tint data to a shape entity is a silent no-op by design).

    world.component(m.GameObject).onRemove((_entity, obj) => obj.destroy());

    world.module(DisplaySetupModule, { scene: config.scene });
    world.module(ArcModule, { scene: config.scene, coords });
    world.module(EllipseModule, { scene: config.scene, coords });
    world.module(RectangleModule, { scene: config.scene, coords });
    world.module(PolygonModule, { scene: config.scene, coords });
    world.module(LineModule, { scene: config.scene, coords });
    world.module(TriangleModule, { scene: config.scene, coords });
    world.module(StarModule, { scene: config.scene, coords });
    world.module(TextModule, { scene: config.scene });
    world.module(ImageModule, { scene: config.scene, coords });

    world.module(DisplayModule, { scene: config.scene });
    world.module(OffsetResolveModule);

    world.module(SyncModule, { coords });
  }
}
