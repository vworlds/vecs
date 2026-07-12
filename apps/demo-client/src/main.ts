/**
 * Tank Arena — client entry point.
 *
 * This file is deliberately small: the client is THIN. It owns exactly four
 * responsibilities —
 *
 *   1. load the server's asset catalog (BootScene),
 *   2. connect a `ClientWorld` and register the vecs-phaser client modules,
 *   3. capture input (`InputCaptureModule` — keyboard + pointer/touch),
 *   4. drive `world.progress()` from Phaser's update loop.
 *
 * Everything you SEE and HEAR — tanks, shells, walls, explosions, HUD text,
 * sounds, your camera — is replicated server state rendered automatically by
 * `PhaserRenderModule`, `CameraModule`, `AudioModule`, and `EffectsModule`.
 * There is no per-entity render code and no gameplay logic here.
 */
import Phaser from "phaser";
import { ClientWorld } from "@vworlds/vecs-client";
import { phaserNetworkComponents } from "@vworlds/vecs-phaser";
import {
  AudioModule,
  CameraModule,
  EffectsModule,
  InputCaptureModule,
  loadAssets,
  PhaserRenderModule,
  phaserInterpolators,
  type Catalog,
} from "@vworlds/vecs-phaser-client";

/** Must match the server's PIXELS_PER_METER (see apps/demo-server config). */
const PIXELS_PER_METER = 100;

/**
 * The shared action order — MUST match the server's INPUT_ACTIONS. The key
 * lists are Phaser key names; add alternatives freely (WASD + arrows here).
 */
const ACTIONS = {
  left: ["A", "LEFT"],
  right: ["D", "RIGHT"],
  up: ["W", "UP"],
  down: ["S", "DOWN"],
  fire: ["SPACE"],
} as const;

interface VecsConnectionOptions {
  host: string;
  port: number;
  protocol: "http" | "https";
  worldName: string;
  apiBasePath?: string;
}

declare global {
  interface Window {
    vecsConnectionOptions?: Partial<VecsConnectionOptions>;
  }
}

const connectionOptions = readConnectionOptions();

/**
 * Loads every catalog asset (spritesheets, animations, sounds) before the
 * world connects, so no state diff can ever reference a missing texture.
 */
class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  public create(): void {
    const { height, width } = this.scale;
    const bar = this.add.rectangle(width / 2, height / 2, 4, 12, 0x66ccff);
    this.add.text(width / 2, height / 2 - 24, "loading assets…", { fontSize: 14 }).setOrigin(0.5);

    void loadAssets(this, {
      ...connectionOptions,
      onProgress: (value) => bar.setSize(4 + value * 240, 12),
    })
      .then((catalog) => this.scene.start("Game", { catalog }))
      .catch((error) => {
        console.error("asset load failed; retrying in 1s", error);
        this.time.delayedCall(1000, () => this.scene.restart());
      });
  }
}

/**
 * The gameplay scene: connects the world, registers the vecs-phaser client
 * modules, and pumps `world.progress`. Reconnects with a fresh world on
 * disconnect (the module registrations die with the old world).
 */
class GameScene extends Phaser.Scene {
  private catalog!: Catalog;
  private world: ClientWorld | undefined;
  private generation = 0;

  constructor() {
    super("Game");
  }

  public init(data: { catalog: Catalog }): void {
    this.catalog = data.catalog;
  }

  public create(): void {
    void this.connect();
  }

  public override update(time: number, delta: number): void {
    // One call per frame: applies received diffs (with interpolation),
    // runs every registered module system, and captures/sends input.
    this.world?.progress(time, delta);
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    try {
      const world = await ClientWorld.connectDgram({
        ...connectionOptions,
        interpolators: phaserInterpolators(),
        networkComponents: phaserNetworkComponents,
      });
      if (generation !== this.generation) {
        world.close();
        return;
      }

      // The four client modules; each is independent and optional.
      world.module(PhaserRenderModule, {
        catalog: this.catalog,
        pixelsPerMeter: PIXELS_PER_METER,
        scene: this,
      });
      world.module(CameraModule, { pixelsPerMeter: PIXELS_PER_METER, scene: this });
      world.module(AudioModule, { scene: this });
      world.module(EffectsModule, { pixelsPerMeter: PIXELS_PER_METER, scene: this });
      world.module(InputCaptureModule, {
        actions: ACTIONS,
        pixelsPerMeter: PIXELS_PER_METER,
        scene: this,
      });

      world.events.on("disconnect", () => {
        if (generation !== this.generation) {
          return;
        }
        world.clearAllEntities();
        this.world = undefined;
        this.time.delayedCall(1000, () => void this.connect());
      });

      this.world = world;
    } catch (error) {
      console.error("connect failed; retrying in 1s", error);
      if (generation === this.generation) {
        this.time.delayedCall(1000, () => void this.connect());
      }
    }
  }
}

new Phaser.Game({
  backgroundColor: "#1d2129",
  height: 540,
  parent: "game",
  scene: [BootScene, GameScene],
  type: Phaser.AUTO,
  width: 960,
});

function readConnectionOptions(): VecsConnectionOptions {
  const options = window.vecsConnectionOptions;
  return {
    host: options?.host ?? window.location.hostname,
    port: options?.port ?? 3000,
    protocol: options?.protocol ?? (window.location.protocol === "https:" ? "https" : "http"),
    worldName: options?.worldName ?? "main",
    apiBasePath: options?.apiBasePath,
  };
}
