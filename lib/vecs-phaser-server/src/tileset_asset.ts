import { Asset } from "./asset.js";
import { MapObject, Tile } from "./tile.js";
import {
  type AnyProperty,
  type MapObjectRaw,
  type Point,
  type Tileset,
  type TileRaw,
} from "./types/tileset.js";

/**
 * Concrete `TilesetAsset` — a single-image Tiled tileset ingested as a
 * spritesheet. `extends Asset` (carries `id`/`key`) and `implements` the
 * vendored `Tileset` interface (no `?`): sparse Tiled fields become non-null
 * empty defaults (`""`/`[]`) supplied at construction time.
 *
 * Field-name mapping: Tiled `tilewidth`→`frameWidth`, `tileheight`→
 * `frameHeight`, `tilecount`→`tileCount`, `imagewidth`→`imageWidth`,
 * `imageheight`→`imageHeight`. `image` is the resolved image path relative to
 * `assetsPath`, POSIX-separated (e.g. `"tilesets/ship.png"`), so the static
 * route serves it at `{worldPath}/assets/files/<image>`.
 *
 * `tile(id)` looks up a tile by numeric id (== Phaser frame index, row-major);
 * `sizeInMeters(ppm)` sizes a physics body to match the art in one call.
 */
export class TilesetAsset extends Asset implements Tileset {
  /** Resolved image path relative to `assetsPath`, POSIX-separated. */
  public image: string;

  /** Tile width (px) — Tiled `tilewidth`. */
  public frameWidth: number;

  /** Tile height (px) — Tiled `tileheight`. */
  public frameHeight: number;

  /** Tileset margin (px). */
  public margin: number;

  /** Tile spacing (px). */
  public spacing: number;

  /** Tiles per row. */
  public columns: number;

  /** Total frames — Tiled `tilecount`. */
  public tileCount: number;

  /** Source image width (px) — Tiled `imagewidth`. */
  public imageWidth: number;

  /** Source image height (px) — Tiled `imageheight`. */
  public imageHeight: number;

  /** Tileset name. */
  public name: string;

  /** Tileset "Class" (Tiled `class`/`type`); `""` when absent. */
  public class: string;

  /** Typed properties, preserved as-is; `[]` when absent. */
  public properties: AnyProperty[];

  /** Tiles keyed by numeric id (re-indexed from Tiled's sparse `tiles[]`). */
  private readonly _tiles: Map<number, Tile>;

  /**
   * @param id          - Server-assigned stable wire id (from `AssetManager`).
   * @param key         - Human authoring/debug key (filename stem).
   * @param image       - Resolved image path relative to `assetsPath`, POSIX.
   * @param frameWidth  - Tile width (px).
   * @param frameHeight - Tile height (px).
   * @param margin      - Tileset margin (px).
   * @param spacing     - Tile spacing (px).
   * @param columns     - Tiles per row.
   * @param tileCount   - Total frames.
   * @param imageWidth  - Source image width (px).
   * @param imageHeight - Source image height (px).
   * @param name        - Tileset name.
   * @param classField  - Tileset "Class" (`""` when absent).
   * @param properties  - Typed properties (`[]` when absent).
   * @param tiles       - Tiles keyed by numeric id (may be empty).
   */
  constructor(
    id: number,
    key: string,
    image: string,
    frameWidth: number,
    frameHeight: number,
    margin: number,
    spacing: number,
    columns: number,
    tileCount: number,
    imageWidth: number,
    imageHeight: number,
    name: string,
    classField: string,
    properties: AnyProperty[],
    tiles: Map<number, Tile>
  ) {
    super(id, key);
    this.image = image;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.margin = margin;
    this.spacing = spacing;
    this.columns = columns;
    this.tileCount = tileCount;
    this.imageWidth = imageWidth;
    this.imageHeight = imageHeight;
    this.name = name;
    this.class = classField;
    this.properties = properties;
    this._tiles = tiles;
  }

  /** Look up a tile by numeric id; `undefined` when not present. */
  public tile(id: number): Tile | undefined {
    return this._tiles.get(id);
  }

  /**
   * Size a physics body to match the art: `{ w: frameWidth/ppm,
   * h: frameHeight/ppm }`. PPM stays off the wire (meters everywhere).
   *
   * @param ppm - Pixels per meter.
   * @returns `{ w, h }` in meters.
   */
  public sizeInMeters(ppm: number): { w: number; h: number } {
    return { w: this.frameWidth / ppm, h: this.frameHeight / ppm };
  }
}

/**
 * Build the `Tile` instances for a `TilesetAsset` from a raw Tiled `tiles[]`
 * array, applying the non-null empty defaults for every omitted field. Used by
 * the reviver to construct concrete tiles from raw input.
 *
 * @param rawTiles - Raw Tiled tiles array (may be undefined).
 * @returns `Map<id, Tile>` keyed by numeric tile id.
 */
export function buildTiles(rawTiles: TileRaw[] | undefined): Map<number, Tile> {
  const map = new Map<number, Tile>();
  if (!rawTiles) {
    return map;
  }
  for (const raw of rawTiles) {
    const tile = buildTile(raw);
    map.set(tile.id, tile);
  }
  return map;
}

/** Build a single `Tile` from raw input, applying non-null empty defaults. */
function buildTile(raw: TileRaw): Tile {
  return new Tile(
    raw.id,
    raw.class ?? raw.type ?? "",
    raw.properties ?? [],
    buildObjects(raw.objectgroup),
    raw.animation ?? []
  );
}

/** Build the `Map<number, MapObject>` for a tile from a raw `objectgroup`. */
function buildObjects(
  objectgroup: { objects: MapObjectRaw[] } | undefined
): Map<number, MapObject> {
  const map = new Map<number, MapObject>();
  if (!objectgroup || !objectgroup.objects) {
    return map;
  }
  for (const raw of objectgroup.objects) {
    const obj = new MapObject(
      raw.id,
      raw.x,
      raw.y,
      raw.width ?? 0,
      raw.height ?? 0,
      raw.rotation ?? 0,
      raw.name ?? "",
      raw.type ?? "",
      raw.ellipse ?? false,
      raw.point ?? false,
      (raw.polygon ?? []) as Point[],
      (raw.polyline ?? []) as Point[]
    );
    map.set(obj.id, obj);
  }
  return map;
}
