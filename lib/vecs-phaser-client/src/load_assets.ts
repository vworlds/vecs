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
  /**
   * Optional signal that cancels the load. On abort, every loader listener `loadAssets` added is
   * removed, the loader is stopped, and the promise rejects with the signal's reason.
   */
  signal?: AbortSignal;
}

/** Lookup wrapper for the asset catalog returned by `loadAssets`. */
export class Catalog {
  private readonly _byId: Map<number, AssetDescriptor>;

  /** Wrap a fetched asset catalog as an id-indexed lookup. */
  public constructor(
    private readonly catalog: AssetCatalog,
    /** Phaser keys (descriptor ids as strings) of files the loader failed to load. */
    public readonly failed: readonly string[] = []
  ) {
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
 *
 * The loader `progress`, `complete`, and `loaderror` listeners added by this call are removed when
 * the load completes or is aborted through `conn.signal`, so repeated calls on one scene do not
 * leak listeners. Like Phaser, a failed file does not stop the load: the promise still resolves on
 * `complete`, and `Catalog.failed` lists the keys of the files that failed. A failed catalog fetch
 * rejects, and so does an abort, with `signal.reason`.
 */
export async function loadAssets(scene: Phaser.Scene, conn: LoadAssetsOptions): Promise<Catalog> {
  const origin = `${conn.protocol ?? "http"}://${conn.host}:${conn.port}`;
  const basePath = worldPath(conn.apiBasePath, conn.worldName);
  conn.signal?.throwIfAborted();
  const res = await fetch(`${origin}${basePath}/assets`, { signal: conn.signal });

  if (!res.ok) {
    throw new Error(`Failed to fetch asset catalog from ${origin}${basePath}/assets`);
  }

  const catalog = (await res.json()) as AssetCatalog;

  for (const descriptor of catalog.assets) {
    if (descriptor.kind === "spritesheet") {
      const ss = descriptor as SpritesheetDescriptor;
      scene.load.spritesheet(String(ss.id), `${origin}${basePath}/assets/files/${ss.image}`, {
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

  return new Promise((resolve, reject) => {
    const loader = scene.load;
    const failed: string[] = [];
    const onProgress = (value: number) => conn.onProgress?.(value);
    const cleanup = () => {
      loader.off("progress", onProgress);
      loader.off("complete", onComplete);
      loader.off("loaderror", onError);
      conn.signal?.removeEventListener("abort", onAbort);
    };
    const onComplete = () => {
      cleanup();
      resolve(new Catalog(catalog, failed));
    };
    const onError = (file: { key?: string }) => {
      failed.push(file?.key ?? "");
    };
    const onAbort = () => {
      cleanup();
      loader.reset();
      reject(conn.signal!.reason);
    };
    loader.on("progress", onProgress);
    loader.once("complete", onComplete);
    loader.on("loaderror", onError);
    conn.signal?.addEventListener("abort", onAbort, { once: true });
    loader.start();
  });
}
