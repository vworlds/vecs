import express from "express";
import { type as wireType } from "@vworlds/vecs-wire";
import {
  NetworkClient,
  NetworkInput,
  Networked,
  VecsListener,
  VecsServer,
  View,
} from "@vworlds/vecs-server";
import { type ComponentClass, World } from "@vworlds/vecs";

const POSITION_TYPE = 1;
const PLAYER_TYPE = 2;
const BALL_TYPE = 3;
const COLOR_TYPE = 4;
const PORT = Number(process.env.PORT ?? 3000);
const WIDTH = 960;
const HEIGHT = 540;
const GAME_TOP = 60;
const GRID_COLUMNS = 3;
const GRID_ROWS = 3;
const GRID_CELL_COUNT = GRID_COLUMNS * GRID_ROWS;
const GRID_CELL_WIDTH = WIDTH / GRID_COLUMNS;
const GRID_CELL_HEIGHT = (HEIGHT - GAME_TOP) / GRID_ROWS;
const PLAYER_SIZE = 28;
const PLAYER_STEP = 7;
const MAX_BALLS = 12;
const BALL_RADIUS = 12;
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const DT_MS = 1000 / TICK_RATE;
let playerSpawnIndex = 0;

interface PlayerInput {
  left?: boolean;
  right?: boolean;
  up?: boolean;
  down?: boolean;
}

class Position {
  @wireType("u16")
  public x = 0;

  @wireType("u16")
  public y = 0;
}

class Velocity {
  public x = 0;
  public y = 0;
}

class Player {
  @wireType("u32")
  public score = 0;
}

class Ball {
  @wireType("u8")
  public radius = BALL_RADIUS;
}

class Color {
  @wireType("u8")
  public r = 255;

  @wireType("u8")
  public g = 255;

  @wireType("u8")
  public b = 255;
}

const gridCellComponents: ComponentClass[] = Array.from(
  { length: GRID_CELL_COUNT },
  () => class GridCell {}
);

const world = new World();
world.registerComponent(Networked);
world.registerComponent(Position, POSITION_TYPE);
world.registerComponent(Player, PLAYER_TYPE);
world.registerComponent(Ball, BALL_TYPE);
world.registerComponent(Color, COLOR_TYPE);
world.registerComponent(Velocity);
gridCellComponents.forEach((GridCell, index) => {
  world.registerComponent(GridCell, getGridCellComponentName(index));
});
world.setExclusiveComponents(...gridCellComponents);

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const vecsListener = new VecsListener();
const server: VecsServer = vecsListener.registerWorld("main", world);
server.registerComponent(Position);
server.registerComponent(Player);
server.registerComponent(Ball);
server.registerComponent(Color);

world.hook(NetworkClient).onSet((entity) => {
  entity.set(View, { dsl: false });
});

for (let i = 0; i < 5; i++) {
  spawnBall(110 + i * 95, 120 + (i % 3) * 90);
}

const moveSystem = world
  .system("MoveSystem")
  .requires(Networked, Ball, Position, Velocity)
  .each([Position, Velocity, Ball], (entity, [position, velocity, ball]) => {
    position.x += velocity.x;
    position.y += velocity.y;

    if (position.x < ball.radius || position.x > WIDTH - ball.radius) {
      velocity.x *= -1;
      position.x = clamp(position.x, ball.radius, WIDTH - ball.radius);
    }
    if (position.y < GAME_TOP + ball.radius || position.y > HEIGHT - ball.radius) {
      velocity.y *= -1;
      position.y = clamp(position.y, GAME_TOP + ball.radius, HEIGHT - ball.radius);
    }

    entity.modified(Position);
  });

world
  .system("SpawnPlayers")
  .requires(Networked, NetworkClient)
  .enter((entity) => {
    const playerIndex = playerSpawnIndex++;
    entity.set(Position, {
      x: 80 + (playerIndex % 8) * 70,
      y: 420 - Math.floor(playerIndex / 8) * 45,
    });
    entity.add(Player);
  });

world
  .system("MovePlayers")
  .requires(Networked, NetworkClient, NetworkInput, Player, Position)
  .each([NetworkInput, Player, Position], (entity, [networkInput, player, position]) => {
    const input = normalizeInput(networkInput.input);
    const x = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const y = (input.down ? 1 : 0) - (input.up ? 1 : 0);

    position.x = clamp(position.x + x * PLAYER_STEP, 0, WIDTH - PLAYER_SIZE);
    position.y = clamp(position.y + y * PLAYER_STEP, GAME_TOP, HEIGHT - PLAYER_SIZE);
    entity.modified(Position);

    moveSystem.forEach([Position, Ball], (ballEntity, [ballPosition, ball]) => {
      if (!overlaps(position, ballPosition, ball.radius)) {
        return;
      }

      player.score += 1;
      entity.modified(Player);
      ballEntity.destroy();
    });
  });

world
  .system("SpawnBalls")
  .interval(2)
  .run(() => {
    if (moveSystem.count < MAX_BALLS) {
      spawnBall();
    }
  });

world
  .system("AssignGridCells")
  .requires(Networked, Position)
  .enter([Position], (entity, [position]) => {
    const GridCell = getGridCellComponent(position);
    if (entity.get(GridCell) === undefined) {
      entity.add(GridCell);
    }
  })
  .update(Position, (entity, position) => {
    const GridCell = getGridCellComponent(position);
    if (entity.get(GridCell) === undefined) {
      entity.add(GridCell);
    }
  });

world
  .system("UpdatePlayerViews")
  .requires(Networked, NetworkClient, Position, View)
  .enter([Position, View], (entity, [position, view]) => {
    const GridCell = getGridCellComponent(position);
    if (view.dsl !== GridCell) {
      entity.set(View, { dsl: GridCell });
    }
  })
  .update(Position, [View], (entity, position, [view]) => {
    const GridCell = getGridCellComponent(position);
    if (view.dsl !== GridCell) {
      entity.set(View, { dsl: GridCell });
    }
  });

world.addPhase("update");
world.addPhase("collect");
world.addPhase("send");
server.installSystems({ collectPhase: "collect", sendPhase: "send" });
world.start();
await vecsListener.listen(app, { ordered: false, maxRetransmits: 2 });

app.get("/", (_req, res) => {
  res.type("text/plain").send("vecs demo server running. Start apps/client with Vite.");
});

app.listen(PORT, () => {
  console.log(`vecs demo server listening on http://localhost:${PORT}`);
});

let previous = performance.now();
let accumulator = 0;
let tick = 0;

function loop(): void {
  const now = performance.now();
  let frameTime = now - previous;
  previous = now;

  frameTime = Math.min(frameTime, 250);
  accumulator += frameTime;

  while (accumulator >= DT_MS) {
    simulate(DT, tick++);
    accumulator -= DT_MS;
  }

  setTimeout(loop, Math.max(0, DT_MS - accumulator));
}

loop();

function simulate(dt: number, tick: number): void {
  world.progress((tick + 1) * DT_MS, dt * 1000);
}

function spawnBall(x = randomInt(40, WIDTH - 40), y = randomInt(90, HEIGHT - 40)): void {
  world
    .entity()
    .add(Networked)
    .add(Ball)
    .set(Color, randomColor())
    .set(Position, { x, y })
    .set(Velocity, {
      x: randomSignedInt(2, 5),
      y: randomSignedInt(2, 4),
    });
}

function randomColor(): Partial<Color> {
  return {
    r: randomInt(80, 255),
    g: randomInt(80, 255),
    b: randomInt(80, 255),
  };
}

function getGridCellComponent(position: Position): ComponentClass {
  return gridCellComponents[getGridCellIndex(position)];
}

function getGridCellIndex(position: Position): number {
  const column = clampGridIndex(
    Math.floor(clamp(position.x, 0, WIDTH - 1) / GRID_CELL_WIDTH),
    GRID_COLUMNS
  );
  const row = clampGridIndex(
    Math.floor((clamp(position.y, GAME_TOP, HEIGHT - 1) - GAME_TOP) / GRID_CELL_HEIGHT),
    GRID_ROWS
  );
  return row * GRID_COLUMNS + column;
}

function getGridCellComponentName(index: number): string {
  return `GridCell${index + 1}`;
}

function clampGridIndex(value: number, size: number): number {
  return Math.min(Math.max(value, 0), size - 1);
}

function normalizeInput(input: unknown): PlayerInput {
  if (!input || typeof input !== "object") {
    return {};
  }
  const source = input as Record<string, unknown>;
  return {
    left: source.left === true,
    right: source.right === true,
    up: source.up === true,
    down: source.down === true,
  };
}

function overlaps(playerPosition: Position, ballPosition: Position, ballRadius: number): boolean {
  const closestX = clamp(ballPosition.x, playerPosition.x, playerPosition.x + PLAYER_SIZE);
  const closestY = clamp(ballPosition.y, playerPosition.y, playerPosition.y + PLAYER_SIZE);
  return Math.hypot(ballPosition.x - closestX, ballPosition.y - closestY) <= ballRadius;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function randomSignedInt(min: number, max: number): number {
  const speed = randomInt(min, max);
  return Math.random() < 0.5 ? -speed : speed;
}
