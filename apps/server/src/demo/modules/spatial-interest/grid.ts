import { type ComponentClass, type QueryDSL, Relationship } from "@vworlds/vecs";
import { Position as RenderPosition } from "@vworlds/vecs-phaser";
import {
  GRID_CELL_COUNT,
  GRID_CELL_HEIGHT,
  GRID_CELL_WIDTH,
  GRID_COLUMNS,
  GRID_ROWS,
  WORLD_MAX_X,
  WORLD_MAX_Y,
  WORLD_MIN_X,
  WORLD_MIN_Y,
} from "../../config.js";
import { clamp, randomFloat } from "../../math.js";

export class InCell extends Relationship {}

export const cellTagComponents: ComponentClass[] = Array.from(
  { length: GRID_CELL_COUNT },
  () => class CellTag {}
);

export function createCellViewDSL(cellIndex: number): QueryDSL {
  return { target: [InCell, cellTagComponents[cellIndex]!] } as QueryDSL;
}

export function forEachNearbyCell(
  position: RenderPosition,
  visit: (cellIndex: number) => void
): void {
  const column = gridColumn(position.x);
  const row = gridRow(position.y);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = row + dr;
      const c = column + dc;
      if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLUMNS) {
        continue;
      }
      visit(r * GRID_COLUMNS + c);
    }
  }
}

export function getGridCellIndex(position: Pick<RenderPosition, "x" | "y">): number {
  return gridRow(position.y) * GRID_COLUMNS + gridColumn(position.x);
}

export function randomPointInCell(cellIndex: number, margin: number): { x: number; y: number } {
  const column = cellIndex % GRID_COLUMNS;
  const row = Math.floor(cellIndex / GRID_COLUMNS);
  return {
    x: randomFloat(
      WORLD_MIN_X + column * GRID_CELL_WIDTH + margin,
      WORLD_MIN_X + (column + 1) * GRID_CELL_WIDTH - margin
    ),
    y: randomFloat(
      WORLD_MIN_Y + row * GRID_CELL_HEIGHT + margin,
      WORLD_MIN_Y + (row + 1) * GRID_CELL_HEIGHT - margin
    ),
  };
}

function gridColumn(x: number): number {
  return clampGridIndex(
    Math.floor(
      (clamp(x, WORLD_MIN_X, WORLD_MAX_X - Number.EPSILON) - WORLD_MIN_X) / GRID_CELL_WIDTH
    ),
    GRID_COLUMNS
  );
}

function gridRow(y: number): number {
  return clampGridIndex(
    Math.floor(
      (clamp(y, WORLD_MIN_Y, WORLD_MAX_Y - Number.EPSILON) - WORLD_MIN_Y) / GRID_CELL_HEIGHT
    ),
    GRID_ROWS
  );
}

function clampGridIndex(value: number, size: number): number {
  return Math.min(Math.max(value, 0), size - 1);
}
