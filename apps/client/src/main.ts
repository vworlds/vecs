import { ClientWorld } from "@vworlds/vecs-client";
import { phaserNetworkComponents } from "@vworlds/vecs-phaser";
import {
  type Catalog,
  CoordSpace,
  PhaserRenderModule,
  loadAssets,
  phaserInterpolators,
} from "@vworlds/vecs-phaser-client";
import Phaser from "phaser";

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 540;
const GRID_COLUMNS = 3;
const GRID_ROWS = 3;
const LOCAL_ENTITY_START = 100_000;
const PIXELS_PER_METER = 100;
const RECONNECT_DELAY_MS = 1_000;
const VIEW_ALL_KEY = "g";
const WORLD_HALF_WIDTH_METERS = CANVAS_WIDTH / PIXELS_PER_METER / 2;
const WORLD_HALF_HEIGHT_METERS = CANVAS_HEIGHT / PIXELS_PER_METER / 2;

interface VecsConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly protocol: "http" | "https";
  readonly worldName: string;
  readonly apiBasePath?: string;
}

declare global {
  interface Window {
    vecsConnectionOptions?: Partial<VecsConnectionOptions>;
  }
}

const connectionOptions = readConnectionOptions();

interface Session {
  readonly scene: DemoScene;
  readonly world: ClientWorld;
}

const keys = new Set<string>();
let activeSession: Session | undefined;
let connectionStatus = "Connecting to vecs demo server...";
let connectGeneration = 0;
let reconnectTimer: number | undefined;
let viewAll = true;

window.addEventListener("keydown", (event) => {
  if (isArrowKey(event.key)) {
    event.preventDefault();
    keys.add(event.key);
    return;
  }
  if (isViewAllKey(event.key) && !event.repeat) {
    event.preventDefault();
    viewAll = !viewAll;
  }
});

window.addEventListener("keyup", (event) => {
  if (isArrowKey(event.key)) {
    event.preventDefault();
    keys.delete(event.key);
  }
});

class BootScene extends Phaser.Scene {
  private _barFill: Phaser.GameObjects.Rectangle | undefined;
  private _statusText: Phaser.GameObjects.Text | undefined;

  public constructor() {
    super("BootScene");
  }

  public create(): void {
    const barWidth = 320;
    const barHeight = 24;
    const centerX = this.scale.width / 2;
    const centerY = this.scale.height / 2;

    this.add
      .rectangle(centerX, centerY, barWidth + 4, barHeight + 4, 0x334155)
      .setStrokeStyle(2, 0x64748b)
      .setDepth(1);
    this._barFill = this.add
      .rectangle(centerX - barWidth / 2, centerY, 0, barHeight, 0x66ccff)
      .setOrigin(0, 0.5)
      .setDepth(2);
    this._statusText = this.add
      .text(centerX, centerY + barHeight + 18, "Loading assets... 0%", {
        color: "#e2e8f0",
        fontFamily: "sans-serif",
        fontSize: "14px",
      })
      .setOrigin(0.5, 0)
      .setDepth(2);

    void this.loadCatalog();
  }

  private async loadCatalog(): Promise<void> {
    try {
      const catalog = await loadAssets(this, {
        ...connectionOptions,
        onProgress: (value) => this.updateProgress(value),
      });
      this.scene.start("DemoScene", { catalog });
    } catch (err: unknown) {
      this._statusText?.setText(`Asset load failed: ${formatError(err)}. Retrying...`);
      this.time.delayedCall(RECONNECT_DELAY_MS, () => void this.loadCatalog());
    }
  }

  private updateProgress(value: number): void {
    const barWidth = 320;
    if (this._barFill) {
      this._barFill.width = barWidth * value;
    }
    const percent = Math.round(value * 100);
    this._statusText?.setText(`Loading assets... ${percent}%`);
  }
}

class DemoScene extends Phaser.Scene {
  private _catalog: Catalog | undefined;
  private _instructionsText: Phaser.GameObjects.Text | undefined;
  private _statusText: Phaser.GameObjects.Text | undefined;

  public constructor() {
    super("DemoScene");
  }

  public init(data: unknown): void {
    this._catalog = (data as { catalog?: Catalog }).catalog;
  }

  /** Resolved asset catalog handed over by the boot scene; persists across reconnects. */
  public get catalog(): Catalog | undefined {
    return this._catalog;
  }

  public create(): void {
    const coords = new CoordSpace(this, PIXELS_PER_METER);

    this.drawGrid(coords);
    this._instructionsText = this.add
      .text(20, 20, "", {
        color: "#e2e8f0",
        fontFamily: "sans-serif",
        fontSize: "16px",
      })
      .setDepth(10_000);
    this._statusText = this.add
      .text(20, 48, "", {
        color: "#fecaca",
        fontFamily: "sans-serif",
        fontSize: "16px",
      })
      .setDepth(10_000);

    void connect(this);
  }

  public override update(time: number, delta: number): void {
    this.updateChrome();

    if (!activeSession) {
      return;
    }

    activeSession.world.setInput({
      left: keys.has("ArrowLeft"),
      right: keys.has("ArrowRight"),
      up: keys.has("ArrowUp"),
      down: keys.has("ArrowDown"),
      viewAll,
    });
    activeSession.world.progress(time, delta);
  }

  private drawGrid(coords: CoordSpace): void {
    const graphics = this.add.graphics().setDepth(-10_000);
    graphics.lineStyle(1, 0x334155, 1);
    graphics.beginPath();

    for (let column = 1; column < GRID_COLUMNS; column++) {
      const xMeters =
        -WORLD_HALF_WIDTH_METERS + (column * CANVAS_WIDTH) / GRID_COLUMNS / PIXELS_PER_METER;
      graphics.moveTo(coords.x(xMeters), coords.y(WORLD_HALF_HEIGHT_METERS));
      graphics.lineTo(coords.x(xMeters), coords.y(-WORLD_HALF_HEIGHT_METERS));
    }

    for (let row = 1; row < GRID_ROWS; row++) {
      const yMeters =
        WORLD_HALF_HEIGHT_METERS - (row * CANVAS_HEIGHT) / GRID_ROWS / PIXELS_PER_METER;
      graphics.moveTo(coords.x(-WORLD_HALF_WIDTH_METERS), coords.y(yMeters));
      graphics.lineTo(coords.x(WORLD_HALF_WIDTH_METERS), coords.y(yMeters));
    }

    graphics.strokePath();
  }

  private updateChrome(): void {
    this._instructionsText?.setText(
      `vecs-client: arrows move, G toggles ${viewAll ? "all entities" : "nearby grid view"}`
    );
    this._statusText?.setText(activeSession ? "" : connectionStatus);
  }
}

new Phaser.Game({
  backgroundColor: "#020617",
  height: CANVAS_HEIGHT,
  parent: "game",
  scene: [BootScene, DemoScene],
  type: Phaser.AUTO,
  width: CANVAS_WIDTH,
});

async function connect(scene: DemoScene): Promise<void> {
  const generation = ++connectGeneration;
  connectionStatus = "Connecting to vecs demo server...";

  try {
    const session = await createSession(scene);
    if (generation !== connectGeneration) {
      session.world.clearAllEntities();
      session.world.close();
      return;
    }

    activeSession = session;
    connectionStatus = "Connected";
    session.world.events.on("disconnect", () => handleDisconnect(session));
  } catch (err: unknown) {
    if (generation === connectGeneration) {
      scheduleReconnect(`Connection failed: ${formatError(err)}`, scene);
    }
  }
}

async function createSession(scene: DemoScene): Promise<Session> {
  const world = await ClientWorld.connectDgram({
    ...connectionOptions,
    interpolators: phaserInterpolators(),
    localEntityIdStart: LOCAL_ENTITY_START,
    networkComponents: phaserNetworkComponents,
  });
  world.module(PhaserRenderModule, {
    catalog: scene.catalog,
    pixelsPerMeter: PIXELS_PER_METER,
    scene,
  });

  return { scene, world };
}

function handleDisconnect(session: Session): void {
  if (activeSession !== session) {
    return;
  }

  keys.clear();
  session.world.clearAllEntities();
  activeSession = undefined;
  scheduleReconnect("Disconnected. Reconnecting...", session.scene);
}

function scheduleReconnect(status: string, scene: DemoScene): void {
  keys.clear();
  connectionStatus = status;
  activeSession = undefined;
  if (reconnectTimer !== undefined) {
    return;
  }
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    void connect(scene);
  }, RECONNECT_DELAY_MS);
}

function isArrowKey(key: string): boolean {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
}

function isViewAllKey(key: string): boolean {
  return key.toLowerCase() === VIEW_ALL_KEY;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
