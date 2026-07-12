import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { AssetManager, AudioAsset, AudioNotFoundError } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function audioAssets(files: string[] = ["blip.ogg", "theme.mp3"]): string {
  const assetsPath = mkdtempSync(join(tmpdir(), "vecs-phaser-audio-"));
  TEMP_DIRS.push(assetsPath);
  mkdirSync(join(assetsPath, "audio"));
  for (const file of files) {
    copyFileSync(join(FIXTURES, "audio", file), join(assetsPath, "audio", file));
  }
  return assetsPath;
}

describe("AudioAsset via AssetManager", () => {
  it("loads audio files by key with stable ids and asset-root-relative paths", () => {
    const manager = new AssetManager({ assetsPath: audioAssets() });

    const blip = manager.getAudio("blip");
    const theme = manager.getAudio("theme");

    expect(blip).toBeInstanceOf(AudioAsset);
    expect(blip.file).toBe("audio/blip.ogg");
    expect(theme.file).toBe("audio/theme.mp3");
    expect(blip.id).not.toBe(theme.id);
    expect(manager.getAudio("blip")).toBe(blip); // cached handle
  });

  it("emits audio descriptors in the catalog DTO", () => {
    const manager = new AssetManager({ assetsPath: audioAssets(["blip.ogg"]) });
    const blip = manager.getAudio("blip");

    const catalog = manager.toCatalog("main");
    expect(catalog.assets).toContainEqual({ id: blip.id, kind: "audio", file: "audio/blip.ogg" });
  });

  it("throws AudioNotFoundError for a missing key", () => {
    const manager = new AssetManager({ assetsPath: audioAssets(["blip.ogg"]) });
    expect(() => manager.getAudio("nope")).toThrow(AudioNotFoundError);
  });

  it("keeps audio and tileset namespaces separate", () => {
    const assetsPath = audioAssets(["blip.ogg"]);
    mkdirSync(join(assetsPath, "tilesets"));
    copyFileSync(
      join(FIXTURES, "tilesets", "terrain.tsj"),
      join(assetsPath, "tilesets", "terrain.tsj")
    );
    const manager = new AssetManager({ assetsPath });

    expect(manager.getAudio("blip").file).toBe("audio/blip.ogg");
    expect(manager.getTileset("terrain").name).toBe("terrain");
    expect(() => manager.getAudio("terrain")).toThrow(AudioNotFoundError);
  });
});
