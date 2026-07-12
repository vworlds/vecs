import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AudioDescriptor } from "@vworlds/vecs-phaser";

import { Asset } from "./asset.js";
import { AudioNotFoundError } from "./asset_errors.js";

/**
 * An audio file asset (`assets/audio/<key>.<ext>`). Only metadata (the file
 * path) is read server-side; bytes are served over HTTP by
 * `AssetManager.mount` and loaded by the client's Phaser audio loader.
 */
export class AudioAsset extends Asset {
  /** Directory under `assetsPath` where audio files live. */
  public static readonly assetDirectory = "audio";

  /** AssetManager namespace. */
  public static readonly assetNamespace = "audio";

  /** Recognized audio extensions, in preference order when a key has several. */
  public static readonly supportedExtensions = [".ogg", ".mp3", ".wav", ".m4a"] as const;

  /** Audio file path relative to `assetsPath`, POSIX-separated. */
  public readonly file: string;

  private constructor(key: string, file: string) {
    super(key);
    this.file = file;
  }

  /**
   * Load an `AudioAsset` by human key from `assetsPath/audio`, checking the
   * supported extensions in preference order.
   *
   * @throws {AudioNotFoundError} when no supported file exists for `key`.
   */
  public static load(assetsPath: string, key: string): AudioAsset {
    for (const extension of AudioAsset.supportedExtensions) {
      const fileName = `${key}${extension}`;
      if (existsSync(join(assetsPath, AudioAsset.assetDirectory, fileName))) {
        return new AudioAsset(key, `${AudioAsset.assetDirectory}/${fileName}`);
      }
    }
    throw new AudioNotFoundError(
      `No audio "${key}" found under ${join(assetsPath, AudioAsset.assetDirectory)}`
    );
  }

  /** Build this audio asset's catalog descriptor. */
  public descriptor(): AudioDescriptor {
    return { id: this.id, kind: "audio", file: this.file };
  }
}
