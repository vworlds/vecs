import {
  type AnyProperty,
  type Frame,
  type MapObject as MapObjectIface,
  type Tile as TileIface,
} from "./types/tileset.js";

/**
 * Concrete `MapObject` — a collision/anchor shape on a tile. `implements` the
 * vendored `MapObject` interface (no `?`): sparse Tiled shape flags become
 * non-null defaults (`false`/`[]`/`0`/`""`) supplied at construction time.
 *
 * A plain rectangle has none of `ellipse`/`point`/`polygon`/`polyline` set. A
 * circle is an ellipse with equal `width`/`height` (Tiled has no dedicated
 * circle flag).
 */
export class MapObject implements MapObjectIface {
  /** Unique id across all objects in the tileset. */
  public readonly id: number;

  /** X coordinate (px). */
  public x: number;

  /** Y coordinate (px). */
  public y: number;

  /** Width (px); `0` when Tiled omits it. */
  public width: number;

  /** Height (px); `0` when Tiled omits it. */
  public height: number;

  /** Rotation in degrees clockwise; `0` when Tiled omits it. */
  public rotation: number;

  /** Name; `""` when Tiled omits it. */
  public name: string;

  /** Object "Class"; `""` when Tiled omits it. */
  public type: string;

  /** `true` if ellipse (a circle is an ellipse with equal dims). */
  public ellipse: boolean;

  /** `true` if point. */
  public point: boolean;

  /** Polygon points; `[]` when not a polygon. */
  public polygon: { x: number; y: number }[];

  /** Polyline points; `[]` when not a polyline. */
  public polyline: { x: number; y: number }[];

  /**
   * @param id       - Unique id across all objects in the tileset.
   * @param x        - X coordinate (px).
   * @param y        - Y coordinate (px).
   * @param width    - Width (px).
   * @param height   - Height (px).
   * @param rotation - Rotation in degrees clockwise.
   * @param name     - Name.
   * @param type     - Object "Class".
   * @param ellipse  - `true` if ellipse.
   * @param point    - `true` if point.
   * @param polygon  - Polygon points (`[]` when not a polygon).
   * @param polyline - Polyline points (`[]` when not a polyline).
   */
  constructor(
    id: number,
    x: number,
    y: number,
    width: number,
    height: number,
    rotation: number,
    name: string,
    type: string,
    ellipse: boolean,
    point: boolean,
    polygon: { x: number; y: number }[],
    polyline: { x: number; y: number }[]
  ) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.rotation = rotation;
    this.name = name;
    this.type = type;
    this.ellipse = ellipse;
    this.point = point;
    this.polygon = polygon;
    this.polyline = polyline;
  }
}

/**
 * Concrete `Tile` — a single tile in a `TilesetAsset`, carrying the per-tile
 * Tiled metadata the server reads (game-logic data) but the wire never
 * carries. `implements` the vendored `Tile` interface (no `?`): sparse Tiled
 * fields become non-null empty defaults (`""`/`[]`/empty `Map`) supplied at
 * construction time.
 *
 * `id` equals the Phaser spritesheet frame index (row-major), so
 * `set(Image, { texture: ship.id, frame: tileId })` shows this exact tile and
 * `tileset.tile(tileId)` returns its metadata.
 */
export class Tile implements TileIface {
  /** Local tile id (== Phaser frame index, row-major). */
  public readonly id: number;

  /** Tile "Class" (Tiled `class`/`type`); `""` when absent. */
  public class: string;

  /** Typed properties, preserved as-is; `[]` when absent. */
  public properties: AnyProperty[];

  /** Collision/anchor shapes keyed by `MapObject.id`; empty `Map` when absent. */
  public objects: Map<number, MapObject>;

  /** Animation frames (captured for the future `Sprite` feature); `[]` when absent. */
  public animation: Frame[];

  /**
   * @param id         - Local tile id (== Phaser frame index).
   * @param classField - Tiled `class`/`type` (`""` when absent).
   * @param properties - Typed properties (`[]` when absent).
   * @param objects    - Collision/anchor shapes keyed by `MapObject.id` (empty `Map` when absent).
   * @param animation  - Animation frames (`[]` when absent).
   */
  constructor(
    id: number,
    classField: string,
    properties: AnyProperty[],
    objects: Map<number, MapObject>,
    animation: Frame[]
  ) {
    this.id = id;
    this.class = classField;
    this.properties = properties;
    this.objects = objects;
    this.animation = animation;
  }
}
