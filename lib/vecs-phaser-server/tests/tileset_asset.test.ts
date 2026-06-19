import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Tile, TilesetAsset } from "../src/index.js";
import { AssetManager } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

/** Helper: a fresh AssetManager pointed at the fixtures dir. */
function manager(): AssetManager {
  return new AssetManager({ assetsPath: FIXTURES });
}

describe("TilesetAsset (terrain fixture)", () => {
  it("returns a live TilesetAsset instance with spritesheet fields matching the fixture", () => {
    const ts = manager().getTileset("terrain");
    expect(ts).toBeInstanceOf(TilesetAsset);
    expect(ts.frameWidth).toBe(32);
    expect(ts.frameHeight).toBe(32);
    expect(ts.margin).toBe(0);
    expect(ts.spacing).toBe(0);
    expect(ts.columns).toBe(4);
    expect(ts.tileCount).toBe(16);
    expect(ts.imageWidth).toBe(128);
    expect(ts.imageHeight).toBe(128);
    expect(ts.image).toBe("tilesets/terrain.png");
    expect(ts.name).toBe("terrain");
    expect(ts.class).toBe("TerrainTileset");
    expect(ts.sizeInMeters(100)).toEqual({ w: 0.32, h: 0.32 });
  });

  it("falls back to .json when no .tsj exists", () => {
    const ts = manager().getTileset("ship");
    expect(ts).toBeInstanceOf(TilesetAsset);
    expect(ts.frameWidth).toBe(32);
    expect(ts.frameHeight).toBe(32);
    expect(ts.margin).toBe(1);
    expect(ts.spacing).toBe(1);
    expect(ts.columns).toBe(2);
    expect(ts.tileCount).toBe(4);
    expect(ts.imageWidth).toBe(64);
    expect(ts.imageHeight).toBe(64);
    expect(ts.image).toBe("tilesets/ship.png");
    expect(ts.name).toBe("ship");
  });

  it("tile(id) returns a live Tile with captured class, typed properties, objects Map, and animation", () => {
    const ts = manager().getTileset("terrain");
    const tile = ts.tile(5);
    expect(tile).toBeInstanceOf(Tile);
    expect(tile?.id).toBe(5);
    expect(tile?.class).toBe("Wall");

    // Typed properties preserved (not flattened): { name, type, value } intact.
    const props = tile?.properties ?? [];
    expect(props).toHaveLength(2);
    const hp = props.find((p) => p.name === "hp");
    expect(hp).toEqual({ name: "hp", type: "int", value: 100 });
    const tint = props.find((p) => p.name === "tint");
    expect(tint).toEqual({ name: "tint", type: "color", value: "#ffaa00ff" });

    // objects is a Map keyed by MapObject.id with shape flags + x/y/width/height/rotation.
    const objects = tile?.objects;
    expect(objects).toBeInstanceOf(Map);
    expect(objects?.size).toBe(5);

    const rect = objects?.get(1);
    expect(rect?.id).toBe(1);
    expect(rect?.name).toBe("body");
    expect(rect?.type).toBe("Rect");
    expect(rect?.x).toBe(0);
    expect(rect?.y).toBe(0);
    expect(rect?.width).toBe(32);
    expect(rect?.height).toBe(32);
    expect(rect?.rotation).toBe(0);
    expect(rect?.ellipse).toBe(false);
    expect(rect?.point).toBe(false);
    expect(rect?.polygon).toEqual([]);
    expect(rect?.polyline).toEqual([]);

    const ellipse = objects?.get(2);
    expect(ellipse?.ellipse).toBe(true);
    expect(ellipse?.width).toBe(16);
    expect(ellipse?.height).toBe(16);

    const poly = objects?.get(3);
    expect(poly?.rotation).toBe(45);
    expect(poly?.polygon).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: 0 },
      { x: 16, y: 32 },
    ]);
    expect(poly?.polyline).toEqual([]);

    const polyline = objects?.get(4);
    expect(polyline?.polyline).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: 32 },
    ]);
    expect(polyline?.polygon).toEqual([]);

    const point = objects?.get(5);
    expect(point?.point).toBe(true);
    expect(point?.x).toBe(16);
    expect(point?.y).toBe(16);

    // animation captured.
    expect(tile?.animation).toEqual([
      { tileid: 5, duration: 100 },
      { tileid: 6, duration: 100 },
    ]);
  });

  it("tile(id) returns undefined for a missing id", () => {
    const ts = manager().getTileset("terrain");
    expect(ts.tile(999)).toBeUndefined();
  });

  it("NON-NULL DEFAULTS: a tile that omits properties/objectgroup/class/animation exposes empty defaults — never undefined", () => {
    const ts = manager().getTileset("terrain");
    // tile id 9 has no class/properties/objectgroup/animation in the fixture.
    const tile = ts.tile(9);
    expect(tile).toBeInstanceOf(Tile);
    expect(tile?.class).toBe("");
    expect(tile?.properties).toEqual([]);
    expect(tile?.objects).toBeInstanceOf(Map);
    expect(tile?.objects?.size).toBe(0);
    expect(tile?.animation).toEqual([]);
  });

  it("NON-NULL DEFAULTS: a tile with only `type` (old Tiled alias) maps to class and empty defaults", () => {
    const ts = manager().getTileset("terrain");
    const tile = ts.tile(6);
    expect(tile?.class).toBe("OldStyleClass");
    expect(tile?.properties).toEqual([]);
    expect(tile?.objects?.size).toBe(0);
    expect(tile?.animation).toEqual([]);
  });

  it("NON-NULL DEFAULTS: the tileset preserves its own properties array", () => {
    const ts = manager().getTileset("terrain");
    expect(ts.properties).toHaveLength(2);
    expect(ts.properties[0]).toEqual({ name: "author", type: "string", value: "vecs" });
    expect(ts.properties[1]).toEqual({ name: "version", type: "int", value: 1 });
  });

  it("sizeInMeters(ppm) returns { w: frameWidth/ppm, h: frameHeight/ppm }", () => {
    const ts = manager().getTileset("terrain");
    expect(ts.sizeInMeters(16)).toEqual({ w: 2, h: 2 });
    expect(ts.sizeInMeters(100)).toEqual({ w: 0.32, h: 0.32 });
  });

  it("rejects an image-collection tileset (tiles carry their own image)", () => {
    const m = manager();
    expect(() => m.getTileset("collection")).toThrowError(/image-collection/);
  });

  it("throws TilesetNotFoundError for a missing key", () => {
    expect(() => manager().getTileset("nope")).toThrow();
  });
});
