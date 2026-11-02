/**
 * Sector-tick benchmark: prices the per-tick vecs bookkeeping of a multi-world
 * game server, modelled on a Space Rocks sector lattice (one `ServerWorld` per
 * sector, advanced in lockstep at 30 Hz).
 *
 * Every sector runs the same mix the real server does, minus Box2D:
 *
 * - a stand-in physics engine stepped by a `run` system, with pose sync in
 *   (`update` systems that ignore the physics source) and out (four `set`s per
 *   moving body per tick, like `@vworlds/vecs-physics` pose-out);
 * - render pose sync (`update` on a physics component sets a networked one);
 * - `.each` systems (ship control, world wrap, lifetimes, player views);
 * - reactive `enter` / `update` / `exit` systems, flushed after every system;
 * - an interest grid: an exclusive `InCell` relationship retargeted whenever an
 *   entity crosses a cell, cascaded to `DrawBy` children by an edge hook;
 * - asteroid splitting, bullets and explosions, so entities are created and
 *   destroyed every few ticks;
 * - 28 networked component types with `ServerWorld` diff recording, and one
 *   in-memory client per sector that acks every frame and sends input.
 *
 * The run is deterministic: one seeded PRNG per sector, a fixed `dt`, and no
 * wall-clock input to the simulation. It prints a checksum of the final state,
 * a hash of the order in which every benchmark callback fired, and a hash of
 * every byte sent to the clients. An optimization that preserves execution
 * order, hook order and reactive delivery leaves all three unchanged.
 *
 * See `bench/README.md` for how to run, profile and compare it.
 */
import { performance } from "node:perf_hooks";
import {
  type ComponentClass,
  type Entity,
  Exclusive,
  ON_UPDATE,
  POST_UPDATE,
  PRE_STORE,
  PRE_UPDATE,
  type QueryDSL,
  Relationship,
  Traversable,
} from "@vworlds/vecs";
import { Client2Server, type VecsSocket, type VecsSocketListener } from "@vworlds/vecs-protocol";
import { NetworkClient, NetworkInput, Networked, ServerWorld, View } from "@vworlds/vecs-server";
import { Encoder, tag, wireType, type WireTypeSpec } from "@vworlds/vecs-wire";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  worlds: intFromEnv("BENCH_WORLDS", 8),
  asteroids: intFromEnv("BENCH_ASTEROIDS", 200),
  ships: intFromEnv("BENCH_SHIPS", 4),
  clients: intFromEnv("BENCH_CLIENTS", 1),
  warmupTicks: intFromEnv("BENCH_WARMUP_TICKS", 150),
  ticks: intFromEnv("BENCH_TICKS", 600),
  seed: intFromEnv("BENCH_SEED", 0x5eed),
};

const TICK_RATE = 30;
const DT_MS = 1000 / TICK_RATE;
const DT_S = 1 / TICK_RATE;

const GRID_COLS = 5;
const GRID_ROWS = 5;
const CELL_WIDTH = 20;
const CELL_HEIGHT = 15;
const WORLD_WIDTH = GRID_COLS * CELL_WIDTH;
const WORLD_HEIGHT = GRID_ROWS * CELL_HEIGHT;

const ASTEROID_MAX_SPEED = 9; // units/s: a cell crossing every ~2 s per asteroid
const SHIP_THRUST = 40; // units/s²
const SHIP_TURN = 0.08; // rad/tick
const BULLET_SPEED = 30; // units/s
const BULLET_TICKS = 24;
const FIRE_COOLDOWN_TICKS = 8;
const EXPLOSION_TICKS = 12;
const SPLIT_CHANCE = 0.25; // per sector per tick
const DAMAGE_CHANCE = 0.3; // per sector per tick
const LABELLED_ASTEROID_RATIO = 8; // one asteroid in N carries a DrawBy child

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

// Physics side (server-local), shaped like `@vworlds/vecs-physics`.
class Body {
  id = -1;
}
class PhysPosition {
  x = 0;
  y = 0;
}
class PhysRotation {
  angle = 0;
}
class LinearVelocity {
  x = 0;
  y = 0;
}
class AngularVelocity {
  value = 0;
}
class Force {
  x = 0;
  y = 0;
}
/** Marks the physics systems so pose-in systems can ignore their writes. */
class PhysicsTag {}

// Networked render/game components, shaped like `@vworlds/vecs-phaser` plus
// the Space Rocks extensions. The array order is the wire protocol.
class Position {
  x = 0;
  y = 0;
}
class Rotation {
  angle = 0;
}
class Scale {
  x = 1;
  y = 1;
}
class Alpha {
  value = 1;
}
class Depth {
  value = 0;
}
class FillStyle {
  color = 0;
  alpha = 1;
}
class StrokeStyle {
  width = 0;
  color = 0;
  alpha = 1;
}
class Arc {
  radius = 1;
}
class Ellipse {
  width = 1;
  height = 1;
}
class Rectangle {
  width = 1;
  height = 1;
}
class Polygon {
  sides = 3;
  radius = 1;
}
class Line {
  length = 1;
}
class Triangle {
  size = 1;
}
class Star {
  points = 5;
  radius = 1;
}
class Text {
  value = "";
}
class Size {
  width = 1;
  height = 1;
}
class Image {
  key = "";
}
class Tint {
  color = 0;
}
class DrawIn extends Relationship {}
class Container {}
class Offset {
  x = 0;
  y = 0;
}
class DrawBy extends Relationship {}
class Explosion {
  size = 1;
}
class Owner {
  player = 0;
}
class Hyperspace {
  seq = 0;
}
class ProgressBar {
  value = 1;
}
class ResourceContainer {
  amount = 0;
}
class HyperdriveArmed {
  armed = false;
}

wire(Position, { x: "f32", y: "f32" });
wire(Rotation, { angle: "f32" });
wire(Scale, { x: "f32", y: "f32" });
wire(Alpha, { value: "f32" });
wire(Depth, { value: "i32" });
wire(FillStyle, { color: "u32", alpha: "f32" });
wire(StrokeStyle, { width: "f32", color: "u32", alpha: "f32" });
wire(Arc, { radius: "f32" });
wire(Ellipse, { width: "f32", height: "f32" });
wire(Rectangle, { width: "f32", height: "f32" });
wire(Polygon, { sides: "u8", radius: "f32" });
wire(Line, { length: "f32" });
wire(Triangle, { size: "f32" });
wire(Star, { points: "u8", radius: "f32" });
wire(Text, { value: "string" });
wire(Size, { width: "f32", height: "f32" });
wire(Image, { key: "string" });
wire(Tint, { color: "u32" });
tag(Container);
wire(Offset, { x: "f32", y: "f32" });
wire(Explosion, { size: "f32" });
wire(Owner, { player: "u32" });
wire(Hyperspace, { seq: "u32" });
wire(ProgressBar, { value: "f32" });
wire(ResourceContainer, { amount: "u32" });
wire(HyperdriveArmed, { armed: "bool" });

const NETWORK_COMPONENTS: readonly ComponentClass[] = [
  Position,
  Rotation,
  Scale,
  Alpha,
  Depth,
  FillStyle,
  StrokeStyle,
  Arc,
  Ellipse,
  Rectangle,
  Polygon,
  Line,
  Triangle,
  Star,
  Text,
  Size,
  Image,
  Tint,
  DrawIn,
  Container,
  Offset,
  DrawBy,
  Explosion,
  Owner,
  Hyperspace,
  ProgressBar,
  ResourceContainer,
  HyperdriveArmed,
];

const RENDERABLES: readonly ComponentClass[] = [
  Arc,
  Ellipse,
  Rectangle,
  Polygon,
  Line,
  Triangle,
  Star,
  Text,
  Image,
  Container,
];

// Gameplay (server-local).
class Asteroid {
  mass = 0;
}
class Ship {
  index = 0;
  controlled = false;
  cooldown = 0;
}
class Wraps {}
class Lifetime {
  ticks = 0;
}
class Health {
  hp = 100;
}
class InputIntent {
  thrust = false;
  left = false;
  right = false;
  fire = false;
}
/** Singleton stored on its own component entity. */
class MassTotal {
  total = 0;
}
/** Exclusive edge from an entity to the grid cell it occupies. */
class InCell extends Relationship {}
/** Exclusive edge from a client entity to the ship it controls. */
class Controls extends Relationship {}

const CELL_TAGS: readonly ComponentClass[] = Array.from(
  { length: GRID_COLS * GRID_ROWS },
  () => class CellTag {}
);

const LOCAL_COMPONENTS: readonly ComponentClass[] = [
  Body,
  PhysPosition,
  PhysRotation,
  LinearVelocity,
  AngularVelocity,
  Force,
  PhysicsTag,
  Asteroid,
  Ship,
  Wraps,
  Lifetime,
  Health,
  InputIntent,
  MassTotal,
  Controls,
];

// ---------------------------------------------------------------------------
// Determinism helpers
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, seedable. */
class Rng {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Order-sensitive hash of every benchmark callback invocation. */
let traceHash = 0x811c9dc5;

function trace(callbackId: number, eid: number): void {
  traceHash = Math.imul(traceHash ^ callbackId, 0x01000193);
  traceHash = Math.imul(traceHash ^ eid, 0x01000193);
}

/** Stable callback ids for {@link trace}. */
const CB = {
  bodyEnter: 1,
  bodyExit: 2,
  poseInPosition: 3,
  poseInRotation: 4,
  poseInLinear: 5,
  poseInAngular: 6,
  force: 7,
  playerInput: 8,
  shipControl: 9,
  decay: 10,
  wrap: 11,
  syncPosition: 12,
  syncRotation: 13,
  massEnter: 14,
  massExit: 15,
  healthBar: 16,
  cellEnter: 17,
  cellUpdate: 18,
  cellHookAdd: 19,
  cellHookRemove: 20,
  displayChildCell: 21,
  viewEnter: 22,
  viewEach: 23,
  clientEnter: 24,
} as const;

// ---------------------------------------------------------------------------
// Stand-in physics engine (plain JS, no ECS)
// ---------------------------------------------------------------------------

type SimBody = {
  entity: Entity;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  av: number;
  fx: number;
  fy: number;
  alive: boolean;
};

class PhysicsEngine {
  readonly bodies: SimBody[] = [];
  private readonly _free: number[] = [];

  create(entity: Entity, position: PhysPosition, velocity: LinearVelocity | undefined): number {
    const body: SimBody = {
      entity,
      x: position.x,
      y: position.y,
      vx: velocity?.x ?? 0,
      vy: velocity?.y ?? 0,
      angle: 0,
      av: 0,
      fx: 0,
      fy: 0,
      alive: true,
    };
    const id = this._free.pop();
    if (id === undefined) {
      this.bodies.push(body);
      return this.bodies.length - 1;
    }
    this.bodies[id] = body;
    return id;
  }

  destroy(id: number): void {
    const body = this.bodies[id];
    if (body?.alive) {
      body.alive = false;
      this._free.push(id);
    }
  }

  step(dt: number): void {
    for (const body of this.bodies) {
      if (!body.alive) {
        continue;
      }
      body.vx += body.fx * dt;
      body.vy += body.fy * dt;
      body.x += body.vx * dt;
      body.y += body.vy * dt;
      body.angle += body.av * dt;
    }
  }
}

// ---------------------------------------------------------------------------
// Interest grid
// ---------------------------------------------------------------------------

function cellIndexOf(x: number, y: number): number {
  const col = clampIndex(Math.floor(x / CELL_WIDTH), GRID_COLS);
  const row = clampIndex(Math.floor(y / CELL_HEIGHT), GRID_ROWS);
  return row * GRID_COLS + col;
}

function clampIndex(index: number, count: number): number {
  return index < 0 ? 0 : index >= count ? count - 1 : index;
}

function neighbourIndices(cellIndex: number): number[] {
  const col = cellIndex % GRID_COLS;
  const row = Math.floor(cellIndex / GRID_COLS);
  const indices: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS) {
        indices.push(r * GRID_COLS + c);
      }
    }
  }
  return indices;
}

/** Shared across sectors so equal views reuse one DSL object per cell. */
const CELL_VIEW_DSL: readonly QueryDSL[] = CELL_TAGS.map((_tag, index) => ({
  any: neighbourIndices(index).map((neighbour) => ({
    target: [InCell, CELL_TAGS[neighbour]] as const,
  })),
}));

// ---------------------------------------------------------------------------
// In-memory transport
// ---------------------------------------------------------------------------

type SocketHandler = (arg?: unknown) => void;

class BenchSocket implements VecsSocket {
  readonly id: string;
  bytes = 0;
  messages = 0;
  hash = 0x811c9dc5;
  private readonly _handlers = new Map<string, SocketHandler[]>();

  constructor(id: string) {
    this.id = id;
  }

  on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  send(data: Uint8Array): void {
    this.messages++;
    this.bytes += data.length;
    let hash = this.hash;
    for (let i = 0; i < data.length; i++) {
      hash = Math.imul(hash ^ data[i], 0x01000193);
    }
    this.hash = hash;
  }

  receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }

  close(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

class BenchListener implements VecsSocketListener {
  private readonly _handlers: ((socket: VecsSocket) => void)[] = [];

  on(event: "new", handler: (socket: VecsSocket) => void): this {
    if (event === "new") {
      this._handlers.push(handler);
    }
    return this;
  }

  connect(socket: VecsSocket): void {
    this._handlers.forEach((handler) => handler(socket));
  }
}

type BenchClient = {
  socket: BenchSocket;
  rng: Rng;
  input: number;
};

const clientEncoder = new Encoder(new Uint8Array(256));

// ---------------------------------------------------------------------------
// Sector
// ---------------------------------------------------------------------------

type Sector = {
  world: ServerWorld;
  rng: Rng;
  engine: PhysicsEngine;
  cells: Entity[];
  ships: Entity[];
  asteroids: Entity[];
  clients: BenchClient[];
  retargets: number;
  spawned: number;
  destroyed: number;
};

function createSector(index: number): Sector {
  const world = new ServerWorld({
    name: `sector-${index}`,
    networkComponents: NETWORK_COMPONENTS,
    disconnectGraceMs: Number.POSITIVE_INFINITY,
  });
  const sector: Sector = {
    world,
    rng: new Rng(CONFIG.seed + index * 0x9e3779b9),
    engine: new PhysicsEngine(),
    cells: [],
    ships: [],
    asteroids: [],
    clients: [],
    retargets: 0,
    spawned: 0,
    destroyed: 0,
  };

  for (const Class of [...LOCAL_COMPONENTS, ...CELL_TAGS]) {
    world.component(Class);
  }
  world.component(InCell).add(Exclusive);
  world.component(Controls).add(Exclusive);
  world.component(DrawIn).add(Exclusive);
  world.component(DrawBy).add(Exclusive).add(Traversable);
  world.setExclusiveComponents(...RENDERABLES);
  sector.cells = CELL_TAGS.map((CellTag) => world.entity().add(CellTag));
  world.component(MassTotal).set(MassTotal, { total: 0 });

  installPhysics(sector);
  installGameplay(sector);
  installInterestGrid(sector);

  for (let i = 0; i < CONFIG.ships; i++) {
    sector.ships.push(spawnShip(sector, i));
  }
  for (let i = 0; i < CONFIG.asteroids; i++) {
    spawnAsteroid(sector, randomPoint(sector.rng), 8 + sector.rng.int(24));
  }
  return sector;
}

function installPhysics(sector: Sector): void {
  const { world, engine } = sector;

  world
    .system("physics:BodyLifecycle")
    .with(Body, PhysPosition)
    .phase(PRE_UPDATE)
    .enter([Body, PhysPosition], (entity, [body, position]) => {
      trace(CB.bodyEnter, entity.eid);
      body.id = engine.create(entity, position, entity.get(LinearVelocity));
    })
    .exit([Body], (entity, [body]) => {
      trace(CB.bodyExit, entity.eid);
      engine.destroy(body.id);
    })
    .entity.add(PhysicsTag);

  world.system("physics:PoseSyncIn").with(Body).phase(PRE_UPDATE).ignoreSource([PhysicsTag]);

  world
    .system("physics:PoseSyncIn:Position")
    .with(Body, PhysPosition)
    .phase(PRE_UPDATE)
    .ignoreSource([PhysicsTag])
    .update({ watch: PhysPosition, onEnter: true, inject: [Body] }, (entity, position, [body]) => {
      trace(CB.poseInPosition, entity.eid);
      const sim = engine.bodies[body.id];
      if (sim !== undefined) {
        sim.x = position.x;
        sim.y = position.y;
      }
    })
    .entity.add(PhysicsTag);

  world
    .system("physics:PoseSyncIn:Rotation")
    .with(Body, PhysRotation)
    .phase(PRE_UPDATE)
    .ignoreSource([PhysicsTag])
    .update({ watch: PhysRotation, onEnter: true, inject: [Body] }, (entity, rotation, [body]) => {
      trace(CB.poseInRotation, entity.eid);
      const sim = engine.bodies[body.id];
      if (sim !== undefined) {
        sim.angle = rotation.angle;
      }
    })
    .entity.add(PhysicsTag);

  world
    .system("physics:PoseSyncIn:LinearVelocity")
    .with(Body, LinearVelocity)
    .phase(PRE_UPDATE)
    .ignoreSource([PhysicsTag])
    .update(
      { watch: LinearVelocity, onEnter: true, inject: [Body] },
      (entity, velocity, [body]) => {
        trace(CB.poseInLinear, entity.eid);
        const sim = engine.bodies[body.id];
        if (sim !== undefined) {
          sim.vx = velocity.x;
          sim.vy = velocity.y;
        }
      }
    )
    .entity.add(PhysicsTag);

  world
    .system("physics:PoseSyncIn:AngularVelocity")
    .with(Body, AngularVelocity)
    .phase(PRE_UPDATE)
    .ignoreSource([PhysicsTag])
    .update(
      { watch: AngularVelocity, onEnter: true, inject: [Body] },
      (entity, velocity, [body]) => {
        trace(CB.poseInAngular, entity.eid);
        const sim = engine.bodies[body.id];
        if (sim !== undefined) {
          sim.av = velocity.value;
        }
      }
    )
    .entity.add(PhysicsTag);

  world
    .system("physics:Forces")
    .with(Body, Force)
    .phase(PRE_UPDATE)
    .ignoreSource([PhysicsTag])
    .update({ watch: Force, inject: [Body] }, (entity, force, [body]) => {
      trace(CB.force, entity.eid);
      const sim = engine.bodies[body.id];
      if (sim !== undefined) {
        sim.fx = force.x;
        sim.fy = force.y;
      }
    })
    .entity.add(PhysicsTag);

  world
    .system("physics:Step")
    .phase(ON_UPDATE)
    .run(() => engine.step(DT_S))
    .entity.add(PhysicsTag);

  // Like vecs-physics pose-out: four `set`s per moving body per tick.
  world
    .system("physics:PoseSyncOut")
    .phase(ON_UPDATE)
    .run(() => {
      for (const sim of engine.bodies) {
        if (!sim.alive) {
          continue;
        }
        const entity = sim.entity;
        entity.set(PhysPosition, { x: sim.x, y: sim.y });
        entity.set(PhysRotation, { angle: sim.angle });
        entity.set(LinearVelocity, { x: sim.vx, y: sim.vy });
        entity.set(AngularVelocity, { value: sim.av });
      }
    })
    .entity.add(PhysicsTag);

  // Like vecs-phaser-server: physics pose drives the networked render pose.
  world
    .system("render:SyncPosition")
    .with(PhysPosition, Position)
    .phase(POST_UPDATE)
    .update({ watch: PhysPosition, onEnter: true }, (entity, position) => {
      trace(CB.syncPosition, entity.eid);
      entity.set(Position, { x: position.x, y: position.y });
    });

  world
    .system("render:SyncRotation")
    .with(PhysRotation, Rotation)
    .phase(POST_UPDATE)
    .update({ watch: PhysRotation, onEnter: true }, (entity, rotation) => {
      trace(CB.syncRotation, entity.eid);
      entity.set(Rotation, { angle: rotation.angle });
    });
}

function installGameplay(sector: Sector): void {
  const { world, rng } = sector;

  // Client input arrives as a NetworkInput set by ServerWorld; route it to the
  // controlled ship's intent.
  world
    .system("game:PlayerInput")
    .with(NetworkClient, NetworkInput)
    .phase(PRE_UPDATE)
    .update(NetworkInput, (entity, networkInput) => {
      trace(CB.playerInput, entity.eid);
      const ship = entity.target(Controls);
      const bits = networkInput.input as number;
      ship?.getMut(InputIntent, (intent) => {
        intent.thrust = (bits & 1) !== 0;
        intent.left = (bits & 2) !== 0;
        intent.right = (bits & 4) !== 0;
        intent.fire = (bits & 8) !== 0;
      });
    });

  world
    .system("game:ShipControl")
    .with(Ship, InputIntent, PhysRotation, Force)
    .phase(ON_UPDATE)
    .each([Ship, InputIntent, PhysRotation, Force], (entity, [ship, input, rotation, force]) => {
      trace(CB.shipControl, entity.eid);
      if (!ship.controlled && rng.chance(0.05)) {
        input.thrust = rng.chance(0.6);
        input.left = rng.chance(0.3);
        input.right = !input.left && rng.chance(0.3);
        input.fire = rng.chance(0.5);
      }
      if (input.left) {
        rotation.angle += SHIP_TURN;
        entity.modified(PhysRotation);
      }
      if (input.right) {
        rotation.angle -= SHIP_TURN;
        entity.modified(PhysRotation);
      }
      const fx = input.thrust ? Math.cos(rotation.angle) * SHIP_THRUST : 0;
      const fy = input.thrust ? Math.sin(rotation.angle) * SHIP_THRUST : 0;
      if (force.x !== fx || force.y !== fy) {
        force.x = fx;
        force.y = fy;
        entity.modified(Force);
      }
      if (ship.cooldown > 0) {
        ship.cooldown--;
      } else if (input.fire) {
        ship.cooldown = FIRE_COOLDOWN_TICKS;
        const position = entity.get(PhysPosition)!;
        spawnBullet(sector, position, rotation.angle);
      }
    });

  world
    .system("game:Decay")
    .with(Lifetime)
    .phase(ON_UPDATE)
    .each([Lifetime], (entity, [lifetime]) => {
      trace(CB.decay, entity.eid);
      lifetime.ticks--;
      if (lifetime.ticks <= 0) {
        entity.destroy();
        sector.destroyed++;
      }
    });

  world
    .system("game:AsteroidChurn")
    .phase(ON_UPDATE)
    .run(() => churnAsteroids(sector));

  world
    .system("game:Wrap")
    .with(PhysPosition, Wraps)
    .phase(POST_UPDATE)
    .each([PhysPosition], (entity, [position]) => {
      trace(CB.wrap, entity.eid);
      let wrapped = false;
      if (position.x < 0) {
        position.x += WORLD_WIDTH;
        wrapped = true;
      } else if (position.x >= WORLD_WIDTH) {
        position.x -= WORLD_WIDTH;
        wrapped = true;
      }
      if (position.y < 0) {
        position.y += WORLD_HEIGHT;
        wrapped = true;
      } else if (position.y >= WORLD_HEIGHT) {
        position.y -= WORLD_HEIGHT;
        wrapped = true;
      }
      if (wrapped) {
        entity.modified(PhysPosition);
        const hyperspace = entity.getMut(Hyperspace);
        if (hyperspace) {
          hyperspace.seq += 1;
        }
      }
    });

  world
    .system("game:TrackMass")
    .with(Asteroid)
    .phase(POST_UPDATE)
    .enter([Asteroid], (entity, [asteroid]) => {
      trace(CB.massEnter, entity.eid);
      sector.asteroids.push(entity);
      world.component(MassTotal).getMut(MassTotal)!.total += asteroid.mass;
    })
    .exit([Asteroid], (entity, [asteroid]) => {
      trace(CB.massExit, entity.eid);
      const index = sector.asteroids.indexOf(entity);
      sector.asteroids[index] = sector.asteroids[sector.asteroids.length - 1];
      sector.asteroids.pop();
      world.component(MassTotal).getMut(MassTotal)!.total -= asteroid.mass;
    });

  world
    .system("game:HealthBars")
    .with(Health)
    .phase(POST_UPDATE)
    .update(Health, (entity, health) => {
      trace(CB.healthBar, entity.eid);
      for (const child of entity.children(DrawBy)) {
        child.set(ProgressBar, { value: health.hp / 100 });
      }
    });
}

function installInterestGrid(sector: Sector): void {
  const { world, cells } = sector;

  const assignCell = (entity: Entity, position: Position): void => {
    const cell = cells[cellIndexOf(position.x, position.y)];
    if (entity.target(InCell) !== cell) {
      entity.add(InCell, cell);
      sector.retargets++;
    }
  };

  world
    .system("grid:AssignCells")
    .with(Networked, Position)
    .phase(PRE_STORE)
    .enter((entity) => {
      trace(CB.cellEnter, entity.eid);
      const position = entity.get(Position);
      if (position) {
        assignCell(entity, position);
      }
    })
    .update(Position, (entity, position) => {
      trace(CB.cellUpdate, entity.eid);
      assignCell(entity, position);
    });

  world.component(InCell).on("targetAdd", (entity, _inCell, cell) => {
    trace(CB.cellHookAdd, entity.eid);
    for (const child of entity.children(DrawBy)) {
      if (child.has(Networked) && !child.has(Position) && child.target(InCell) !== cell) {
        child.add(InCell, cell);
      }
    }
  });

  world.component(InCell).on("remove", (entity) => {
    trace(CB.cellHookRemove, entity.eid);
    for (const child of entity.children(DrawBy)) {
      if (child.has(Networked) && !child.has(Position) && child.has(InCell)) {
        child.remove(InCell);
      }
    }
  });

  world
    .system("grid:AssignDisplayChildCells")
    .with(Networked)
    .phase(PRE_STORE)
    .update({ watch: DrawBy, onEnter: true }, (entity) => {
      trace(CB.displayChildCell, entity.eid);
      const cell = entity.target(DrawBy)?.target(InCell);
      if (cell && entity.target(InCell) !== cell) {
        entity.add(InCell, cell);
      }
    });

  const updateView = (entity: Entity, view: View): void => {
    const position = entity.target(Controls)?.get(Position);
    const dsl = position ? CELL_VIEW_DSL[cellIndexOf(position.x, position.y)] : false;
    if (view.dsl !== dsl) {
      view.dsl = dsl;
      entity.modified(View);
    }
  };

  // Each new client takes control of the next uncontrolled ship.
  world
    .system("session:AssignShip")
    .with(NetworkClient)
    .phase(PRE_UPDATE)
    .enter((entity) => {
      trace(CB.clientEnter, entity.eid);
      const ship = sector.ships.find((candidate) => !candidate.get(Ship)!.controlled);
      if (ship) {
        ship.getMut(Ship)!.controlled = true;
        entity.add(Controls, ship);
      }
    });

  world
    .system("grid:UpdatePlayerViews")
    .with(NetworkClient, View)
    .phase(PRE_STORE)
    .enter((entity) => {
      trace(CB.viewEnter, entity.eid);
      const view = entity.getMut(View);
      if (view) {
        updateView(entity, view);
      }
    })
    .each([View], (entity, [view]) => {
      trace(CB.viewEach, entity.eid);
      updateView(entity, view);
    });
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

function randomPoint(rng: Rng): { x: number; y: number } {
  return { x: rng.range(0, WORLD_WIDTH), y: rng.range(0, WORLD_HEIGHT) };
}

function spawnBody(
  sector: Sector,
  point: { x: number; y: number },
  vx: number,
  vy: number,
  angle: number
): Entity {
  sector.spawned++;
  return sector.world
    .entity()
    .add(Networked)
    .add(Body)
    .set(PhysPosition, { x: point.x, y: point.y })
    .set(PhysRotation, { angle })
    .set(LinearVelocity, { x: vx, y: vy })
    .set(AngularVelocity, { value: 0 })
    .set(Position, { x: point.x, y: point.y })
    .set(Rotation, { angle });
}

function spawnAsteroid(sector: Sector, point: { x: number; y: number }, mass: number): Entity {
  const { rng } = sector;
  const speed = rng.range(1, ASTEROID_MAX_SPEED);
  const heading = rng.range(0, 2 * Math.PI);
  const asteroid = spawnBody(
    sector,
    point,
    Math.cos(heading) * speed,
    Math.sin(heading) * speed,
    rng.range(0, 2 * Math.PI)
  )
    .set(AngularVelocity, { value: rng.range(-1, 1) })
    .set(Asteroid, { mass })
    .add(Wraps)
    .add(Health)
    .set(Arc, { radius: Math.sqrt(mass) / 2 })
    .set(FillStyle, { color: 0x808080, alpha: 1 })
    .set(StrokeStyle, { width: 1, color: 0xffffff, alpha: 1 })
    .set(Depth, { value: 1 })
    .add(Hyperspace);
  if (sector.spawned % LABELLED_ASTEROID_RATIO === 0) {
    spawnHealthBar(sector, asteroid);
  }
  return asteroid;
}

function spawnShip(sector: Sector, index: number): Entity {
  const ship = spawnBody(sector, randomPoint(sector.rng), 0, 0, 0)
    .set(Ship, { index })
    .add(InputIntent)
    .add(Force)
    .add(Wraps)
    .add(Health)
    .set(Triangle, { size: 2 })
    .set(FillStyle, { color: 0x00ff00, alpha: 1 })
    .set(Owner, { player: index })
    .set(Depth, { value: 2 })
    .add(Hyperspace)
    .add(HyperdriveArmed);
  spawnHealthBar(sector, ship);
  return ship;
}

function spawnHealthBar(sector: Sector, parent: Entity): Entity {
  return sector.world
    .entity()
    .add(Networked)
    .add(DrawBy, parent)
    .set(Offset, { x: 0, y: 2 })
    .set(Rectangle, { width: 3, height: 0.4 })
    .set(FillStyle, { color: 0xff0000, alpha: 1 })
    .set(ProgressBar, { value: 1 })
    .set(Depth, { value: 3 });
}

function spawnBullet(sector: Sector, from: PhysPosition, angle: number): void {
  spawnBody(
    sector,
    { x: from.x, y: from.y },
    Math.cos(angle) * BULLET_SPEED,
    Math.sin(angle) * BULLET_SPEED,
    angle
  )
    .set(Arc, { radius: 0.2 })
    .set(FillStyle, { color: 0xffff00, alpha: 1 })
    .set(Lifetime, { ticks: BULLET_TICKS })
    .add(Wraps);
}

function spawnExplosion(sector: Sector, at: Position, size: number): void {
  sector.spawned++;
  sector.world
    .entity()
    .add(Networked)
    .set(Position, { x: at.x, y: at.y })
    .set(Explosion, { size })
    .set(Lifetime, { ticks: EXPLOSION_TICKS });
}

/**
 * Split a random asteroid every few ticks, and destroy or spawn one to pull the
 * population back to its target, so the workload stays stationary.
 */
function churnAsteroids(sector: Sector): void {
  const { rng, asteroids } = sector;
  // Destroys are deferred until this system returns, so remember this tick's.
  const doomed = new Set<Entity>();
  if (asteroids.length > 0 && rng.chance(SPLIT_CHANCE)) {
    const victim = asteroids[rng.int(asteroids.length)];
    const asteroid = victim.get(Asteroid)!;
    const position = destroyAsteroid(sector, victim, doomed);
    if (position && asteroid.mass >= 8) {
      spawnAsteroid(sector, position, asteroid.mass / 2);
      spawnAsteroid(sector, position, asteroid.mass / 2);
    }
  }
  if (asteroids.length > CONFIG.asteroids) {
    destroyAsteroid(sector, asteroids[rng.int(asteroids.length)], doomed);
  } else if (asteroids.length < CONFIG.asteroids && rng.chance(0.5)) {
    spawnAsteroid(sector, { x: 0, y: rng.range(0, WORLD_HEIGHT) }, 8 + rng.int(24));
  }
  if (asteroids.length > 0 && rng.chance(DAMAGE_CHANCE)) {
    asteroids[rng.int(asteroids.length)].getMut(Health)!.hp -= 1;
  }
}

/** Destroy `victim` with an explosion; returns where it was, if it was still alive. */
function destroyAsteroid(
  sector: Sector,
  victim: Entity,
  doomed: Set<Entity>
): Position | undefined {
  const position = victim.get(Position);
  const asteroid = victim.get(Asteroid);
  if (!victim.alive || doomed.has(victim) || !position || !asteroid) {
    return undefined;
  }
  doomed.add(victim);
  victim.destroy();
  sector.destroyed++;
  spawnExplosion(sector, position, asteroid.mass);
  return position;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function connectClients(sector: Sector, index: number): void {
  const listener = new BenchListener();
  (sector.world as unknown as { _attach(listener: VecsSocketListener): void })._attach(listener);
  for (let i = 0; i < Math.min(CONFIG.clients, CONFIG.ships); i++) {
    const socket = new BenchSocket(`client-${index}-${i}`);
    listener.connect(socket);
    sector.clients.push({ socket, rng: new Rng(CONFIG.seed ^ (index * 31 + i)), input: 0 });
  }
}

/** Ack the frame just sent and occasionally change the steering input. */
function clientTick(client: BenchClient, frame: number): void {
  if (client.rng.chance(1 / 15)) {
    client.input = client.rng.int(16);
  }
  clientEncoder.reset();
  clientEncoder.write(new Client2Server({ ackFrame: frame, input: client.input }));
  client.socket.receive(clientEncoder.getBuffer());
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function tick(sectors: readonly Sector[], frame: number): void {
  const now = frame * DT_MS;
  for (const sector of sectors) {
    sector.world.progress(now, DT_MS);
  }
  for (const sector of sectors) {
    for (const client of sector.clients) {
      clientTick(client, frame);
    }
  }
}

function checksum(sectors: readonly Sector[]): string {
  let hash = 0x811c9dc5;
  const mix = (value: number): void => {
    hash = Math.imul(hash ^ (value | 0), 0x01000193);
  };
  for (const sector of sectors) {
    mix(sector.world.entities.size);
    mix(sector.asteroids.length);
    mix(sector.retargets);
    mix(sector.spawned);
    mix(sector.destroyed);
    mix(Math.round(sector.world.component(MassTotal).get(MassTotal)!.total * 1000));
    for (const sim of sector.engine.bodies) {
      if (sim.alive) {
        mix(sim.entity.eid);
        mix(Math.round(sim.x * 1000));
        mix(Math.round(sim.y * 1000));
      }
    }
    for (const client of sector.clients) {
      mix(client.socket.bytes);
      mix(client.socket.hash);
    }
  }
  return hex(hash);
}

function main(): void {
  const initStart = performance.now();
  const sectors = Array.from({ length: CONFIG.worlds }, (_, index) => createSector(index));
  sectors.forEach((sector, index) => connectClients(sector, index));
  const initMs = performance.now() - initStart;

  let frame = 0;
  for (let i = 0; i < CONFIG.warmupTicks; i++) {
    tick(sectors, ++frame);
  }

  const retargetsBefore = sum(sectors, (sector) => sector.retargets);
  const spawnedBefore = sum(sectors, (sector) => sector.spawned);
  const durations = new Float64Array(CONFIG.ticks);
  const measureStart = performance.now();
  for (let i = 0; i < CONFIG.ticks; i++) {
    const start = performance.now();
    tick(sectors, ++frame);
    durations[i] = performance.now() - start;
  }
  const totalMs = performance.now() - measureStart;

  const sorted = Array.from(durations).sort((a, b) => a - b);
  const mean = totalMs / CONFIG.ticks;
  const result = {
    config: CONFIG,
    node: process.version,
    initMs: round(initMs),
    totalMs: round(totalMs),
    tick: {
      mean: round(mean),
      median: round(percentile(sorted, 0.5)),
      p95: round(percentile(sorted, 0.95)),
      p99: round(percentile(sorted, 0.99)),
      min: round(sorted[0]),
      max: round(sorted[sorted.length - 1]),
      stdev: round(Math.sqrt(sorted.reduce((acc, d) => acc + (d - mean) ** 2, 0) / sorted.length)),
    },
    entities: sum(sectors, (sector) => sector.world.entities.size),
    asteroids: sum(sectors, (sector) => sector.asteroids.length),
    retargetsPerTick: round((sum(sectors, (s) => s.retargets) - retargetsBefore) / CONFIG.ticks),
    spawnsPerTick: round((sum(sectors, (s) => s.spawned) - spawnedBefore) / CONFIG.ticks),
    bytesSent: sum(sectors, (sector) => sum(sector.clients, (client) => client.socket.bytes)),
    checksum: checksum(sectors),
    trace: hex(traceHash),
  };

  console.log(
    [
      `sector-tick: ${CONFIG.worlds} worlds, ${result.entities} entities ` +
        `(${result.asteroids} asteroids), ${CONFIG.ticks} ticks after ${CONFIG.warmupTicks} warm-up`,
      `  tick mean ${result.tick.mean} ms, median ${result.tick.median} ms, ` +
        `p95 ${result.tick.p95} ms, p99 ${result.tick.p99} ms, stdev ${result.tick.stdev} ms`,
      `  init ${result.initMs} ms, measured ${result.totalMs} ms, ` +
        `${result.retargetsPerTick} InCell retargets/tick, ${result.spawnsPerTick} spawns/tick`,
      `  checksum ${result.checksum}, trace ${result.trace}, ${result.bytesSent} bytes sent`,
    ].join("\n")
  );
  console.log(`BENCH_RESULT ${JSON.stringify(result)}`);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function wire<T extends object>(Class: new () => T, fields: Record<string, WireTypeSpec>): void {
  for (const [key, spec] of Object.entries(fields)) {
    wireType(spec)(Class.prototype, key);
  }
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got '${raw}'`);
  }
  return value;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  let total = 0;
  for (const item of items) {
    total += value(item);
  }
  return total;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

main();
