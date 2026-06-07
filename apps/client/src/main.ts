import { ClientWorld } from "@vworlds/vecs-client";
import { type as wireType } from "@vworlds/vecs-wire";

const LOCAL_ENTITY_START = 100_000;
const PLAYER_SIZE = 28;
const RECONNECT_DELAY_MS = 1_000;
const SERVER_PORT = 3000;
const GAME_TOP = 60;
const GRID_COLUMNS = 3;
const GRID_ROWS = 3;
const VIEW_ALL_KEY = "g";

type Session = ClientWorld;

class Position {
  @wireType("i16")
  public x = 0;

  @wireType("i16")
  public y = 0;
}

class Player {
  @wireType("u32")
  public score = 0;
}

class Ball {
  @wireType("u8")
  public radius = 12;
}

class Color {
  @wireType("u32")
  public value = 0xffffff;
}

const keys = new Set<string>();
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

const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (!canvas) {
  throw new Error("Missing #game canvas");
}
const gameCanvas = canvas;

const ctx = canvas.getContext("2d");
if (!ctx) {
  throw new Error("2d canvas context unavailable");
}
const context = ctx;

let activeSession: Session | undefined;
let connectionStatus = "Connecting to vecs demo server...";
let connectGeneration = 0;
let lastFrameTime = performance.now();
let reconnectTimer: number | undefined;

void connect();
requestAnimationFrame(frame);

async function connect(): Promise<void> {
  const generation = ++connectGeneration;
  connectionStatus = "Connecting to vecs demo server...";

  try {
    const session = await createSession();
    if (generation !== connectGeneration) {
      session.close();
      return;
    }

    activeSession = session;
    connectionStatus = "Connected";
    session.events.on("disconnect", () => handleDisconnect(session));
  } catch (err: unknown) {
    if (generation === connectGeneration) {
      scheduleReconnect(`Connection failed: ${formatError(err)}`);
    }
  }
}

async function createSession(): Promise<Session> {
  const client = await ClientWorld.connectDgram({
    networkComponents: [Position, Player, Ball, Color],
    localEntityIdStart: LOCAL_ENTITY_START,
    host: location.hostname,
    port: SERVER_PORT,
    worldName: "main",
  });
  client.installSystems();

  installRenderSystems(client);
  client.start();

  return client;
}

function installRenderSystems(world: ClientWorld): void {
  world
    .system("RenderBalls")
    .with(Position, Ball, Color)
    .each([Position, Ball, Color], (_entity, [position, ball, color]) => {
      context.beginPath();
      context.arc(position.x, position.y, ball.radius, 0, Math.PI * 2);
      context.fillStyle = `#${color.value.toString(16).padStart(6, "0")}`;
      context.fill();
      context.strokeStyle = "#0f172a";
      context.lineWidth = 3;
      context.stroke();
    });

  world
    .system("RenderPlayers")
    .with(Position, Player)
    .each([Position, Player], (_entity, [position, player]) => {
      context.fillStyle = "#facc15";
      context.fillRect(position.x, position.y, PLAYER_SIZE, PLAYER_SIZE);
      context.strokeStyle = "#422006";
      context.lineWidth = 3;
      context.strokeRect(position.x, position.y, PLAYER_SIZE, PLAYER_SIZE);
      context.fillStyle = "#fefce8";
      context.font = "14px sans-serif";
      context.fillText(String(player.score), position.x + 8, position.y - 8);
    });
}

function handleDisconnect(session: Session): void {
  if (activeSession !== session) {
    return;
  }

  keys.clear();
  session.clearAllEntities();
  activeSession = undefined;
  scheduleReconnect("Disconnected. Reconnecting...");
}

function scheduleReconnect(status: string): void {
  keys.clear();
  connectionStatus = status;
  activeSession = undefined;
  if (reconnectTimer !== undefined) {
    return;
  }
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, RECONNECT_DELAY_MS);
}

function frame(now: number): void {
  const delta = now - lastFrameTime;
  lastFrameTime = now;

  context.fillStyle = "#020617";
  context.fillRect(0, 0, gameCanvas.width, gameCanvas.height);
  drawGrid();
  context.fillStyle = "#e2e8f0";
  context.font = "16px sans-serif";
  context.fillText(
    `vecs-client: arrows move, G toggles ${viewAll ? "all entities" : "nearby grid view"}`,
    20,
    30
  );

  if (activeSession) {
    activeSession.setInput({
      left: keys.has("ArrowLeft"),
      right: keys.has("ArrowRight"),
      up: keys.has("ArrowUp"),
      down: keys.has("ArrowDown"),
      viewAll,
    });
    activeSession.progress(now, delta);
  } else {
    context.fillStyle = "#fecaca";
    context.fillText(connectionStatus, 20, 60);
  }

  requestAnimationFrame(frame);
}

function drawGrid(): void {
  const cellWidth = gameCanvas.width / GRID_COLUMNS;
  const cellHeight = (gameCanvas.height - GAME_TOP) / GRID_ROWS;

  context.strokeStyle = "#334155";
  context.lineWidth = 1;
  context.beginPath();
  for (let column = 1; column < GRID_COLUMNS; column++) {
    const x = column * cellWidth;
    context.moveTo(x, GAME_TOP);
    context.lineTo(x, gameCanvas.height);
  }
  for (let row = 0; row <= GRID_ROWS; row++) {
    const y = GAME_TOP + row * cellHeight;
    context.moveTo(0, y);
    context.lineTo(gameCanvas.width, y);
  }
  context.stroke();
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
