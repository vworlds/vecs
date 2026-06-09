import type { ComponentInstance } from "@vworlds/vecs";
import type { ComponentInterpolator } from "@vworlds/vecs-client";
import {
  Alpha,
  Depth,
  FillStyle,
  phaserNetworkComponents,
  Position,
  Rotation,
  Scale,
  StrokeStyle,
} from "@vworlds/vecs-phaser";
import type Phaser from "phaser";

import type { RenderContext } from "./render_context.js";

const TWO_PI = Math.PI * 2;

type SyncGameObject = Phaser.GameObjects.GameObject & {
  setAlpha(value: number): unknown;
  setDepth(value: number): unknown;
  setFillStyle(color: number, alpha: number): unknown;
  setPosition(x: number, y: number): unknown;
  setRotation(value: number): unknown;
  setScale(x: number, y: number): unknown;
  setStrokeStyle(width: number, color: number, alpha: number): unknown;
};

/**
 * Shortest-arc angular interpolator for raw `Rotation` components.
 *
 * The returned angle stays in component/math space (radians, CCW-positive); the
 * Phaser Y-flip is still applied later by `CoordSpace.rot()` at render time.
 */
export const rotationInterpolator: ComponentInterpolator = (source, target, alpha) => {
  const sourceRotation = assertRotation(source, "source");
  const targetRotation = assertRotation(target, "target");
  const result = new Rotation();
  if (alpha === 0) {
    result.angle = sourceRotation.angle;
    return result;
  }
  if (alpha === 1) {
    result.angle = targetRotation.angle;
    return result;
  }
  const delta = shortestAngleDelta(sourceRotation.angle, targetRotation.angle);
  result.angle = normalizeAngle(sourceRotation.angle + delta * alpha);
  return result;
};

/**
 * Returns vecs-client interpolator entries for Phaser render components.
 *
 * Pass this at `ClientWorld` construction/connect time, for example:
 * `ClientWorld.connectDgram({ networkComponents: phaserNetworkComponents, interpolators: phaserInterpolators() })`.
 * Keep the runtime `interpolateRotation` option consistent with this setting.
 */
export function phaserInterpolators(options?: {
  interpolateRotation?: boolean;
}): Array<readonly [number, ComponentInterpolator]> {
  if (options?.interpolateRotation === false) {
    return [];
  }
  return [[rotationTypeId(), rotationInterpolator]];
}

export function installSyncSystems(ctx: RenderContext): void {
  ctx.trackSystem(
    ctx.world
      .system("PhaserSync:Position")
      .with(Position)
      .update(Position, (entity, position) => {
        const obj = getSyncGameObject(ctx, entity.eid);
        if (!obj) {
          return;
        }
        obj.setPosition(ctx.coords.x(position.x), ctx.coords.y(position.y));
      })
  );

  ctx.trackSystem(
    ctx.world
      .system("PhaserSync:Rotation")
      .with(Rotation)
      .update(Rotation, (entity, rotation) => {
        const obj = getSyncGameObject(ctx, entity.eid);
        if (!obj) {
          return;
        }
        obj.setRotation(ctx.coords.rot(rotation.angle));
      })
  );

  ctx.trackSystem(
    ctx.world
      .system("PhaserSync:Scale")
      .with(Scale)
      .update(Scale, (entity, scale) => {
        const obj = getSyncGameObject(ctx, entity.eid);
        if (!obj) {
          return;
        }
        obj.setScale(scale.x, scale.y);
      })
  );

  ctx.trackSystem(
    ctx.world
      .system("PhaserSync:Alpha")
      .with(Alpha)
      .update(Alpha, (entity, alpha) => {
        const obj = getSyncGameObject(ctx, entity.eid);
        if (!obj) {
          return;
        }
        obj.setAlpha(alpha.value);
      })
  );

  ctx.trackSystem(
    ctx.world
      .system("PhaserSync:Depth")
      .with(Depth)
      .update(Depth, (entity, depth) => {
        const obj = getSyncGameObject(ctx, entity.eid);
        if (!obj) {
          return;
        }
        obj.setDepth(depth.value);
      })
  );

  ctx.trackSystem(
    ctx.world
      .system("PhaserSync:FillStyle")
      .with(FillStyle)
      .update(FillStyle, (entity, fill) => {
        const obj = getSyncGameObject(ctx, entity.eid);
        if (!obj) {
          return;
        }
        obj.setFillStyle(fill.color, fill.alpha);
      })
  );

  ctx.trackSystem(
    ctx.world
      .system("PhaserSync:StrokeStyle")
      .with(StrokeStyle)
      .update(StrokeStyle, (entity, stroke) => {
        const obj = getSyncGameObject(ctx, entity.eid);
        if (!obj) {
          return;
        }
        obj.setStrokeStyle(stroke.width, stroke.color, stroke.alpha);
      })
  );
}

function assertRotation(component: ComponentInstance, label: string): Rotation {
  if (component instanceof Rotation) {
    return component;
  }
  throw new Error(`Rotation interpolator expected ${label} to be Rotation`);
}

function getSyncGameObject(ctx: RenderContext, eid: number): SyncGameObject | undefined {
  const obj = ctx.getGameObject(eid);
  return obj ? (obj as SyncGameObject) : undefined;
}

function normalizeAngle(angle: number): number {
  const normalized = angle % TWO_PI;
  return normalized < 0 ? normalized + TWO_PI : normalized;
}

function rotationTypeId(): number {
  return phaserNetworkComponents.indexOf(Rotation) + 1;
}

function shortestAngleDelta(source: number, target: number): number {
  return Math.atan2(Math.sin(target - source), Math.cos(target - source));
}
