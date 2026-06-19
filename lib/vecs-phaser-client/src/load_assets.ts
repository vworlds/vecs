import { worldPath } from "@vworlds/vecs-client";
import type { AssetCatalog, AssetDescriptor, SpritesheetDescriptor } from "@vworlds/vecs-phaser";
import type Phaser from "phaser";

/** Connection and progress options for loading a world's Phaser assets. */
export interface LoadAssetsOptions {
  /** Game server host used for the catalog fetch and Phaser loader URLs. */
  host: string;
  /** Game server port used for the catalog fetch and Phaser loader URLs. */
  port: number;
  /** World name whose catalog should be loaded. */
  worldName: string;
  /** HTTP protocol used to reach the game server. Defaults to `"http"`. */
  protocol?: "http" | "https";
  /** API base path passed to `worldPath`. Defaults to the vecs world path. */
  apiBasePath?: string;
  /** Optional Phaser loader progress callback, receiving values from 0 to 1. */
  onProgress?: (value: number) => void;
}

/** Lookup wrapper for the asset catalog returned by `loadAssets`. */
export class Catalog {
  private readonly _byId: Map<number, AssetDescriptor>;

  /** Wrap a fetched asset catalog as an id-indexed lookup. */
  public constructor(private readonly catalog: AssetCatalog) {
    this._byId = new Map(catalog.assets.map((descriptor) => [descriptor.id, descriptor]));
  }

  /** Name of the world this catalog describes. */
  public get worldName(): string {
    return this.catalog.worldName;
  }

  /** Return every asset descriptor in server catalog order. */
  public all(): readonly AssetDescriptor[] {
    return this.catalog.assets;
  }

  /** Return the descriptor with the given resource id, if present. */
  public get(id: number): AssetDescriptor | undefined {
    return this._byId.get(id);
  }

  /** Return whether this catalog has a descriptor for the given resource id. */
  public has(id: number): boolean {
    return this._byId.has(id);
  }
}

/**
 * Fetch a world's asset catalog, queue every spritesheet in Phaser, and resolve after loading.
 */
export async function loadAssets(scene: Phaser.Scene, conn: LoadAssetsOptions): Promise<Catalog> {
  const origin = `${conn.protocol ?? "http"}://${conn.host}:${conn.port}`;
  const basePath = worldPath(conn.apiBasePath, conn.worldName);
  const res = await fetch(`${origin}${basePath}/assets`);

  if (!res.ok) {
    throw new Error(`Failed to fetch asset catalog from ${origin}${basePath}/assets`);
  }

  const catalog = (await res.json()) as AssetCatalog;

  for (const descriptor of catalog.assets) {
    if (descriptor.kind === "spritesheet") {
      const ss = descriptor as SpritesheetDescriptor;
      scene.load.spritesheet(String(ss.id), `${origin}${ss.url}`, {
        frameWidth: ss.frameWidth,
        frameHeight: ss.frameHeight,
        margin: ss.margin,
        spacing: ss.spacing,
      });
    }
  }

  if (catalog.assets.length === 0) {
    return new Catalog(catalog);
  }

  return new Promise((resolve) => {
    scene.load.on("progress", (value: number) => conn.onProgress?.(value));
    scene.load.once("complete", () => resolve(new Catalog(catalog)));
    scene.load.start();
  });
}
