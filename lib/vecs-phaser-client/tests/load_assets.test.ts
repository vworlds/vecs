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

type LoaderEvent = "complete" | "progress";
type LoaderHandler = (value: number) => void;

class MockLoader {
  readonly spritesheetCalls: SpritesheetCall[] = [];
  started = false;
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

  private _emit(event: LoaderEvent, value: number): void {
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
      `http://game.local:7777${worldPath("/custom/world", "arena")}/assets`
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
});
