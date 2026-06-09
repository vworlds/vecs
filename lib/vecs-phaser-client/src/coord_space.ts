import type Phaser from "phaser";

/**
 * Converts between server-side meter coordinates (+y up, origin at center)
 * and Phaser screen-pixel coordinates (+y down, origin at top-left).
 *
 * The server origin (0, 0) maps to the scene center. All coordinate reads
 * happen on every call so that canvas resizes are reflected immediately.
 *
 * See architecture/README.md §4 for the full coordinate model and formulas.
 */
export class CoordSpace {
  private readonly _scene: Phaser.Scene;
  private readonly _ppm: number;

  constructor(scene: Phaser.Scene, ppm: number = 64) {
    this._scene = scene;
    this._ppm = ppm;
  }

  /** Absolute X pixel: scene center + ppm * meter-x. */
  x(mx: number): number {
    return this._scene.scale.width / 2 + this._ppm * mx;
  }

  /** Absolute Y pixel: scene center - ppm * meter-y (Y flip). */
  y(my: number): number {
    return this._scene.scale.height / 2 - this._ppm * my;
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
