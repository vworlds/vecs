import type Phaser from "phaser";

/**
 * Converts server-side meter coordinates (+y up) to Phaser world pixels (+y down).
 *
 * The server origin (0, 0) maps to a fixed pixel origin, defaulting to the scene
 * center at construction. Canvas resizing never changes this mapping; use the
 * Phaser camera to control screen placement and zoom.
 *
 * See ../README.md#coordinate-model for the coordinate model and camera setup.
 */
export class CoordSpace {
  private readonly _originX: number;
  private readonly _originY: number;
  private readonly _ppm: number;

  /**
   * Snapshot the pixel origin; later changes to scene.scale or origin are ignored.
   * @param scene Scene whose initial center supplies the default origin.
   * @param ppm Pixels per meter (default 64).
   * @param origin Fixed Phaser world-pixel position of server (0, 0).
   */
  constructor(scene: Phaser.Scene, ppm: number = 64, origin?: { x: number; y: number }) {
    this._originX = origin?.x ?? scene.scale.width / 2;
    this._originY = origin?.y ?? scene.scale.height / 2;
    this._ppm = ppm;
  }

  /** Absolute world X pixel: fixed origin x + ppm * meter-x. */
  x(mx: number): number {
    return this._originX + this._ppm * mx;
  }

  /** Absolute world Y pixel: fixed origin y - ppm * meter-y (Y flip). */
  y(my: number): number {
    return this._originY - this._ppm * my;
  }

  /** Length in pixels: ppm * meters. */
  len(m: number): number {
    return this._ppm * m;
  }

  /** Relative X pixel (no center offset): ppm * meter-x. */
  rx(mx: number): number {
    return this._ppm * mx;
  }

  /** Relative Y pixel (no center offset, Y flip): -ppm * meter-y. */
  ry(my: number): number {
    return -this._ppm * my;
  }

  /**
   * Rotation in radians for Phaser: negated to account for Y-axis flip
   * inverting handedness (math CCW+ → Phaser CW+).
   */
  rot(rad: number): number {
    return -rad;
  }

  /**
   * Rotation in degrees for Phaser arc angles: (-rad) * 180 / PI.
   */
  deg(rad: number): number {
    return (-rad * 180) / Math.PI;
  }
}
