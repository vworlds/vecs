import type { ComponentInstance } from "@vworlds/vecs";
import { interpolatePosition, type ComponentInterpolator } from "@vworlds/vecs-client";
import { Position, Rotation } from "@vworlds/vecs-phaser";

const TWO_PI = Math.PI * 2;

/**
 * Shortest-arc angular interpolator for raw `Rotation` components.
 * Also exported by `@vworlds/vecs-phaser-client/headless` for use without Phaser.
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
 * Returns vecs-client interpolator entries (keyed by component class) for
 * Phaser render components: `interpolatePosition` on `Position` and
 * `rotationInterpolator` on `Rotation`. `ClientWorld` resolves each class to
 * its wire type at construction time.
 * Also exported by `@vworlds/vecs-phaser-client/headless` for use without Phaser.
 *
 * Pass `interpolateRotation: false` to snap rotation updates instead. Position
 * interpolation is always installed; pass an empty `interpolators` to
 * `ClientWorld` to disable it too.
 *
 * Pass this at `ClientWorld` construction/connect time, for example:
 * `ClientWorld.connectDgram({ networkComponents: phaserNetworkComponents, interpolators: phaserInterpolators() })`.
 */
export function phaserInterpolators(options?: {
  interpolateRotation?: boolean;
}): Array<readonly [typeof Position | typeof Rotation, ComponentInterpolator]> {
  const interpolators: Array<readonly [typeof Position | typeof Rotation, ComponentInterpolator]> =
    [[Position, interpolatePosition]];
  if (options?.interpolateRotation === false) {
    return interpolators;
  }
  interpolators.push([Rotation, rotationInterpolator]);
  return interpolators;
}

function assertRotation(component: ComponentInstance, label: string): Rotation {
  if (component instanceof Rotation) {
    return component;
  }
  throw new Error(`Rotation interpolator expected ${label} to be Rotation`);
}

function normalizeAngle(angle: number): number {
  const normalized = angle % TWO_PI;
  return normalized < 0 ? normalized + TWO_PI : normalized;
}

function shortestAngleDelta(source: number, target: number): number {
  return Math.atan2(Math.sin(target - source), Math.cos(target - source));
}
