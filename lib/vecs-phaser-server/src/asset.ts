/**
 * Base class for every asset the server owns. v1.0.36 has one concrete kind —
 * `TilesetAsset` — but future kinds (audio, etc.) extend this with their own
 * `Asset` subclass and one `getX(key)` method each on `AssetManager`.
 *
 * `id` is server-assigned, stable, and append-only: allocated the first time an
 * asset is loaded, never reused or reordered, so a future in-band "asset added"
 * message can extend the catalog at runtime without disturbing v1.0.36.
 *
 * `key` is the human authoring/debug name — it never crosses the wire; the
 * client keys Phaser textures by the numeric `id`.
 */
export abstract class Asset {
  /**
   * Stable, append-only wire id. Server-assigned on first load; reused on
   * subsequent `getTileset(key)` calls.
   */
  public readonly id: number;

  /** Human authoring/debug key (filename stem). Server-only. */
  public readonly key: string;

  /**
   * @param id  - Server-assigned stable wire id.
   * @param key - Human authoring/debug key.
   */
  constructor(id: number, key: string) {
    this.id = id;
    this.key = key;
  }
}
