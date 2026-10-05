import { worldPath } from "@vworlds/vecs-client";
import type { AssetCatalog, SpritesheetDescriptor } from "@vworlds/vecs-phaser";
import type Phaser from "phaser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAssets } from "../src/load_assets.js";

interface SpritesheetCall {
  readonly key: string;
  readonly url: string;
  readonly config: {
    readonly frameWidth: number;
    readonly frameHeight: number;
    readonly margin: number;
    readonly spacing: number;
  };
}

type LoaderEvent = "complete" | "progress" | "loaderror";
type LoaderHandler = (value: unknown) => void;

class MockLoader {
  readonly spritesheetCalls: SpritesheetCall[] = [];
  started = false;
  resetCalls = 0;
  private readonly _handlers = new Map<LoaderEvent, LoaderHandler[]>();
  private readonly _onceHandlers = new Map<LoaderEvent, LoaderHandler[]>();

  on(event: LoaderEvent, handler: LoaderHandler): this {
    this._addHandler(this._handlers, event, handler);
    return this;
  }

  once(event: LoaderEvent, handler: LoaderHandler): this {
    this._addHandler(this._onceHandlers, event, handler);
    return this;
  }

  off(event: LoaderEvent, handler: LoaderHandler): this {
    for (const registry of [this._handlers, this._onceHandlers]) {
      const handlers = registry.get(event);
      const index = handlers?.indexOf(handler) ?? -1;
      if (index >= 0) {
        handlers!.splice(index, 1);
      }
    }
    return this;
  }

  reset(): void {
    this.resetCalls++;
  }

  listenerCount(): number {
    let count = 0;
    for (const registry of [this._handlers, this._onceHandlers]) {
      registry.forEach((handlers) => (count += handlers.length));
    }
    return count;
  }

  fail(key: string): void {
    this._emit("loaderror", { key });
  }

  spritesheet(key: string, url: string, config: SpritesheetCall["config"]): this {
    this.spritesheetCalls.push({ key, url, config });
    return this;
  }

  start(): void {
    this.started = true;
    this._emit("progress", 0.5);
  }

  complete(): void {
    this._emit("complete", 1);
  }

  private _addHandler(
    registry: Map<LoaderEvent, LoaderHandler[]>,
    event: LoaderEvent,
    handler: LoaderHandler
  ): void {
    const handlers = registry.get(event) ?? [];
    handlers.push(handler);
    registry.set(event, handlers);
  }

  private _emit(event: LoaderEvent, value: unknown): void {
    this._handlers.get(event)?.forEach((handler) => handler(value));
    const onceHandlers = this._onceHandlers.get(event) ?? [];
    this._onceHandlers.delete(event);
    onceHandlers.forEach((handler) => handler(value));
  }
}

const spritesheets: SpritesheetDescriptor[] = [
  {
    id: 7,
    kind: "spritesheet",
    image: "tilesets/terrain.png",
    frameWidth: 16,
    frameHeight: 24,
    margin: 1,
    spacing: 2,
    columns: 8,
    tileCount: 64,
    imageWidth: 146,
    imageHeight: 210,
  },
  {
    id: 42,
    kind: "spritesheet",
    image: "tilesets/ship.png",
    frameWidth: 32,
    frameHeight: 48,
    margin: 3,
    spacing: 4,
    columns: 4,
    tileCount: 16,
    imageWidth: 144,
    imageHeight: 204,
  },
];

const catalogFixture: AssetCatalog = {
  worldName: "arena",
  assets: spritesheets,
};

async function flushAssetFetch(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("loadAssets", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the catalog, queues spritesheets, reports progress, and resolves on complete", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => catalogFixture,
    }));
    vi.stubGlobal("fetch", fetch);
    const loader = new MockLoader();
    const scene = { load: loader } as unknown as Phaser.Scene;
    const progress = vi.fn();

    let resolved = false;
    const promise = loadAssets(scene, {
      host: "game.local",
      port: 7777,
      worldName: "arena",
      apiBasePath: "/custom/world",
      onProgress: progress,
    }).then((catalog) => {
      resolved = true;
      return catalog;
    });

    await flushAssetFetch();

    expect(fetch).toHaveBeenCalledWith(
      `http://game.local:7777${worldPath("/custom/world", "arena")}/assets`,
      { signal: undefined }
    );
    expect(loader.started).toBe(true);
    expect(loader.spritesheetCalls).toEqual([
      {
        key: "7",
        url: "http://game.local:7777/custom/world/arena/assets/files/tilesets/terrain.png",
        config: { frameWidth: 16, frameHeight: 24, margin: 1, spacing: 2 },
      },
      {
        key: "42",
        url: "http://game.local:7777/custom/world/arena/assets/files/tilesets/ship.png",
        config: { frameWidth: 32, frameHeight: 48, margin: 3, spacing: 4 },
      },
    ]);
    expect(progress).toHaveBeenCalledWith(0.5);
    expect(resolved).toBe(false);

    loader.complete();
    const catalog = await promise;

    expect(resolved).toBe(true);
    expect(catalog.worldName).toBe("arena");
    expect(catalog.get(7)).toBe(catalogFixture.assets[0]);
    expect(catalog.get(42)).toBe(catalogFixture.assets[1]);
    expect(catalog.get(999)).toBeUndefined();
    expect(catalog.has(7)).toBe(true);
    expect(catalog.has(999)).toBe(false);
    expect(catalog.all()).toEqual(catalogFixture.assets);
  });

  describe("listener cleanup", () => {
    function stubCatalog(): void {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => catalogFixture }))
      );
    }
    const conn = { host: "game.local", port: 7777, worldName: "arena" };

    it("leaves no listeners behind after repeated successful loads", async () => {
      stubCatalog();
      const loader = new MockLoader();
      const scene = { load: loader } as unknown as Phaser.Scene;

      for (let i = 0; i < 5; i++) {
        const promise = loadAssets(scene, { ...conn, onProgress: vi.fn() });
        await flushAssetFetch();
        expect(loader.listenerCount()).toBeGreaterThan(0);
        loader.complete();
        await promise;
        expect(loader.listenerCount()).toBe(0);
      }
    });

    it("resolves on complete after a failed file, reports its key and leaves no listeners", async () => {
      stubCatalog();
      const loader = new MockLoader();
      const scene = { load: loader } as unknown as Phaser.Scene;

      const promise = loadAssets(scene, conn);
      await flushAssetFetch();
      loader.fail("7");
      // Like Phaser, the loader keeps going after a file error.
      expect(loader.listenerCount()).toBeGreaterThan(0);
      loader.complete();
      const catalog = await promise;

      expect(catalog.failed).toEqual(["7"]);
      expect(catalog.has(42)).toBe(true);
      expect(loader.listenerCount()).toBe(0);
    });

    it("reports no failures for a clean load", async () => {
      stubCatalog();
      const loader = new MockLoader();
      const scene = { load: loader } as unknown as Phaser.Scene;

      const promise = loadAssets(scene, conn);
      await flushAssetFetch();
      loader.complete();

      expect((await promise).failed).toEqual([]);
    });

    it("cancels on abort, removes its listeners and resets the loader", async () => {
      stubCatalog();
      const loader = new MockLoader();
      const scene = { load: loader } as unknown as Phaser.Scene;
      const controller = new AbortController();

      const promise = loadAssets(scene, { ...conn, signal: controller.signal });
      const settled = expect(promise).rejects.toThrow("cancelled");
      await flushAssetFetch();
      expect(loader.listenerCount()).toBeGreaterThan(0);
      controller.abort(new Error("cancelled"));
      await settled;

      expect(loader.listenerCount()).toBe(0);
      expect(loader.resetCalls).toBe(1);
    });

    it("rejects without touching the loader when already aborted", async () => {
      stubCatalog();
      const loader = new MockLoader();
      const scene = { load: loader } as unknown as Phaser.Scene;

      await expect(loadAssets(scene, { ...conn, signal: AbortSignal.abort() })).rejects.toThrow();

      expect(loader.started).toBe(false);
      expect(loader.listenerCount()).toBe(0);
    });

    it("ignores a later abort after the load completed", async () => {
      stubCatalog();
      const loader = new MockLoader();
      const scene = { load: loader } as unknown as Phaser.Scene;
      const controller = new AbortController();

      const promise = loadAssets(scene, { ...conn, signal: controller.signal });
      await flushAssetFetch();
      loader.complete();
      await promise;
      controller.abort();

      expect(loader.resetCalls).toBe(0);
    });
  });
});
