import type { Entity } from "@vworlds/vecs";
import { Position as RenderPosition } from "@vworlds/vecs-phaser";

export function updateRenderPosition(
  entity: Entity,
  position: RenderPosition,
  x: number,
  y: number
): void {
  if (position.x === x && position.y === y) {
    return;
  }
  position.x = x;
  position.y = y;
  entity.modified(RenderPosition);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function randomFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function randomSignedFloat(min: number, max: number): number {
  const speed = randomFloat(min, max);
  return Math.random() < 0.5 ? -speed : speed;
}
