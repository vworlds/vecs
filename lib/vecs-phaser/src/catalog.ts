/** Base identity for any catalog asset. New kinds extend this; the base never changes. */
export interface AssetDescriptor {
  /** Wire id (stable, append-only). */
  id: number;
  /** Discriminant; narrowed by each subtype to its literal. */
  kind: string;
}

/** A Tiled-tileset-backed spritesheet asset the client loads via Phaser's spritesheet loader. */
export interface SpritesheetDescriptor extends AssetDescriptor {
  /** Spritesheet catalog discriminant. */
  kind: "spritesheet";
  /** Source image path relative to the server asset root. */
  image: string;
  /** Tile width (px). */
  frameWidth: number;
  /** Tile height (px). */
  frameHeight: number;
  /** Tileset margin (px). */
  margin: number;
  /** Tile spacing (px). */
  spacing: number;
  /** Tiles per row. */
  columns: number;
  /** Total frames. */
  tileCount: number;
  /** Source image width (px). */
  imageWidth: number;
  /** Source image height (px). */
  imageHeight: number;
}

/** Per-world asset catalog served as JSON over HTTP. */
export interface AssetCatalog {
  /** Name of the world this catalog describes. */
  worldName: string;
  /** Heterogeneous asset descriptors; clients narrow per element via `kind`. */
  assets: AssetDescriptor[];
}
