import type { AssetDescriptor } from "@vworlds/vecs-phaser";

/**
 * Base class for every asset the server owns. v1.0.36 has one concrete kind —
 * `TilesetAsset` — but future kinds (audio, etc.) extend this with their own
 * `Asset` subclass and one `getX(key)` method each on `AssetManager`.
 *
 * `id` is server-assigned, stable, and append-only: allocated by this base
 * constructor when each concrete asset is constructed, never reused or reordered,
 * so a future in-band "asset added" message can extend the catalog at runtime
 * without disturbing v1.0.36.
 *
 * `key` is the human authoring/debug name — it never crosses the wire; the
 * client keys Phaser textures by the numeric `id`.
 */
export abstract class Asset {
  private static _nextId = 1;

  /** Stable, append-only wire id. */
  public readonly id: number;

  /** Human authoring/debug key (filename stem). Server-only. */
  public readonly key: string;

  /**
   * @param key - Human authoring/debug key.
   */
  constructor(key: string) {
    this.id = Asset._nextId++;
    this.key = key;
  }

  /** @internal Reset ids before a deterministic `AssetManager` scan. */
  public static _resetIds(): void {
    Asset._nextId = 1;
  }

  /** Build this asset's wire catalog descriptor. */
  public abstract descriptor(): AssetDescriptor;
}
