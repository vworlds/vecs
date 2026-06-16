import express from "express";
import {
  ChildOf,
  type ComponentClass,
  type Entity,
  ON_UPDATE,
  POST_UPDATE,
  PRE_STORE,
  type QueryDSL,
  Relationship,
} from "@vworlds/vecs";
import {
  Ellipse,
  FillStyle,
  Line,
  phaserNetworkComponents,
  Polygon,
  Position as RenderPosition,
  Rectangle,
  Rotation as RenderRotation,
  Size,
  Star,
  StrokeStyle,
  Text,
  TextAlign,
  Triangle,
} from "@vworlds/vecs-phaser";
import { PhaserServerModule } from "@vworlds/vecs-phaser-server";
import {
  AngularVelocity as PhysicsAngularVelocity,
  Body,
  BodyType,
  Chain,
  Circle,
  LinearVelocity as PhysicsVelocity,
  Material,
  PhysicsModule,
  Position as PhysicsPosition,
  preloadPhysics,
  Rotation as PhysicsRotation,
} from "@vworlds/vecs-physics";
import {
  NetworkClient,
  NetworkInput,
  Networked,
  ServerWorld,
  VecsListener,
  View,
} from "@vworlds/vecs-server";

const PORT = Number(process.env.PORT ?? 3000);
const WIDTH = 960;
const HEIGHT = 540;
const PIXELS_PER_METER = 100;
const WORLD_WIDTH = WIDTH / PIXELS_PER_METER;
const WORLD_HEIGHT = HEIGHT / PIXELS_PER_METER;
const WORLD_MIN_X = -WORLD_WIDTH / 2;
const WORLD_MAX_X = WORLD_WIDTH / 2;
const WORLD_MIN_Y = -WORLD_HEIGHT / 2;
const WORLD_MAX_Y = WORLD_HEIGHT / 2;
const GRID_COLUMNS = 3;
const GRID_ROWS = 3;
const GRID_CELL_COUNT = GRID_COLUMNS * GRID_ROWS;
const GRID_CELL_WIDTH = WORLD_WIDTH / GRID_COLUMNS;
const GRID_CELL_HEIGHT = WORLD_HEIGHT / GRID_ROWS;
const PLAYER_SIZE = 28 / PIXELS_PER_METER;
const PLAYER_HALF_SIZE = PLAYER_SIZE / 2;
const PLAYER_STEP = 7 / PIXELS_PER_METER;
const SCORE_OFFSET_Y = PLAYER_HALF_SIZE + 0.18;
const MAX_BALLS = 50;
const BALL_RADIUS = 12 / PIXELS_PER_METER;
const ELECTRON_DISTANCE = BALL_RADIUS + 0.13;
const ELECTRON_SIZE = 0.07;
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const DT_MS = 1000 / TICK_RATE;
let playerSpawnIndex = 0;

interface PlayerInput {
  left?: boolean;
  right?: boolean;
  up?: boolean;
  down?: boolean;
  viewAll?: boolean;
}

class Player {
  public score = 0;
  public scoreText?: Entity;
}

class Ball {
  public radius = BALL_RADIUS;
}

class Electron {
  public angle = 0;
  public radius = ELECTRON_DISTANCE;
  public speed = 0.12;
}

class Offset {
  public x = 0;
  public y = 0;
}

class ViewAll {}

class RotatingDecoration {
  public speed = 0.025;
}

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

const world = new ServerWorld({ name: "main", networkComponents: phaserNetworkComponents });

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
world.component(Ball);
world.component(Electron);
world.component(Offset);
world.component(Player);
world.component(InCell);
world.component(RotatingDecoration);
world.component(ViewAll);
cellTagComponents.forEach((CellTag) => {
  world.component(CellTag);
});

await preloadPhysics();
world.module(PhysicsModule, { gravity: { x: 0, y: -10 }, fixedTimeStep: DT, subSteps: 4 });
world.module(PhaserServerModule);

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
// as a ball moves (driven by render Position updates), giving collision a cheap
// per-cell candidate set instead of scanning every ball.
const ballsByCell = world
  .query("BallsByCell")
  .with(Networked, Ball, RenderPosition)
  .groupBy([RenderPosition], (_entity: Entity, [position]: [RenderPosition]) =>
    getGridCellIndex(position)
  );

// Interest index: every networked entity bucketed by the cell entity it points
// at via InCell. Keyed by the cell anchor entity (the relationship target), so
// it stays correct purely from relationship retargeting.
const occupancyByCell = world
  .query("OccupancyByCell")
  .with(Networked, RenderPosition)
  .groupBy(InCell);

world
  .system("SpawnPlayers")
  .with(Networked, NetworkClient)
  .enter((entity) => {
    const spawn = nextPlayerSpawnPoint();
    const scoreText = createScoreText(entity, spawn);
    entity
      .set(RenderPosition, spawn)
      .add(Rectangle)
      .set(Size, { width: PLAYER_SIZE, height: PLAYER_SIZE })
      .set(FillStyle, { color: 0x66ccff, alpha: 1 })
      .set(Player, { scoreText })
      .add(ViewAll);
  });

world
  .system("MovePlayers")
  .with(Networked, NetworkClient, NetworkInput, Player, RenderPosition)
  .each([NetworkInput, Player, RenderPosition], (entity, [networkInput, player, position]) => {
    const input = normalizeInput(networkInput.input);
    syncViewAll(entity, input.viewAll === true);

    const x = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const y = (input.up ? 1 : 0) - (input.down ? 1 : 0);
    const nextX = clamp(
      position.x + x * PLAYER_STEP,
      WORLD_MIN_X + PLAYER_HALF_SIZE,
      WORLD_MAX_X - PLAYER_HALF_SIZE
    );
    const nextY = clamp(
      position.y + y * PLAYER_STEP,
      WORLD_MIN_Y + PLAYER_HALF_SIZE,
      WORLD_MAX_Y - PLAYER_HALF_SIZE
    );

    updateRenderPosition(entity, position, nextX, nextY);

    // Only test balls in the player's cell and its neighbours — the grouping
    // turns an all-balls scan into a small per-cell candidate set.
    forEachNearbyCell(position, (cellIndex) => {
      ballsByCell
        .group(cellIndex)
        ?.forEach(
          [RenderPosition, Ball],
          (ballEntity: Entity, [ballPosition, ball]: [RenderPosition, Ball]) => {
            if (!overlaps(position, ballPosition, ball.radius)) {
              return;
            }

            player.score += 1;
            ballEntity.destroy();
          }
        );
    });

    syncScoreText(player, position);
  });

world
  .system("SpawnBalls")
  .interval(2)
  .run(() => {
    if (ballsByCell.count < MAX_BALLS) {
      spawnBall();
    }
  });

world
  .system("SpinDecorations")
  .with(Networked, RotatingDecoration, RenderRotation)
  .each([RotatingDecoration, RenderRotation], (entity, [rotating, rotation]) => {
    rotation.angle += rotating.speed;
    entity.modified(RenderRotation);
  });

world
  .system("OrbitElectrons")
  .with(Offset, Electron)
  .each([Offset, Electron], (entity, [offset, electron]) => {
    electron.angle += electron.speed;
    offset.x = Math.cos(electron.angle) * electron.radius;
    offset.y = Math.sin(electron.angle) * electron.radius;
    entity.modified(Electron);
    entity.modified(Offset);
  });

world
  .system("ApplyLocalPositions")
  .with(RenderPosition, Offset)
  .cascade(ChildOf)
  .phase(POST_UPDATE)
  .each(
    [Offset, RenderPosition, { target: [ChildOf, [RenderPosition]] }],
    (entity, [offset, position, parentPosition]) => {
      if (parentPosition === undefined) {
        return;
      }

      updateRenderPosition(
        entity,
        position,
        parentPosition.x + offset.x,
        parentPosition.y + offset.y
      );
    }
  );

// Maintain each entity's InCell relationship from its position. Retargeting on
// a cell crossing is a data change, so there is no per-entity archetype churn
// and no exclusive-component bookkeeping.
world
  .system("AssignCells")
  .with(Networked, RenderPosition)
  .phase(PRE_STORE)
  .enter([RenderPosition], (entity, [position]) => assignCell(entity, position))
  .update(RenderPosition, (entity, position) => assignCell(entity, position));

world
  .system("UpdatePlayerViews")
  .with(Networked, NetworkClient, RenderPosition, View)
  .phase(PRE_STORE)
  .enter([RenderPosition, View], (entity, [position, view]) =>
    updatePlayerView(entity, position, view)
  )
  .update({ watch: RenderPosition, inject: [View] }, (entity, position, [view]) =>
    updatePlayerView(entity, position, view)
  );

createPhysicsWalls();
createDecorations();
spawnBall(-3.7, 1.5);

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

function nextPlayerSpawnPoint(): { x: number; y: number } {
  const playerIndex = playerSpawnIndex++;
  return {
    x: clamp(
      WORLD_MIN_X + PLAYER_HALF_SIZE + 0.5 + (playerIndex % 8) * 0.7,
      WORLD_MIN_X + PLAYER_HALF_SIZE,
      WORLD_MAX_X - PLAYER_HALF_SIZE
    ),
    y: clamp(
      WORLD_MAX_Y - PLAYER_HALF_SIZE - 0.5 - Math.floor(playerIndex / 8) * 0.45,
      WORLD_MIN_Y + PLAYER_HALF_SIZE,
      WORLD_MAX_Y - PLAYER_HALF_SIZE
    ),
  };
}

function createScoreText(playerEntity: Entity, playerPosition: { x: number; y: number }): Entity {
  return world
    .entity()
    .childOf(playerEntity)
    .add(Networked)
    .set(RenderPosition, scoreTextPosition(playerPosition))
    .set(Text, {
      value: "0",
      fontFamily: "monospace",
      fontSize: 18,
      color: 0xffffff,
      align: TextAlign.Center,
    });
}

function syncScoreText(player: Player, playerPosition: RenderPosition): void {
  const scoreTextEntity = player.scoreText;
  if (scoreTextEntity === undefined) {
    return;
  }

  const textPosition = scoreTextEntity.get(RenderPosition);
  if (textPosition !== undefined) {
    const next = scoreTextPosition(playerPosition);
    updateRenderPosition(scoreTextEntity, textPosition, next.x, next.y);
  }

  const text = scoreTextEntity.get(Text);
  const score = String(player.score);
  if (text !== undefined && text.value !== score) {
    scoreTextEntity.set(Text, { value: score });
  }
}

function scoreTextPosition(playerPosition: { x: number; y: number }): { x: number; y: number } {
  return { x: playerPosition.x, y: playerPosition.y + SCORE_OFFSET_Y };
}

function spawnBall(x?: number, y?: number): void {
  // With no explicit position, drop the ball into the least-crowded cell using
  // the relationship-keyed occupancy grouping, spreading balls away from packs.
  const point = x !== undefined && y !== undefined ? { x, y } : randomPointInLeastCrowdedCell();
  const body = world
    .entity()
    .add(Networked)
    .add(Ball)
    .set(Polygon, { points: regularHexagonPoints(BALL_RADIUS) })
    .set(FillStyle, randomFillStyle())
    .set(RenderPosition, point)
    .set(RenderRotation, { angle: 0 })
    .set(PhysicsPosition, point)
    .set(PhysicsRotation, { angle: 0 })
    .set(PhysicsAngularVelocity, { value: randomSignedFloat(2, 8) })
    .set(Body, { type: BodyType.Dynamic })
    .set(PhysicsVelocity, {
      x: randomSignedFloat(0.6, 1.5),
      y: randomSignedFloat(0.6, 1.2),
    });

  world
    .entity()
    .childOf(body)
    .set(Circle, { radius: BALL_RADIUS })
    .set(Material, { friction: 0.6, restitution: 0.7 });

  createElectron(body, point);
}

function createElectron(ball: Entity, ballPosition: { x: number; y: number }): Entity {
  const angle = randomFloat(0, Math.PI * 2);
  const radius = randomFloat(ELECTRON_DISTANCE * 0.85, ELECTRON_DISTANCE * 1.2);
  const offset = {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };

  return world
    .entity()
    .childOf(ball)
    .add(Networked)
    .add(Ellipse)
    .set(Size, { width: ELECTRON_SIZE, height: ELECTRON_SIZE })
    .set(FillStyle, { color: 0x9bf6ff, alpha: 1 })
    .set(RenderPosition, { x: ballPosition.x + offset.x, y: ballPosition.y + offset.y })
    .set(Offset, offset)
    .set(Electron, {
      angle,
      radius,
      speed: randomSignedFloat(0.08, 0.16),
    });
}

function regularHexagonPoints(radius: number): number[] {
  return Array.from({ length: 6 }, (_value, i) => {
    const angle = (i * Math.PI) / 3;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  }).flat();
}

function createPhysicsWalls(): void {
  const walls = world.entity().set(PhysicsPosition, { x: 0, y: 0 }).set(Body, {
    type: BodyType.Static,
  });

  // Loop-chain front faces are on rightPerp(edge), so these clockwise points
  // orient every wall normal inward toward the play area.
  world
    .entity()
    .childOf(walls)
    .set(Chain, {
      points: [
        { x: WORLD_MAX_X, y: WORLD_MAX_Y },
        { x: WORLD_MAX_X, y: WORLD_MIN_Y },
        { x: WORLD_MIN_X, y: WORLD_MIN_Y },
        { x: WORLD_MIN_X, y: WORLD_MAX_Y },
      ],

      loop: true,
    })
    .set(Material, { density: 0, friction: 0.6, restitution: 0.7 });
}

function createDecorations(): void {
  world
    .entity()
    .add(Networked)
    .set(Star, { points: 5, innerRadius: 0.12, outerRadius: 0.24 })
    .set(RenderPosition, { x: -4.1, y: -2.05 })
    .set(FillStyle, { color: 0xffdd66, alpha: 0.9 });
  world
    .entity()
    .add(Networked)
    .set(Triangle, { x1: 0, y1: 0.28, x2: -0.28, y2: -0.2, x3: 0.28, y3: -0.2 })
    .set(RenderPosition, { x: -2.7, y: -2.05 })
    .set(RenderRotation, { angle: 0 })
    .set(FillStyle, { color: 0x66ffaa, alpha: 0.85 })
    .set(RotatingDecoration, { speed: 0.018 });
  world
    .entity()
    .add(Networked)
    .set(Polygon, { points: [-0.3, -0.18, -0.08, 0.25, 0.32, 0.14, 0.22, -0.24] })
    .set(RenderPosition, { x: -1.1, y: -2.05 })
    .set(RenderRotation, { angle: 0 })
    .set(FillStyle, { color: 0xb388ff, alpha: 0.85 })
    .set(StrokeStyle, { color: 0xffffff, alpha: 0.45, width: 2 })
    .set(RotatingDecoration, { speed: -0.014 });
  world
    .entity()
    .add(Networked)
    .add(Ellipse)
    .set(Size, { width: 0.7, height: 0.32 })
    .set(RenderPosition, { x: 1.0, y: -2.05 })
    .set(FillStyle, { color: 0xff88bb, alpha: 0.8 });
  world
    .entity()
    .add(Networked)
    .set(Line, { x1: -0.45, y1: -0.15, x2: 0.45, y2: 0.15 })
    .set(RenderPosition, { x: 2.55, y: -2.05 })
    .set(RenderRotation, { angle: 0 })
    .set(StrokeStyle, { color: 0x88ccff, alpha: 1, width: 4 })
    .set(RotatingDecoration, { speed: 0.03 });
}

function assignCell(entity: Entity, position: RenderPosition): void {
  const cell = cellEntities[getGridCellIndex(position)];
  if (entity.target(InCell) !== cell) {
    entity.set(InCell, { target: cell });
  }
}

function updatePlayerView(entity: Entity, position: RenderPosition, view: View): void {
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
    x: randomFloat(
      WORLD_MIN_X + column * GRID_CELL_WIDTH + BALL_RADIUS,
      WORLD_MIN_X + (column + 1) * GRID_CELL_WIDTH - BALL_RADIUS
    ),
    y: randomFloat(
      WORLD_MIN_Y + row * GRID_CELL_HEIGHT + BALL_RADIUS,
      WORLD_MIN_Y + (row + 1) * GRID_CELL_HEIGHT - BALL_RADIUS
    ),
  };
}

function randomFillStyle(): Partial<FillStyle> {
  const r = randomInt(80, 255);
  const g = randomInt(80, 255);
  const b = randomInt(80, 255);
  return {
    color: (r << 16) | (g << 8) | b,
  };
}

function updateRenderPosition(
  entity: Entity,
  position: RenderPosition,
  x: number,
  y: number
): void {
  if (position.x === x && position.y === y) {
    return;
  }
  position.x = x;
  position.y = y;
  entity.modified(RenderPosition);
}

function forEachNearbyCell(position: RenderPosition, visit: (cellIndex: number) => void): void {
  const column = gridColumn(position.x);
  const row = gridRow(position.y);
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

function getGridCellIndex(position: RenderPosition): number {
  return gridRow(position.y) * GRID_COLUMNS + gridColumn(position.x);
}

function gridColumn(x: number): number {
  return clampGridIndex(
    Math.floor(
      (clamp(x, WORLD_MIN_X, WORLD_MAX_X - Number.EPSILON) - WORLD_MIN_X) / GRID_CELL_WIDTH
    ),
    GRID_COLUMNS
  );
}

function gridRow(y: number): number {
  return clampGridIndex(
    Math.floor(
      (clamp(y, WORLD_MIN_Y, WORLD_MAX_Y - Number.EPSILON) - WORLD_MIN_Y) / GRID_CELL_HEIGHT
    ),
    GRID_ROWS
  );
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

function overlaps(
  playerPosition: RenderPosition,
  ballPosition: RenderPosition,
  ballRadius: number
): boolean {
  const closestX = clamp(
    ballPosition.x,
    playerPosition.x - PLAYER_HALF_SIZE,
    playerPosition.x + PLAYER_HALF_SIZE
  );
  const closestY = clamp(
    ballPosition.y,
    playerPosition.y - PLAYER_HALF_SIZE,
    playerPosition.y + PLAYER_HALF_SIZE
  );
  return Math.hypot(ballPosition.x - closestX, ballPosition.y - closestY) <= ballRadius;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function randomFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function randomSignedFloat(min: number, max: number): number {
  const speed = randomFloat(min, max);
  return Math.random() < 0.5 ? -speed : speed;
}
