/**
 * Vendored Tiled schema — bare-minimum interfaces copied from `@kayahr/tiled`
 * (the authoritative reference), retaining only the fields v1.0.36 uses.
 *
 * Two layers live here:
 *
 * 1. **Public interfaces** (no `?` on the v1.0.36 fields). Our concrete classes
 *    (`TilesetAsset`, `Tile`, `MapObject`) `implements` these, so they act as
 *    the type-check contract. Sparse Tiled fields become REQUIRED here, and the
 *    concrete classes guarantee non-null empty defaults (`[]`, empty `Map`, `""`,
 *    `false`, `0`) — consumers never null-check.
 *
 * 2. **`*Raw` interfaces** (with `?`) modeling the raw Tiled JSON the reviver
 *    reads. These carry the original Tiled field names (`tilewidth`, `type`,
 *    `objectgroup`, …) so the loader can read raw input before constructing the
 *    concrete tree.
 *
 * This file is grown field-by-field as features are added; it never depends on
 * `@kayahr/tiled` at runtime or build time.
 */

/**
 * Tiled property type discriminant. String/file/color/class serialize as
 * strings; int/float/object as numbers; bool as boolean. Color values are hex
 * strings like `"#ffaa00ff"`.
 */
export type PropertyType =
  | "string"
  | "int"
  | "float"
  | "bool"
  | "color"
  | "file"
  | "object"
  | "class";

/**
 * A single Tiled typed property. Preserved as-is (NOT flattened to a map) so
 * declared types like `color`/`int`/`file` survive the round-trip.
 */
export interface Property {
  /** Property name. */
  name: string;
  /** Property type discriminant. */
  type: PropertyType;
  /** Value — typed by `type` (string | number | boolean). */
  value: string | number | boolean;
}

/** Any Tiled property (the typed property union). */
export type AnyProperty = Property;

/** A single animation frame: `{ tileid, duration }` (ms). */
export interface Frame {
  /** Tile id this frame shows. */
  tileid: number;
  /** Frame duration in milliseconds. */
  duration: number;
}

/** A 2D point in pixels. */
export interface Point {
  /** X coordinate (px). */
  x: number;
  /** Y coordinate (px). */
  y: number;
}

/**
 * Public vendored `MapObject` interface — a collision/anchor shape on a tile.
 * Sparse Tiled shape flags become REQUIRED booleans/arrays defaulting to
 * `false`/`[]`; a plain rectangle has none of `ellipse`/`point`/`polygon`/
 * `polyline` set.
 */
export interface MapObject {
  /** Unique id across all objects in the tileset. */
  id: number;
  /** X coordinate (px). */
  x: number;
  /** Y coordinate (px). */
  y: number;
  /** Width (px); `0` when absent. */
  width: number;
  /** Height (px); `0` when absent. */
  height: number;
  /** Rotation in degrees clockwise; `0` when absent. */
  rotation: number;
  /** Name; `""` when absent. */
  name: string;
  /** Object "Class"; `""` when absent. */
  type: string;
  /** `true` if ellipse (a circle is an ellipse with equal dims). */
  ellipse: boolean;
  /** `true` if point. */
  point: boolean;
  /** Polygon points; `[]` when not a polygon. */
  polygon: Point[];
  /** Polyline points; `[]` when not a polyline. */
  polyline: Point[];
}

/**
 * Public vendored `Tile` interface — a single tile in a tileset. Sparse Tiled
 * fields become REQUIRED with non-null empty defaults supplied by `Tile`.
 */
export interface Tile {
  /** Local tile id (== Phaser frame index, row-major). */
  id: number;
  /** Tile "Class" (Tiled `class`/`type`); `""` when absent. */
  class: string;
  /** Typed properties, preserved as-is; `[]` when absent. */
  properties: AnyProperty[];
  /** Collision/anchor shapes keyed by `MapObject.id`; empty `Map` when absent. */
  objects: Map<number, MapObject>;
  /** Animation frames; `[]` when absent. */
  animation: Frame[];
}

/**
 * Public vendored `Tileset` interface — a single-image Tiled tileset ingested
 * as a spritesheet. Field names map Tiled's (`tilewidth`→`frameWidth`, etc.);
 * sparse fields become REQUIRED with non-null defaults. `tile(id)` looks up a
 * tile by numeric id (the concrete class re-indexes Tiled's `tiles[]` into a
 * `Map`).
 */
export interface Tileset {
  /** Resolved image path relative to `assetsPath`, POSIX-separated. */
  image: string;
  /** Tile width (px) — Tiled `tilewidth`. */
  frameWidth: number;
  /** Tile height (px) — Tiled `tileheight`. */
  frameHeight: number;
  /** Tileset margin (px). */
  margin: number;
  /** Tile spacing (px). */
  spacing: number;
  /** Tiles per row. */
  columns: number;
  /** Total frames — Tiled `tilecount`. */
  tileCount: number;
  /** Source image width (px) — Tiled `imagewidth`. */
  imageWidth: number;
  /** Source image height (px) — Tiled `imageheight`. */
  imageHeight: number;
  /** Tileset name. */
  name: string;
  /** Tileset "Class" (Tiled `class`/`type`); `""` when absent. */
  class: string;
  /** Typed properties; `[]` when absent. */
  properties: AnyProperty[];
  /** Look up a tile by numeric id; `undefined` when not present. */
  tile(id: number): Tile | undefined;
}

// ---------------------------------------------------------------------------
// Raw input shapes (with `?`) — what the reviver reads from raw Tiled JSON.
// ---------------------------------------------------------------------------

/** Raw `MapObject` as Tiled emits it (sparse fields optional). */
export interface MapObjectRaw {
  id: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  name?: string;
  type?: string;
  ellipse?: boolean;
  point?: boolean;
  polygon?: Point[];
  polyline?: Point[];
}

/** Raw `Tile` as Tiled emits it (sparse fields optional; `image?` ⇒ collection). */
export interface TileRaw {
  id: number;
  type?: string;
  class?: string;
  properties?: AnyProperty[];
  objectgroup?: { objects: MapObjectRaw[] };
  animation?: Frame[];
  /** Presence ⇒ image-collection tile (rejected by the scope guard). */
  image?: string;
}

/** Raw `Tileset` as Tiled emits it (sparse fields optional; `image?` ⇒ collection). */
export interface TilesetRaw {
  columns: number;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  margin?: number;
  spacing?: number;
  tilecount?: number;
  tilewidth?: number;
  tileheight?: number;
  name?: string;
  class?: string;
  type?: string;
  properties?: AnyProperty[];
  tiles?: TileRaw[];
}
