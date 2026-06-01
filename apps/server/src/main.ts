import express from "express";
import { type as wireType } from "@vworlds/vecs-wire";
import {
  NetworkClient,
  NetworkInput,
  Networked,
  ServerWorld,
  VecsListener,
  View,
} from "@vworlds/vecs-server";
import {
  ChildOf,
  type ComponentClass,
  type Entity,
  type QueryDSL,
  Relationship,
} from "@vworlds/vecs";
import {
  Body,
  BodyType,
  Chain,
  Circle,
  installPhysics,
  LinearVelocity as PhysicsVelocity,
  Material,
  Position as PhysicsPosition,
  preloadPhysics,
} from "@vworlds/vecs-physics";

const PORT = Number(process.env.PORT ?? 3000);
const WIDTH = 960;
const HEIGHT = 540;
const GAME_TOP = 60;
const PLAY_HEIGHT = HEIGHT - GAME_TOP;
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
const PIXELS_PER_METER = 100;
let playerSpawnIndex = 0;

interface PlayerInput {
  left?: boolean;
  right?: boolean;
  up?: boolean;
  down?: boolean;
  viewAll?: boolean;
}

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
  public radius = BALL_RADIUS;
}

class Color {
  @wireType("u32")
  public value = 0xffffff;
}

class ViewAll {}

/**
 * Relationship pointing each networked entity at the grid-cell entity it
 * currently occupies. Retargeting it as an entity moves between cells is a
 * plain data change — no archetype churn, unlike swapping marker components.
 */
class InCell extends Relationship {}

// One distinct tag component per cell, carried by that cell's anchor entity.
// They make "which cell" expressible in the View DSL (`{ target: [InCell, tag] }`)
// so every client in the same cell shares one replication tracker.
const cellTagComponents: ComponentClass[] = Array.from(
  { length: GRID_CELL_COUNT },
  () => class CellTag {}
);

const world = new ServerWorld({ name: "main", networkComponents: [Position, Player, Ball, Color] });
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
const server = vecsListener.registerWorld(world);
world.component(InCell);
world.component(ViewAll);
cellTagComponents.forEach((CellTag) => {
  world.component(CellTag);
});

// The demo already has update/collect/send phases. Let installPhysics create its
// default physics-* phases after update so gameplay writes happen before the step
// and network collection observes post-physics sync.
world.addPhase("update");
await preloadPhysics();
installPhysics(world, { gravity: { x: 0, y: -10 }, fixedTimeStep: DT, subSteps: 4 });

// One anchor entity per grid cell. Moving entities relate to these via InCell;
// the per-cell View DSL targets each anchor's tag.
const cellEntities: Entity[] = cellTagComponents.map((CellTag) => world.entity().add(CellTag));
const cellViewDSL: QueryDSL[] = cellTagComponents.map(
  (CellTag) => ({ target: [InCell, CellTag] }) as QueryDSL
);

world.component(NetworkClient).onSet((entity) => {
  entity.set(View, { dsl: false });
});

// Simulation index: balls bucketed by their position cell. Re-buckets in place
// as a ball moves (driven by Position updates), giving collision a cheap
// per-cell candidate set instead of scanning every ball.
const ballsByCell = world
  .query("BallsByCell")
  .requires(Networked, Ball, Position)
  .groupBy([Position], (_entity: Entity, [position]: [Position]) => getGridCellIndex(position));

// Interest index: every networked entity bucketed by the cell entity it points
// at via InCell. Keyed by the cell anchor entity (the relationship target), so
// it stays correct purely from relationship retargeting.
const occupancyByCell = world
  .query("OccupancyByCell")
  .requires(Networked, Position)
  .groupBy(InCell);

var selected: Entity | undefined = undefined;
world
  .system("SyncPhysicsBalls")
  .phase("physics-post")
  .requires(Networked, Ball, Position, PhysicsPosition)
  .each([Position, PhysicsPosition, Ball], (entity, [position, physicsPosition, ball]) => {
    // Keep the wire-typed demo Position as the client protocol and adapt from
    // vecs-physics Position post-step instead of decorating external classes.
    const next = toDemoBallPoint(physicsPosition, ball.radius);
    if (position.x !== next.x || position.y !== next.y) {
      position.x = next.x;
      position.y = next.y;
      entity.modified(Position);
    }
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
    entity.add(Player).add(ViewAll);
  });

world
  .system("MovePlayers")
  .requires(Networked, NetworkClient, NetworkInput, Player, Position)
  .each([NetworkInput, Player, Position], (entity, [networkInput, player, position]) => {
    const input = normalizeInput(networkInput.input);
    syncViewAll(entity, input.viewAll === true);

    const x = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const y = (input.down ? 1 : 0) - (input.up ? 1 : 0);

    position.x = clamp(position.x + x * PLAYER_STEP, 0, WIDTH - PLAYER_SIZE);
    position.y = clamp(position.y + y * PLAYER_STEP, GAME_TOP, HEIGHT - PLAYER_SIZE);
    entity.modified(Position);

    // Only test balls in the player's cell and its neighbours — the grouping
    // turns an all-balls scan into a small per-cell candidate set.
    forEachNearbyCell(position, (cellIndex) => {
      ballsByCell
        .group(cellIndex)
        ?.forEach(
          [Position, Ball],
          (ballEntity: Entity, [ballPosition, ball]: [Position, Ball]) => {
            if (!overlaps(position, ballPosition, ball.radius)) {
              return;
            }

            player.score += 1;
            entity.modified(Player);
            ballEntity.destroy();
          }
        );
    });
  });

world
  .system("SpawnBalls")
  .interval(2)
  .run(() => {
    if (ballsByCell.count < MAX_BALLS) {
      spawnBall();
    }
  });

// Maintain each entity's InCell relationship from its position. Retargeting on
// a cell crossing is a data change, so there is no per-entity archetype churn
// and no exclusive-component bookkeeping.
world
  .system("AssignCells")
  .phase("physics-post")
  .requires(Networked, Position)
  .enter([Position], (entity, [position]) => assignCell(entity, position))
  .update(Position, (entity, position) => assignCell(entity, position));

world
  .system("UpdatePlayerViews")
  .phase("physics-post")
  .requires(Networked, NetworkClient, Position, View)
  .enter([Position, View], (entity, [position, view]) => updatePlayerView(entity, position, view))
  .update(Position, [View], (entity, position, [view]) => updatePlayerView(entity, position, view));

world.addPhase("collect");
world.addPhase("send");
server.installSystems({ collectPhase: "collect", sendPhase: "send" });
world.start();

createPhysicsWalls();
for (let i = 0; i < 1; i++) {
  spawnBall(110 + i * 95, 120 + (i % 3) * 90);
}

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

function spawnBall(x?: number, y?: number): void {
  // With no explicit position, drop the ball into the least-crowded cell using
  // the relationship-keyed occupancy grouping, spreading balls away from packs.
  const point = x !== undefined && y !== undefined ? { x, y } : randomPointInLeastCrowdedCell();
  const body = world
    .entity()
    .add(Networked)
    .add(Ball)
    .set(Color, randomColor())
    .set(Position, point)
    .set(PhysicsPosition, toPhysicsPoint(point))
    .set(Body, { type: BodyType.Dynamic })
    .set(PhysicsVelocity, {
      x: demoUnitsToMeters(randomSignedInt(60, 150)),
      y: demoUnitsToMeters(randomSignedInt(60, 120)),
    });

  world
    .entity()
    .set(ChildOf, { target: body })
    .set(Circle, { radius: demoUnitsToMeters(BALL_RADIUS) })
    .set(Material, { friction: 0.6, restitution: 0.7 });
}

function createPhysicsWalls(): void {
  const walls = world.entity().set(PhysicsPosition, { x: 0, y: 0 }).set(Body, {
    type: BodyType.Static,
  });

  // Loop-chain front faces are on rightPerp(edge), so these clockwise points
  // orient every wall normal inward toward the play area.
  world
    .entity()
    .set(ChildOf, { target: walls })
    .set(Chain, {
      points: [
        toPhysicsPoint({ x: WIDTH, y: HEIGHT }),
        toPhysicsPoint({ x: 0, y: HEIGHT }),
        toPhysicsPoint({ x: 0, y: 0 }),
        toPhysicsPoint({ x: WIDTH, y: 0 }),
      ],

      loop: true,
    })
    .set(Material, { density: 0, friction: 0.6, restitution: 0.7 });
}

function assignCell(entity: Entity, position: Position): void {
  const cell = cellEntities[getGridCellIndex(position)];
  if (entity.parent(InCell) !== cell) {
    entity.set(InCell, { target: cell });
  }
}

function updatePlayerView(entity: Entity, position: Position, view: View): void {
  const dsl: QueryDSL =
    entity.get(ViewAll) !== undefined ? true : cellViewDSL[getGridCellIndex(position)];
  if (view.dsl !== dsl) {
    view.dsl = dsl;
    entity.modified(View);
  }
}

function syncViewAll(entity: Entity, enabled: boolean): void {
  const hasViewAll = entity.get(ViewAll) !== undefined;
  if (enabled === hasViewAll) {
    return;
  }
  if (enabled) {
    entity.add(ViewAll);
  } else {
    entity.remove(ViewAll);
  }
}

function randomPointInLeastCrowdedCell(): { x: number; y: number } {
  let bestIndex = 0;
  let bestCount = Infinity;
  for (let index = 0; index < GRID_CELL_COUNT; index++) {
    const count = occupancyByCell.group(cellEntities[index])?.count ?? 0;
    if (count < bestCount) {
      bestCount = count;
      bestIndex = index;
    }
  }
  return randomPointInCell(bestIndex);
}

function randomPointInCell(cellIndex: number): { x: number; y: number } {
  const column = cellIndex % GRID_COLUMNS;
  const row = Math.floor(cellIndex / GRID_COLUMNS);
  return {
    x: randomInt(
      Math.floor(column * GRID_CELL_WIDTH) + BALL_RADIUS,
      Math.floor((column + 1) * GRID_CELL_WIDTH) - BALL_RADIUS
    ),
    y: randomInt(
      Math.floor(GAME_TOP + row * GRID_CELL_HEIGHT) + BALL_RADIUS,
      Math.floor(GAME_TOP + (row + 1) * GRID_CELL_HEIGHT) - BALL_RADIUS
    ),
  };
}

function toPhysicsPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: demoUnitsToMeters(point.x), y: demoUnitsToMeters(HEIGHT - point.y) };
}

function toDemoBallPoint(position: PhysicsPosition, radius: number): { x: number; y: number } {
  return {
    x: Math.round(metersToDemoUnits(position.x)),
    y: Math.round(HEIGHT - metersToDemoUnits(position.y)),
  };
}

function demoUnitsToMeters(value: number): number {
  return value / PIXELS_PER_METER;
}

function metersToDemoUnits(value: number): number {
  return value * PIXELS_PER_METER;
}

function randomColor(): Partial<Color> {
  const r = randomInt(80, 255);
  const g = randomInt(80, 255);
  const b = randomInt(80, 255);
  return {
    value: (r << 16) | (g << 8) | b,
  };
}

function forEachNearbyCell(position: Position, visit: (cellIndex: number) => void): void {
  const column = clampGridIndex(
    Math.floor(clamp(position.x, 0, WIDTH - 1) / GRID_CELL_WIDTH),
    GRID_COLUMNS
  );
  const row = clampGridIndex(
    Math.floor((clamp(position.y, GAME_TOP, HEIGHT - 1) - GAME_TOP) / GRID_CELL_HEIGHT),
    GRID_ROWS
  );
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = row + dr;
      const c = column + dc;
      if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLUMNS) {
        continue;
      }
      visit(r * GRID_COLUMNS + c);
    }
  }
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
    viewAll: source.viewAll === true,
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
