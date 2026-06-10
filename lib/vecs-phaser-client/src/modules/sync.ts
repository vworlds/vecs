import { Module, ON_STORE, type World } from "@vworlds/vecs";
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
  public init(config: { coords: CoordSpace }): void {
    const { coords } = config;
    const world = this.world;

    registerSyncSystems(world, coords);
  }
}

function registerSyncSystems(world: World, coords: CoordSpace): void {
  world
    .system("phaser.sync.position")
    .with(Position, VGameObject)
    .phase(ON_STORE)
    .update(Position, [VGameObject], (_entity, position, [vgo]) =>
      syncPosition(coords, vgo, position)
    );

  world
    .system("phaser.sync.rotation")
    .with(Rotation, VGameObject)
    .phase(ON_STORE)
    .update(Rotation, [VGameObject], (_entity, rotation, [vgo]) =>
      syncRotation(coords, vgo, rotation)
    );

  world
    .system("phaser.sync.scale")
    .with(Scale, VGameObject)
    .phase(ON_STORE)
    .update(Scale, [VGameObject], (_entity, scale, [vgo]) => syncScale(vgo, scale));

  world
    .system("phaser.sync.alpha")
    .with(Alpha, VGameObject)
    .phase(ON_STORE)
    .update(Alpha, [VGameObject], (_entity, alpha, [vgo]) => syncAlpha(vgo, alpha));

  world
    .system("phaser.sync.depth")
    .with(Depth, VGameObject)
    .phase(ON_STORE)
    .update(Depth, [VGameObject], (_entity, depth, [vgo]) => syncDepth(vgo, depth));

  world
    .system("phaser.sync.fill-style")
    .with(FillStyle, VGameObject)
    .phase(ON_STORE)
    .update(FillStyle, [VGameObject], (_entity, fill, [vgo]) => syncFillStyle(vgo, fill));

  world
    .system("phaser.sync.stroke-style")
    .with(StrokeStyle, VGameObject)
    .phase(ON_STORE)
    .update(StrokeStyle, [VGameObject], (_entity, stroke, [vgo]) => syncStrokeStyle(vgo, stroke));
}

function syncAlpha(vgo: VGameObject, alpha: Alpha): void {
  vgo.obj.setAlpha(alpha.value);
}

function syncDepth(vgo: VGameObject, depth: Depth): void {
  vgo.obj.setDepth(depth.value);
}

function syncFillStyle(vgo: VGameObject, fill: FillStyle): void {
  vgo.obj.setFillStyle(fill.color, fill.alpha);
}

function syncPosition(coords: CoordSpace, vgo: VGameObject, position: Position): void {
  vgo.obj.setPosition(coords.x(position.x), coords.y(position.y));
}

function syncRotation(coords: CoordSpace, vgo: VGameObject, rotation: Rotation): void {
  vgo.obj.setRotation(coords.rot(rotation.angle));
}

function syncScale(vgo: VGameObject, scale: Scale): void {
  vgo.obj.setScale(scale.x, scale.y);
}

function syncStrokeStyle(vgo: VGameObject, stroke: StrokeStyle): void {
  vgo.obj.setStrokeStyle(stroke.width, stroke.color, stroke.alpha);
}
