import { describe, expect, it } from "vitest";
import {
  type AssetCatalog,
  type AssetDescriptor,
  type SpritesheetDescriptor,
} from "../src/catalog.js";

type IsAssignable<T, U> = T extends U ? true : false;
type IsNotAssignable<T, U> = T extends U ? false : true;

function assertType<T extends true>(): void {}

describe("asset catalog type contract", () => {
  it("accepts complete spritesheet descriptors", () => {
    const spritesheet = {
      id: 7,
      key: "terrain",
      kind: "spritesheet",
      image: "tilesets/terrain.png",
      frameWidth: 16,
      frameHeight: 16,
      margin: 1,
      spacing: 2,
      columns: 8,
      tileCount: 64,
      imageWidth: 128,
      imageHeight: 128,
    } satisfies SpritesheetDescriptor;

    expect(spritesheet.kind).toBe("spritesheet");
    expect(spritesheet.frameWidth).toBe(16);
    expect(spritesheet.tileCount).toBe(64);
  });

  it("narrows heterogeneous catalog assets by kind", () => {
    const spritesheet = {
      id: 7,
      key: "terrain",
      kind: "spritesheet",
      image: "tilesets/terrain.png",
      frameWidth: 16,
      frameHeight: 16,
      margin: 1,
      spacing: 2,
      columns: 8,
      tileCount: 64,
      imageWidth: 128,
      imageHeight: 128,
    } satisfies SpritesheetDescriptor;
    const assets = [spritesheet] satisfies AssetDescriptor[];
    const catalog = {
      worldName: "demo",
      assets,
    } satisfies AssetCatalog;
    const images: string[] = [];

    for (const asset of catalog.assets) {
      if (asset.kind === "spritesheet") {
        images.push(asset.image);
      }
    }

    expect(catalog.worldName).toBe("demo");
    expect(images).toEqual(["tilesets/terrain.png"]);
  });

  it("keeps kind as the only base discriminant", () => {
    const baseOnly = {
      id: 7,
      key: "terrain",
      kind: "spritesheet",
    } satisfies AssetDescriptor;

    assertType<IsAssignable<typeof baseOnly, AssetDescriptor>>();
    assertType<IsNotAssignable<typeof baseOnly, SpritesheetDescriptor>>();

    expect(baseOnly.kind).toBe("spritesheet");
    expect(baseOnly.id).toBe(7);
  });
});
