import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import {
  AssetManager,
  AssetKindMismatchError,
  ImageCollectionTilesetError,
  TilesetAsset,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const PKG = join(HERE, "..", "package.json");
const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** Helper: a fresh AssetManager pointed at the fixtures dir. */
function manager(keys: string[] = ["terrain", "ship"]): AssetManager {
  return new AssetManager({ assetsPath: validAssets(keys) });
}

function validAssets(keys: string[]): string {
  const assetsPath = mkdtempSync(join(tmpdir(), "vecs-phaser-assets-"));
  TEMP_DIRS.push(assetsPath);
  mkdirSync(join(assetsPath, "tilesets"));
  for (const key of keys) {
    const metadataName = key === "ship" ? `${key}.json` : `${key}.tsj`;
    copyFileSync(
      join(FIXTURES, "tilesets", metadataName),
      join(assetsPath, "tilesets", metadataName)
    );
    if (key !== "plain") {
      copyFileSync(
        join(FIXTURES, "tilesets", `${key}.png`),
        join(assetsPath, "tilesets", `${key}.png`)
      );
    }
  }
  return assetsPath;
}

describe("AssetManager caching", () => {
  it("returns the SAME handle on a second getTileset(key)", () => {
    const m = manager();
    const a = m.getTileset("terrain");
    const b = m.getTileset("terrain");
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(TilesetAsset);
  });

  it("loads every discovered asset during construction", () => {
    const catalog = manager().toCatalog("main");
    expect(catalog.assets.map((asset) => asset.key).sort()).toEqual(["ship", "terrain"]);
  });

  it("stores loaded assets under namespaced keys", () => {
    const m = manager();
    const assets = (m as unknown as { _assets: Map<string, unknown> })._assets;
    expect([...assets.keys()].sort()).toEqual(["spritesheets/ship", "spritesheets/terrain"]);
    expect(assets.has("terrain")).toBe(false);
  });

  it(".json fallback loads when no .tsj exists", () => {
    const m = manager();
    const ship = m.getTileset("ship");
    expect(ship).toBeInstanceOf(TilesetAsset);
    expect(ship.image).toBe("tilesets/ship.png");
    // second call returns same handle
    expect(m.getTileset("ship")).toBe(ship);
  });
});

describe("AssetManager id assignment", () => {
  it("ids are assigned in alphabetical order by filename and stable across calls", () => {
    const m = manager();
    const terrain = m.getTileset("terrain");
    const ship = m.getTileset("ship");
    expect(ship.id).toBe(1);
    expect(terrain.id).toBe(2);
    expect(m.getTileset("terrain").id).toBe(terrain.id);
    expect(m.getTileset("ship").id).toBe(ship.id);
  });

  it("two keys get distinct stable ids", () => {
    const m = manager();
    const a = m.getTileset("ship");
    const b = m.getTileset("terrain");
    expect(a.id).not.toBe(b.id);
    expect(m.getTileset("ship").id).toBe(a.id);
    expect(m.getTileset("terrain").id).toBe(b.id);
  });
});

describe("AssetManager type guard", () => {
  it("throws AssetKindMismatchError when a non-TilesetAsset is cached under a key", () => {
    const m = manager(["terrain"]);
    // Seed the assets map with a non-TilesetAsset by casting to the internal store.
    const fakeAsset = { id: 99, key: "fake", constructor: { name: "FakeAsset" } } as never;
    (m as unknown as { _assets: Map<string, unknown> })._assets.set("spritesheets/fake", fakeAsset);
    expect(() => m.getTileset("fake")).toThrowError(AssetKindMismatchError);
  });

  it("throws ImageCollectionTilesetError on an image-collection file", () => {
    expect(() => new AssetManager({ assetsPath: FIXTURES })).toThrowError(
      ImageCollectionTilesetError
    );
  });
});

describe("AssetManager.toCatalog", () => {
  it("returns a DTO with spritesheet descriptors and NO server-only metadata", async () => {
    const m = manager();
    const terrain = m.getTileset("terrain");
    const ship = m.getTileset("ship");

    const catalog = m.toCatalog("main");
    expect(catalog.worldName).toBe("main");
    expect(catalog.assets).toHaveLength(2);

    const desc = catalog.assets.find((a) => a.id === terrain.id);
    expect(desc).toBeDefined();
    expect(desc?.kind).toBe("spritesheet");
    expect(desc?.key).toBe("terrain");
    expect(desc?.id).toBe(terrain.id);

    // Spritesheet load fields present.
    const ss = desc as unknown as Record<string, unknown>;
    expect(ss.frameWidth).toBe(32);
    expect(ss.frameHeight).toBe(32);
    expect(ss.margin).toBe(0);
    expect(ss.spacing).toBe(0);
    expect(ss.columns).toBe(4);
    expect(ss.tileCount).toBe(16);
    expect(ss.imageWidth).toBe(128);
    expect(ss.imageHeight).toBe(128);

    // URL matches the documented scheme.
    expect(ss.url).toBe(`/rtc/v1/world/main/assets/files/${terrain.image}`);

    // Server-only metadata stripped from the descriptor.
    expect(ss.properties).toBeUndefined();
    expect(ss.objects).toBeUndefined();
    expect(ss.animation).toBeUndefined();
    expect(ss.class).toBeUndefined();

    // The ship descriptor url also matches the scheme.
    const shipDesc = catalog.assets.find((a) => a.id === ship.id);
    expect(shipDesc?.key).toBe("ship");
    expect((shipDesc as unknown as Record<string, unknown>).url).toBe(
      `/rtc/v1/world/main/assets/files/tilesets/ship.png`
    );
  });

  it("honors a custom apiBasePath", () => {
    const m = manager(["terrain"]);
    const catalog = m.toCatalog("game", "/api/world");
    const ss = catalog.assets.find((asset) => asset.key === "terrain") as unknown as Record<
      string,
      unknown
    >;
    expect(ss.url).toBe(`/api/world/game/assets/files/tilesets/terrain.png`);
  });
});

describe("AssetManager.mount", () => {
  /** Start a real express app on an ephemeral port and return base url + close. */
  function startApp(
    m: AssetManager,
    worldName: string,
    basePath = "/rtc/v1/world"
  ): {
    base: string;
    close: () => Promise<void>;
  } {
    const app = express();
    m.mount(app, worldName, basePath);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const world = basePath.replace(/\/$/, "");
    const base = `http://127.0.0.1:${port}${world}/${encodeURIComponent(worldName)}`;
    return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it("serves the catalog JSON at {worldPath}/assets", async () => {
    const m = manager(["terrain"]);
    const { base, close } = startApp(m, "main");
    try {
      const res = await fetch(`${base}/assets`);
      expect(res.status).toBe(200);
      const catalog = (await res.json()) as { worldName: string; assets: unknown[] };
      expect(catalog.worldName).toBe("main");
      expect(catalog.assets).toHaveLength(1);
      const desc = (catalog.assets[0] as Record<string, unknown>) ?? {};
      expect(desc.kind).toBe("spritesheet");
      expect(desc.url).toBe(`/rtc/v1/world/main/assets/files/tilesets/terrain.png`);
    } finally {
      await close();
    }
  });

  it("serves a static file at {worldPath}/assets/files/<image>", async () => {
    const m = manager(["terrain"]);
    const { base, close } = startApp(m, "main");
    try {
      const res = await fetch(`${base}/assets/files/tilesets/terrain.png`);
      expect(res.status).toBe(200);
      const buf = Buffer.from(await res.arrayBuffer());
      // The placeholder PNG starts with the 8-byte PNG signature.
      expect(Array.from(buf.subarray(0, 8))).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
    } finally {
      await close();
    }
  });
});

describe("package.json has no @kayahr/tiled dependency", () => {
  it("does not list @kayahr/tiled anywhere", () => {
    const pkg = JSON.parse(readFileSync(PKG, "utf8")) as Record<string, Record<string, unknown>>;
    const deps = pkg.dependencies ?? {};
    const devDeps = pkg.devDependencies ?? {};
    const peerDeps = pkg.peerDependencies ?? {};
    expect(deps["@kayahr/tiled"]).toBeUndefined();
    expect(devDeps["@kayahr/tiled"]).toBeUndefined();
    expect(peerDeps["@kayahr/tiled"]).toBeUndefined();
    // express is present as peer + dev.
    expect(peerDeps["express"]).toBeDefined();
    expect(devDeps["express"]).toBeDefined();
  });
});
