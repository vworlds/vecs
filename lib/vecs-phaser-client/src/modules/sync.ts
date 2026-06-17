import { Module, ON_STORE } from "@vworlds/vecs";
import {
  Alpha,
  Depth,
  FillStyle,
  Position,
  Rotation,
  Scale,
  Size,
  StrokeStyle,
} from "@vworlds/vecs-phaser";
import { CoordSpace } from "../coord_space.js";
import * as m from "../markers.js";

export class SyncModule extends Module<{ coords: CoordSpace }> {
  public init({ coords }: { coords: CoordSpace }): void {
    const world = this.world;

    world
      .system("phaser.sync.position")
      .with(Position, m.Transform)
      .phase(ON_STORE)
      .update({ watch: Position, onEnter: true, inject: [m.Transform] }, (_e, p, [obj]) =>
        obj.setPosition(coords.x(p.x), coords.y(p.y))
      );

    world
      .system("phaser.sync.rotation")
      .with(Rotation, m.Transform)
      .phase(ON_STORE)
      .update({ watch: Rotation, onEnter: true, inject: [m.Transform] }, (_e, r, [obj]) =>
        obj.setRotation(coords.rot(r.angle))
      );

    world
      .system("phaser.sync.scale")
      .with(Scale, m.Transform)
      .phase(ON_STORE)
      .update({ watch: Scale, onEnter: true, inject: [m.Transform] }, (_e, s, [obj]) =>
        obj.setScale(s.x, s.y)
      );

    world
      .system("phaser.sync.alpha")
      .with(Alpha, m.Alpha)
      .phase(ON_STORE)
      .update({ watch: Alpha, onEnter: true, inject: [m.Alpha] }, (_e, a, [obj]) =>
        obj.setAlpha(a.value)
      );

    world
      .system("phaser.sync.depth")
      .with(Depth, m.Depth)
      .phase(ON_STORE)
      .update({ watch: Depth, onEnter: true, inject: [m.Depth] }, (_e, d, [obj]) =>
        obj.setDepth(d.value)
      );

    world
      .system("phaser.sync.size")
      .with(Size, m.Size)
      .phase(ON_STORE)
      .update({ watch: Size, onEnter: true, inject: [m.Size] }, (_e, s, [obj]) =>
        obj.setSize(coords.len(s.width), coords.len(s.height))
      );

    world
      .system("phaser.sync.fill-style")
      .with(FillStyle, m.Fill)
      .phase(ON_STORE)
      .update({ watch: FillStyle, onEnter: true, inject: [m.Fill] }, (_e, f, [obj]) =>
        obj.setFillStyle(f.color, f.alpha)
      );

    world
      .system("phaser.sync.stroke-style")
      .with(StrokeStyle, m.Stroke)
      .phase(ON_STORE)
      .update({ watch: StrokeStyle, onEnter: true, inject: [m.Stroke] }, (_e, s, [obj]) =>
        obj.setStrokeStyle(s.width, s.color, s.alpha)
      );
  }
}
