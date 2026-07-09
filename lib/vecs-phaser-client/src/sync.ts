import type { ComponentInstance } from "@vworlds/vecs";
import { interpolatePosition, type ComponentInterpolator } from "@vworlds/vecs-client";
import { phaserNetworkComponents, Position, Rotation } from "@vworlds/vecs-phaser";

const TWO_PI = Math.PI * 2;

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
 * Installs `interpolatePosition` on the `Position` wire type and
 * `rotationInterpolator` on the `Rotation` wire type (looked up from
 * `phaserNetworkComponents`). Pass `interpolateRotation: false` to snap
 * rotation updates instead. Position interpolation is always installed;
 * pass an empty `interpolators` to `ClientWorld` to disable it too.
 *
 * Pass this at `ClientWorld` construction/connect time, for example:
 * `ClientWorld.connectDgram({ networkComponents: phaserNetworkComponents, interpolators: phaserInterpolators() })`.
 */
export function phaserInterpolators(options?: {
  interpolateRotation?: boolean;
}): Array<readonly [number, ComponentInterpolator]> {
  const interpolators: Array<readonly [number, ComponentInterpolator]> = [
    [positionWireType(), interpolatePosition],
  ];
  if (options?.interpolateRotation === false) {
    return interpolators;
  }
  interpolators.push([rotationWireType(), rotationInterpolator]);
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

function positionWireType(): number {
  return phaserNetworkComponents.indexOf(Position) + 1;
}

function rotationWireType(): number {
  return phaserNetworkComponents.indexOf(Rotation) + 1;
}

function shortestAngleDelta(source: number, target: number): number {
  return Math.atan2(Math.sin(target - source), Math.cos(target - source));
}
