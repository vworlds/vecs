import { existsSync, readdirSync } from "node:fs";
import { extname, join, parse } from "node:path";

import express from "express";
import {
  type AssetCatalog,
  type AssetDescriptor,
  type SpritesheetDescriptor,
} from "@vworlds/vecs-phaser";
import { worldPath } from "@vworlds/vecs-protocol";

import { Asset } from "./asset.js";
import { AssetKindMismatchError, TilesetNotFoundError } from "./asset_errors.js";
import { TilesetAsset } from "./tileset_asset.js";

export {
  AssetKindMismatchError,
  ImageCollectionTilesetError,
  TilesetNotFoundError,
} from "./asset_errors.js";

interface AssetType<TAsset extends Asset> {
  readonly assetDirectory: string;
  readonly assetNamespace: string;
  readonly supportedExtensions: readonly string[];
  load(assetsPath: string, key: string): TAsset;
}

const assetTypes = [TilesetAsset].sort((a, b) => a.assetNamespace.localeCompare(b.assetNamespace));

/** Constructor options for {@link AssetManager}. */
export interface AssetManagerOptions {
  /** Root asset directory (e.g. `"assets"`). Tilesets live under `tilesets/`. */
  assetsPath: string;
}

/**
 * Server-side asset catalog of typed asset handles. v1.0.36 has one asset type
 * — **tileset**; future kinds add their own `Asset` subclass and one `getX(key)`
 * method each.
 *
 * Construction scans the supported asset folders under `assetsPath`, loads every
 * supported metadata file it finds into `_assets`, and assigns stable ids in
 * deterministic key order. Asset keys in `_assets` are namespaced by catalog
 * kind, e.g. `spritesheets/ship`; tilesets use the `spritesheets` namespace
 * because they are published as Phaser spritesheets. Image **bytes** are never
 * read server-side — only metadata; bytes are served over HTTP by `mount`.
 *
 * `toCatalog(worldName)` enumerates loaded assets into the wire DTO
 * (`AssetCatalog`), stripping server-only metadata. `mount(app, worldName)`
 * registers the catalog JSON route and a static file route over `assetsPath`.
 */
export class AssetManager {
  /** Root asset directory. */
  public readonly assetsPath: string;

  /** Loaded assets keyed by namespaced catalog key (for example, `spritesheets/ship`). */
  private readonly _assets: Map<string, Asset> = new Map();

  /**
   * @param options - `{ assetsPath }` root asset directory.
   */
  public constructor(options: AssetManagerOptions) {
    this.assetsPath = options.assetsPath;
    Asset._resetIds();
    for (const assetType of assetTypes) {
      this._loadAssets(assetType);
    }
  }

  /**
   * Return a preloaded `TilesetAsset` by human key.
   *
   * @param key - Human key (filename stem).
   * @returns The loaded `TilesetAsset`.
   * @throws {TilesetNotFoundError} when no preloaded tileset exists for `key`.
   * @throws {AssetKindMismatchError} when a different asset kind is loaded under `key`.
   * @throws {ImageCollectionTilesetError} when the tileset is an image-collection.
   */
  public getTileset(key: string): TilesetAsset {
    const assetKey = this._assetKey(TilesetAsset.assetNamespace, key);
    const asset = this._assets.get(assetKey);
    if (asset === undefined) {
      throw new TilesetNotFoundError(`No tileset "${key}" loaded from ${this.assetsPath}`);
    }
    if (!(asset instanceof TilesetAsset)) {
      throw new AssetKindMismatchError(
        `Asset "${assetKey}" is not a TilesetAsset (got ${asset.constructor.name})`
      );
    }
    return asset;
  }

  /**
   * Enumerate all loaded assets into a wire `AssetCatalog` DTO, stripping
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
    for (const asset of this._assets.values()) {
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

  private _loadAssets<TAsset extends Asset>(assetType: AssetType<TAsset>): void {
    const directory = join(this.assetsPath, assetType.assetDirectory);
    if (!existsSync(directory)) {
      return;
    }

    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    const keys = new Set<string>();
    for (const extension of assetType.supportedExtensions) {
      for (const entry of entries) {
        if (extname(entry) === extension) {
          keys.add(parse(entry).name);
        }
      }
    }

    for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
      const asset = assetType.load(this.assetsPath, key);
      this._assets.set(this._assetKey(assetType.assetNamespace, key), asset);
    }
  }

  private _assetKey(namespace: string, key: string): string {
    return `${namespace}/${key}`;
  }
}
