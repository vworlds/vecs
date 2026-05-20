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
import { World } from "@vworlds/vecs";

const POSITION_TYPE = 1;
const PLAYER_TYPE = 2;
const BALL_TYPE = 3;
const PORT = Number(process.env.PORT ?? 3000);
const WIDTH = 960;
const HEIGHT = 540;
const PLAYER_SIZE = 28;
const PLAYER_STEP = 7;
const MAX_BALLS = 12;
const BALL_RADIUS = 12;
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const DT_MS = 1000 / TICK_RATE;
const WAKE_EARLY_MS = 5;
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

const world = new World();
world.registerComponent(Networked);
world.registerComponent(Position, POSITION_TYPE);
world.registerComponent(Player, PLAYER_TYPE);
world.registerComponent(Ball, BALL_TYPE);
world.registerComponent(Velocity);

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

world.hook(NetworkClient).onSet((entity) => {
  entity.set(View, { dsl: true });
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
    if (position.y < 60 + ball.radius || position.y > HEIGHT - ball.radius) {
      velocity.y *= -1;
      position.y = clamp(position.y, 60 + ball.radius, HEIGHT - ball.radius);
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
    position.y = clamp(position.y + y * PLAYER_STEP, 60, HEIGHT - PLAYER_SIZE);
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

  const delay = DT_MS - accumulator - WAKE_EARLY_MS;
  if (delay > 0) {
    setTimeout(loop, delay);
    return;
  }
  setImmediate(loop);
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
    .set(Position, { x, y })
    .set(Velocity, {
      x: randomSignedInt(2, 5),
      y: randomSignedInt(2, 4),
    });
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
