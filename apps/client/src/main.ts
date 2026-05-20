import { VecsClient } from "@vworlds/vecs-client";
import { World } from "@vworlds/vecs";
import { type as wireType } from "@vworlds/vecs-wire";

const POSITION_TYPE = 1;
const PLAYER_TYPE = 2;
const BALL_TYPE = 3;
const LOCAL_ENTITY_START = 100_000;
const PLAYER_SIZE = 28;
const RECONNECT_DELAY_MS = 1_000;
const SERVER_PORT = 3000;

interface Session {
  client: VecsClient;
  world: World;
}

class Position {
  @wireType("u16")
  public x = 0;

  @wireType("u16")
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

const keys = new Set<string>();

window.addEventListener("keydown", (event) => {
  if (isArrowKey(event.key)) {
    event.preventDefault();
    keys.add(event.key);
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
      session.client.close();
      return;
    }

    activeSession = session;
    connectionStatus = "Connected";
    session.client.onDisconnect(() => handleDisconnect(session));
  } catch (err: unknown) {
    if (generation === connectGeneration) {
      scheduleReconnect(`Connection failed: ${formatError(err)}`);
    }
  }
}

async function createSession(): Promise<Session> {
  const world = new World();
  world.setEntityIdRange(LOCAL_ENTITY_START);
  world.registerComponent(Position, POSITION_TYPE);
  world.registerComponent(Player, PLAYER_TYPE);
  world.registerComponent(Ball, BALL_TYPE);

  const client = await VecsClient.connectDgram({
    world,
    host: location.hostname,
    port: SERVER_PORT,
    worldName: "main",
    localEntityIdStart: LOCAL_ENTITY_START,
  });
  client.registerComponent(Position);
  client.registerComponent(Player);
  client.registerComponent(Ball);
  client.installSystems();

  installRenderSystems(world);
  world.start();

  return { client, world };
}

function installRenderSystems(world: World): void {
  world
    .system("RenderBalls")
    .requires(Position, Ball)
    .each([Position, Ball], (_entity, [position, ball]) => {
      context.beginPath();
      context.arc(position.x, position.y, ball.radius, 0, Math.PI * 2);
      context.fillStyle = "#7dd3fc";
      context.fill();
      context.strokeStyle = "#0f172a";
      context.lineWidth = 3;
      context.stroke();
    });

  world
    .system("RenderPlayers")
    .requires(Position, Player)
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
  session.world.clearAllEntities();
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
  context.fillStyle = "#e2e8f0";
  context.font = "16px sans-serif";
  context.fillText("vecs-client: arrow keys move your square, eat balls to score", 20, 30);

  if (activeSession) {
    activeSession.client.setInput({
      left: keys.has("ArrowLeft"),
      right: keys.has("ArrowRight"),
      up: keys.has("ArrowUp"),
      down: keys.has("ArrowDown"),
    });
    activeSession.world.progress(now, delta);
  } else {
    context.fillStyle = "#fecaca";
    context.fillText(connectionStatus, 20, 60);
  }

  requestAnimationFrame(frame);
}

function isArrowKey(key: string): boolean {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
