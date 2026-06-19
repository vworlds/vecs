import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import express from "express";
import {
  type AssetCatalog,
  type AssetDescriptor,
  type SpritesheetDescriptor,
} from "@vworlds/vecs-phaser";
import { worldPath } from "@vworlds/vecs-protocol";

import { Asset } from "./asset.js";
import { TilesetAsset, buildTiles } from "./tileset_asset.js";
import { type AnyProperty, type TilesetRaw } from "./types/tileset.js";

/** Error thrown when a tileset cannot be found on disk. */
export class TilesetNotFoundError extends Error {
  /** @param message - Human-readable error message. */
  public constructor(message: string) {
    super(message);
    this.name = "TilesetNotFoundError";
  }
}

/** Error thrown when a cached/loaded asset is not the requested kind. */
export class AssetKindMismatchError extends Error {
  /** @param message - Human-readable error message. */
  public constructor(message: string) {
    super(message);
    this.name = "AssetKindMismatchError";
  }
}

/** Error thrown when a tileset violates the v1.0.36 single-image scope guard. */
export class ImageCollectionTilesetError extends Error {
  /** @param message - Human-readable error message. */
  public constructor(message: string) {
    super(message);
    this.name = "ImageCollectionTilesetError";
  }
}

/** Constructor options for {@link AssetManager}. */
export interface AssetManagerOptions {
  /** Root asset directory (e.g. `"assets"`). Tilesets live under `tilesets/`. */
  assetsPath: string;
}

/**
 * Server-side asset loader + cache of typed asset handles. v1.0.36 has one asset
 * type — **tileset**; future kinds add their own `Asset` subclass and one
 * `getX(key)` method each.
 *
 * `getTileset(key)` reads `assetsPath/tilesets/<key>.tsj` (falling back to
 * `<key>.json`), parses with a `JSON.parse` reviver that constructs live
 * `TilesetAsset`/`Tile`/`MapObject` instances (not plain data bags), assigns a
 * stable append-only `id`, and caches by the human key so a second call returns
 * the same handle. Image **bytes** are never read server-side — only metadata;
 * bytes are served over HTTP by `mount`.
 *
 * `toCatalog(worldName)` enumerates cached assets into the wire DTO
 * (`AssetCatalog`), stripping server-only metadata. `mount(app, worldName)`
 * registers the catalog JSON route and a static file route over `assetsPath`.
 */
export class AssetManager {
  /** Root asset directory. */
  public readonly assetsPath: string;

  /** Cache of loaded assets keyed by human key (same handle on re-get). */
  private readonly _cache: Map<string, Asset> = new Map();

  /** Next server-assigned wire id (append-only, starts at 1). */
  private _nextId = 1;

  /**
   * @param options - `{ assetsPath }` root asset directory.
   */
  public constructor(options: AssetManagerOptions) {
    this.assetsPath = options.assetsPath;
  }

  /**
   * Load (or return cached) `TilesetAsset` by human key. Reads
   * `assetsPath/tilesets/<key>.tsj`, falling back to `<key>.json`. The first call
   * parses via `JSON.parse(text, reviver)` constructing live instances, assigns
   * a stable `id`, and caches; subsequent calls return the same handle.
   *
   * @param key - Human key (filename stem).
   * @returns The loaded `TilesetAsset`.
   * @throws {TilesetNotFoundError} when neither `<key>.tsj` nor `<key>.json` exists.
   * @throws {AssetKindMismatchError} when a different asset kind is cached under `key`.
   * @throws {ImageCollectionTilesetError} when the tileset is an image-collection.
   */
  public getTileset(key: string): TilesetAsset {
    const cached = this._cache.get(key);
    if (cached !== undefined) {
      if (!(cached instanceof TilesetAsset)) {
        throw new AssetKindMismatchError(
          `Asset "${key}" is not a TilesetAsset (got ${cached.constructor.name})`
        );
      }
      return cached;
    }
    const asset = this._loadTileset(key);
    this._cache.set(key, asset);
    return asset;
  }

  /**
   * Enumerate all cached assets into a wire `AssetCatalog` DTO, stripping
   * server-only metadata (no properties/objects/animation/class on the
   * descriptors). Each spritesheet descriptor's `url` is the server path the
   * static route serves.
   *
   * @param worldName    - Name of the world this catalog describes.
   * @param apiBasePath   - API base path (default `"/rtc/v1/world"`).
   * @returns The `AssetCatalog` DTO.
   */
  public toCatalog(worldName: string, apiBasePath: string = "/rtc/v1/world"): AssetCatalog {
    const base = worldPath(apiBasePath, worldName);
    const assets: AssetDescriptor[] = [];
    for (const asset of this._cache.values()) {
      if (asset instanceof TilesetAsset) {
        const descriptor: SpritesheetDescriptor = {
          id: asset.id,
          key: asset.key,
          kind: "spritesheet",
          url: `${base}/assets/files/${asset.image}`,
          frameWidth: asset.frameWidth,
          frameHeight: asset.frameHeight,
          margin: asset.margin,
          spacing: asset.spacing,
          columns: asset.columns,
          tileCount: asset.tileCount,
          imageWidth: asset.imageWidth,
          imageHeight: asset.imageHeight,
        };
        assets.push(descriptor);
      }
    }
    return { worldName, assets };
  }

  /**
   * Register the catalog JSON route and a static file route over `assetsPath`
   * on the given Express app, under the per-world `worldPath(apiBasePath,
   * worldName)`.
   *
   * - `GET {worldPath}/assets` → `toCatalog(worldName, apiBasePath)` JSON.
   * - `{worldPath}/assets/files` → `express.static(assetsPath)` (serves images).
   *
   * @param app         - Express app instance.
   * @param worldName   - Name of the world.
   * @param apiBasePath - API base path (default `"/rtc/v1/world"`).
   */
  public mount(
    app: import("express").Express,
    worldName: string,
    apiBasePath: string = "/rtc/v1/world"
  ): void {
    const base = worldPath(apiBasePath, worldName);
    app.get(`${base}/assets`, (_req, res) => {
      res.json(this.toCatalog(worldName, apiBasePath));
    });
    app.use(`${base}/assets/files`, express.static(this.assetsPath));
  }

  /** Load a `TilesetAsset` from disk, parse with the reviver, assign an id. */
  private _loadTileset(key: string): TilesetAsset {
    const tsjPath = join(this.assetsPath, "tilesets", `${key}.tsj`);
    const jsonPath = join(this.assetsPath, "tilesets", `${key}.json`);
    let text: string;
    let filePath: string;
    try {
      text = readFileSync(tsjPath, "utf8");
      filePath = tsjPath;
    } catch {
      try {
        text = readFileSync(jsonPath, "utf8");
        filePath = jsonPath;
      } catch {
        throw new TilesetNotFoundError(`No tileset "${key}" found at ${tsjPath} or ${jsonPath}`);
      }
    }
    const tileset = JSON.parse(text, (revKey, value) =>
      revKey === "" ? this._buildTileset(key, filePath, value as TilesetRaw) : value
    ) as TilesetAsset;
    return tileset;
  }

  /** Build a live `TilesetAsset` from raw input, applying scope guards + defaults. */
  private _buildTileset(key: string, filePath: string, raw: TilesetRaw): TilesetAsset {
    if (raw.image === undefined || raw.image === "") {
      throw new ImageCollectionTilesetError(
        `Tileset "${key}" has no top-level image (image-collection tilesets are not supported in v1.0.36)`
      );
    }
    if (raw.tiles) {
      for (const tile of raw.tiles) {
        if (tile.image !== undefined && tile.image !== "") {
          throw new ImageCollectionTilesetError(
            `Tileset "${key}" tile ${tile.id} carries its own image (image-collection tilesets are not supported in v1.0.36)`
          );
        }
      }
    }
    const tilesetImage = raw.image as string;
    const resolvedImage = resolveImageRelative(this.assetsPath, filePath, tilesetImage);
    const tiles = buildTiles(raw.tiles);
    const id = this._nextId++;
    return new TilesetAsset(
      id,
      key,
      resolvedImage,
      raw.tilewidth ?? 0,
      raw.tileheight ?? 0,
      raw.margin ?? 0,
      raw.spacing ?? 0,
      raw.columns ?? 0,
      raw.tilecount ?? 0,
      raw.imagewidth ?? 0,
      raw.imageheight ?? 0,
      raw.name ?? "",
      raw.class ?? raw.type ?? "",
      raw.properties ?? ([] as AnyProperty[]),
      tiles
    );
  }
}

/**
 * Resolve a tileset `image` path: the `image` field is relative to the `.tsj`
 * file location; express it relative to `assetsPath` in POSIX form.
 *
 * Example: `.tsj` at `assets/tilesets/ship.tsj` + image `ship.png` ⇒
 * `"tilesets/ship.png"`.
 *
 * @param assetsPath - Root asset directory.
 * @param filePath   - Absolute or relative path to the `.tsj`/`.json` file.
 * @param image      - Image path relative to the `.tsj` (Tiled `image` field).
 * @returns Image path relative to `assetsPath`, POSIX-separated.
 */
function resolveImageRelative(assetsPath: string, filePath: string, image: string): string {
  const fileDir = dirname(filePath);
  const absoluteImage = isAbsolute(image) ? image : join(fileDir, image);
  const rel = relative(assetsPath, absoluteImage);
  return normalize(rel).split(sep).join("/");
}
