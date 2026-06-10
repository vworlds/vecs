import { Module, ON_STORE } from "@vworlds/vecs";
import {
  Alpha,
  Depth,
  FillStyle,
  Position,
  Rotation,
  Scale,
  StrokeStyle,
} from "@vworlds/vecs-phaser";
import { CoordSpace } from "../coord_space.js";
import { VGameObject } from "./types.js";

export class SyncModule extends Module<{ coords: CoordSpace }> {
  public init({ coords }: { coords: CoordSpace }): void {
    const world = this.world;

    world
      .system("phaser.sync.position")
      .with(Position, VGameObject)
      .phase(ON_STORE)
      .update(Position, [VGameObject], (_e, p, [vgo]) =>
        vgo.obj.setPosition(coords.x(p.x), coords.y(p.y))
      );

    world
      .system("phaser.sync.rotation")
      .with(Rotation, VGameObject)
      .phase(ON_STORE)
      .update(Rotation, [VGameObject], (_e, r, [vgo]) => vgo.obj.setRotation(coords.rot(r.angle)));

    world
      .system("phaser.sync.scale")
      .with(Scale, VGameObject)
      .phase(ON_STORE)
      .update(Scale, [VGameObject], (_e, s, [vgo]) => vgo.obj.setScale(s.x, s.y));

    world
      .system("phaser.sync.alpha")
      .with(Alpha, VGameObject)
      .phase(ON_STORE)
      .update(Alpha, [VGameObject], (_e, a, [vgo]) => vgo.obj.setAlpha(a.value));

    world
      .system("phaser.sync.depth")
      .with(Depth, VGameObject)
      .phase(ON_STORE)
      .update(Depth, [VGameObject], (_e, d, [vgo]) => vgo.obj.setDepth(d.value));

    world
      .system("phaser.sync.fill-style")
      .with(FillStyle, VGameObject)
      .phase(ON_STORE)
      .update(FillStyle, [VGameObject], (_e, f, [vgo]) => vgo.obj.setFillStyle(f.color, f.alpha));

    world
      .system("phaser.sync.stroke-style")
      .with(StrokeStyle, VGameObject)
      .phase(ON_STORE)
      .update(StrokeStyle, [VGameObject], (_e, s, [vgo]) =>
        vgo.obj.setStrokeStyle(s.width, s.color, s.alpha)
      );
  }
}
