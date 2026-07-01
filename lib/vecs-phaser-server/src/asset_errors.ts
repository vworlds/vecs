/** Error thrown when a cached/loaded asset is not the requested kind. */
export class AssetKindMismatchError extends Error {
  /** @param message - Human-readable error message. */
  public constructor(message: string) {
    super(message);
    this.name = "AssetKindMismatchError";
  }
}

/** Error thrown when a tileset violates the single-image scope guard. */
export class ImageCollectionTilesetError extends Error {
  /** @param message - Human-readable error message. */
  public constructor(message: string) {
    super(message);
    this.name = "ImageCollectionTilesetError";
  }
}

/** Error thrown when a tileset cannot be found on disk. */
export class TilesetNotFoundError extends Error {
  /** @param message - Human-readable error message. */
  public constructor(message: string) {
    super(message);
    this.name = "TilesetNotFoundError";
  }
}
