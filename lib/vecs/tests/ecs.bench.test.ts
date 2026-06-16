import { describe, expect, it } from "vitest";
import { type Entity, type Query, World } from "../src/index.js";

const runBench = process.env.RUN_VECS_ECS_BENCH === "1" ? it : it.skip;

const MAX_ENTITIES_RANGE = 2_097_152;
const SMALL_MAX_ENTITIES_RANGE = 32_768;
const ROUNDS = Number(process.env.RUN_VECS_ECS_BENCH_ROUNDS ?? 3);

type BenchCase = {
  name: string;
  counts: readonly number[];
  operations: (entities: number) => number;
  makeRound: (entities: number) => () => number;
};

type BenchResult = {
  name: string;
  entities: number;
  medianMs: number;
  opsPerSec: number;
  checksum: number;
};

const enum PlayerType {
  NPC,
  Monster,
  Hero,
}

const enum StatusEffect {
  Spawn,
  Dead,
  Alive,
}

class PositionComponent {
  x = 0;
  y = 0;
}

class VelocityComponent {
  x = 1;
  y = 1;
}

class DataComponent {
  thingy = 0;
  dingy = 0;
  mingy = false;
  rng = new RandomXoshiro128(340_383);
  numgy = this.rng.next();
}

class PlayerComponent {
  rng = new RandomXoshiro128(1);
  type = PlayerType.NPC;
}

class HealthComponent {
  hp = 0;
  maxhp = 0;
  status = StatusEffect.Spawn;
}

class DamageComponent {
  atk = 0;
  def = 0;
}

class SpriteComponent {
  character = " ";
}

class EmptyComponent {}

describe("Vecs ECS benchmark", () => {
  runBench(
    "matches ecs_benchmark category and entity-count matrix",
    () => {
      const results = cases().flatMap((benchCase) =>
        benchCase.counts.map((entities) =>
          bench(benchCase.name, entities, benchCase.operations(entities), () =>
            benchCase.makeRound(entities)
          )
        )
      );

      console.info("\nVecs ECS benchmark results");
      for (const result of results) {
        console.info(
          `${result.name}/${result.entities}: ${result.medianMs.toFixed(2)} ms, ${result.opsPerSec.toLocaleString()} ops/sec, checksum ${result.checksum}`
        );
      }

      expect(results.every((result) => Number.isFinite(result.medianMs))).toBe(true);
    },
    1_800_000
  );
});

function cases(): BenchCase[] {
  const defaultCounts = entityCounts(MAX_ENTITIES_RANGE);
  const smallCounts = entityCounts(SMALL_MAX_ENTITIES_RANGE);

  return [
    {
      name: "BM_CreateNoEntities",
      counts: [0],
      operations: () => 1,
      makeRound: () => () => {
        world();
        return 1;
      },
    },
    {
      name: "BM_CreateEmptyEntities",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => () => createEntities(world(), entities, createEmpty),
    },
    {
      name: "BM_CreateEmptyEntitiesInBulk",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => () => createEntities(world(), entities, createEmpty),
    },
    {
      name: "BM_CreateEntities",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => () => createEntities(world(), entities, createMinimal),
    },
    {
      name: "BM_CreateEntitiesInBulk",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => () => createEntities(world(), entities, createMinimal),
    },
    {
      name: "BM_DestroyEntities",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const { items } = createMinimalEntities(entities);
        return () => {
          let checksum = checksumCount(entities);
          for (const e of items) {
            checksum += e.eid;
            e.destroy();
          }
          return checksum;
        };
      },
    },
    {
      name: "BM_UnpackNoComponent",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const { items } = createEmptyEntities(entities);
        return () => {
          let checksum = checksumCount(entities);
          for (const e of items) {
            checksum += e.get(DataComponent) === undefined ? 1 : 0;
          }
          return checksum;
        };
      },
    },
    {
      name: "BM_UnpackOneComponent",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const { items } = createMinimalEntities(entities);
        return () => {
          let checksum = checksumCount(entities);
          for (const e of items) {
            checksum += e.get(PositionComponent)!.x;
          }
          return checksum;
        };
      },
    },
    {
      name: "BM_UnpackTwoComponents",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const { items } = createMinimalEntities(entities);
        return () => {
          let checksum = checksumCount(entities);
          for (const e of items) {
            checksum += e.get(PositionComponent)!.x + e.get(VelocityComponent)!.x;
          }
          return checksum;
        };
      },
    },
    {
      name: "BM_UnpackThreeComponents",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const { items } = createHalfComponentEntities(entities);
        return () => {
          let checksum = checksumCount(entities);
          for (const e of items) {
            checksum += e.get(PositionComponent)!.x + e.get(VelocityComponent)!.x;
            checksum += e.get(DataComponent)?.thingy ?? 0;
          }
          return checksum;
        };
      },
    },
    {
      name: "BM_AddComponent",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const { items } = createMinimalEntities(entities);
        for (const e of items) {
          e.remove(PositionComponent);
        }
        return () => {
          let checksum = checksumCount(entities);
          for (const e of items) {
            e.add(PositionComponent);
            checksum += e.get(PositionComponent) === undefined ? 0 : 1;
          }
          return checksum;
        };
      },
    },
    {
      name: "BM_RemoveAddComponent",
      counts: defaultCounts,
      operations: (entities) => entities * 2,
      makeRound: (entities) => {
        const { items } = createMinimalEntities(entities);
        return () => {
          let checksum = checksumCount(entities);
          for (const e of items) {
            e.remove(PositionComponent);
            e.add(PositionComponent);
            checksum += e.get(PositionComponent) === undefined ? 0 : 1;
          }
          return checksum;
        };
      },
    },
    {
      name: "BM_SystemsUpdate",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const app = application(false);
        createSystemUpdateEntities(app.w, entities, false);
        return () => updateApp(app, 1 / 60);
      },
    },
    {
      name: "BM_SystemsUpdateMixedEntities",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const app = application(false);
        createSystemUpdateEntities(app.w, entities, true);
        return () => updateApp(app, 1 / 60);
      },
    },
    {
      name: "BM_ComplexSystemsUpdate",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const app = application(true);
        createSystemUpdateEntities(app.w, entities, false);
        return () => updateApp(app, 1 / 60);
      },
    },
    {
      name: "BM_ComplexSystemsUpdateMixedEntities",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const app = application(true);
        createSystemUpdateEntities(app.w, entities, true);
        return () => updateApp(app, 1 / 60);
      },
    },
    {
      name: "BM_IterateSingleComponent",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        // Build the query before populating so entities flow in incrementally
        // and the scramble reorders the query's members — the realistic order
        // (queries are defined at startup). Building it after population would
        // let a backfill re-read entities in creation order, undoing the
        // scramble and measuring cache-friendly creation-order iteration.
        const w = world();
        const q = w.query("single").with(PositionComponent).build();
        const items = createSingleComponents(w, entities);
        scrambleStorage(w, items);
        return () => iterateOne(q, entities);
      },
    },
    {
      name: "BM_IterateTwoComponents",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const w = world();
        const q = w.query("two").with(PositionComponent, VelocityComponent).build();
        const items = createMinimalComponents(w, entities);
        scrambleStorage(w, items);
        return () => iterateTwo(q, entities);
      },
    },
    {
      name: "BM_IterateThreeComponentsWithMixedEntities",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const w = world();
        const q = w
          .query("three")
          .with(PositionComponent, VelocityComponent, DataComponent)
          .build();
        const items = createMixedComponents(w, entities);
        scrambleStorage(w, items);
        return () => iterateThree(q, entities);
      },
    },
    {
      name: "BM_EnqueueAndUpdateEventsViaObserverWithMixedEntities",
      counts: defaultCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const w = world();
        let checksum = 0;
        const q = w.query("event-src").with(PositionComponent, VelocityComponent).build();
        w.query("events")
          .with(EmptyComponent)
          .update(
            { watch: EmptyComponent, inject: [PositionComponent, VelocityComponent] },
            (_e, _event, [pos, vel]) => {
              checksum += (pos?.x ?? 0) + (vel?.x ?? 0);
            }
          )
          .build();
        const items = createMixedComponents(w, entities);
        scrambleStorage(w, items);
        return () => {
          checksum = checksumCount(entities);
          q.forEach((e) => {
            e.add(EmptyComponent);
            e.modified(EmptyComponent);
            e.remove(EmptyComponent);
          });
          return checksum;
        };
      },
    },
    {
      name: "BM_EmitAndUpdateEventsViaObserverWithMixedEntities",
      counts: smallCounts,
      operations: (entities) => entities,
      makeRound: (entities) => {
        const w = world();
        const q = w.query("event-src").with(PositionComponent, VelocityComponent).build();
        const items = createMixedComponents(w, entities);
        scrambleStorage(w, items);
        return () => {
          let checksum = checksumCount(entities);
          q.forEach([PositionComponent, VelocityComponent], (_e, [pos, vel]) => {
            checksum += pos.x + vel.x;
          });
          return checksum;
        };
      },
    },
  ];
}

function bench(
  name: string,
  entities: number,
  operations: number,
  makeRound: () => () => number
): BenchResult {
  const durations: number[] = [];
  let checksum = 0;

  makeRound()();

  for (let i = 0; i < ROUNDS; i++) {
    const run = makeRound();
    const start = nowNs();
    checksum ^= run();
    durations.push(Number(nowNs() - start) / 1_000_000);
  }

  const medianMs = median(durations);
  return {
    name,
    entities,
    medianMs,
    opsPerSec: medianMs === 0 ? 0 : Math.round((operations / medianMs) * 1000),
    checksum,
  };
}

function application(complex: boolean): { w: World; positionQuery: Query } {
  const w = world();
  const positionQuery = w.query("checksum").with(PositionComponent).build();

  w.system("MovementSystem")
    .with(PositionComponent, VelocityComponent)
    .each([PositionComponent, VelocityComponent], (_e, [position, direction]) => {
      updatePosition(position, direction, 1 / 60);
    });
  w.system("DataSystem")
    .with(DataComponent)
    .each([DataComponent], (_e, [data]) => {
      updateData(data, 1 / 60);
    });

  if (complex) {
    const frameBuffer = new FrameBuffer(320, 240);
    w.system("MoreComplexSystem")
      .with(PositionComponent, VelocityComponent, DataComponent)
      .each(
        [PositionComponent, VelocityComponent, DataComponent],
        (_e, [position, direction, data]) => {
          updateMoreComplex(position, direction, data);
        }
      );
    w.system("HealthSystem")
      .with(HealthComponent)
      .each([HealthComponent], (_e, [health]) => {
        updateHealth(health);
      });
    w.system("DamageSystem")
      .with(HealthComponent, DamageComponent)
      .each([HealthComponent, DamageComponent], (_e, [health, damage]) => {
        updateDamage(health, damage);
      });
    w.system("SpriteSystem")
      .with(SpriteComponent, PlayerComponent, HealthComponent)
      .each([SpriteComponent, PlayerComponent, HealthComponent], (_e, [sprite, player, health]) => {
        updateSprite(sprite, player, health);
      });
    w.system("RenderSystem")
      .with(PositionComponent, SpriteComponent)
      .each([PositionComponent, SpriteComponent], (_e, [position, sprite]) => {
        frameBuffer.draw(position.x, position.y, sprite.character.charCodeAt(0));
      });
  }
  return { w, positionQuery };
}

function createSystemUpdateEntities(w: World, count: number, mixed: boolean): Entity[] {
  const items = mixed ? createMixedComponents(w, count) : createFullComponents(w, count);
  addHeroMonsterForSystemUpdate(w, items, mixed);
  scrambleStorage(w, items);
  return items;
}

function addHeroMonsterForSystemUpdate(w: World, items: readonly Entity[], mixed: boolean): void {
  if (!mixed) {
    for (const e of items) {
      addHeroMonsterComponents(w, e, undefined);
    }
    return;
  }

  for (let i = 0, j = 0; i < items.length; i++) {
    if ((items.length < 100 && i === 0) || items.length >= 100 || i >= items.length / 8) {
      if ((items.length < 100 && i === 0) || items.length >= 100 || j % 2 === 0) {
        if (i === 0) {
          addHeroMonsterComponents(w, items[i], PlayerType.Hero);
        } else if (i % 6 === 0) {
          addHeroMonsterComponents(w, items[i], undefined);
        } else if (i % 4 === 0) {
          addHeroMonsterComponents(w, items[i], PlayerType.Hero);
        } else if (i % 2 === 0) {
          addHeroMonsterComponents(w, items[i], PlayerType.Monster);
        }
      }
      j++;
    }
  }
}

function addHeroMonsterComponents(w: World, e: Entity, playerType: PlayerType | undefined): void {
  e.add(PlayerComponent);
  e.add(HealthComponent);
  e.add(DamageComponent);
  e.add(SpriteComponent);
  if (!e.get(PositionComponent)) {
    e.add(PositionComponent);
  }
  initHeroMonster(w, e, playerType);
}

function initHeroMonster(_w: World, e: Entity, playerType: PlayerType | undefined): void {
  const position = e.get(PositionComponent)!;
  const player = e.get(PlayerComponent)!;
  const health = e.get(HealthComponent)!;
  const damage = e.get(DamageComponent)!;
  const sprite = e.get(SpriteComponent)!;

  player.type =
    playerType ??
    (() => {
      const playerTypeRate = player.rng.range(1, 100);
      return playerTypeRate <= 3
        ? PlayerType.NPC
        : playerTypeRate <= 30
          ? PlayerType.Hero
          : PlayerType.Monster;
    })();
  switch (player.type) {
    case PlayerType.Hero:
      health.maxhp = player.rng.range(5, 15);
      damage.def = player.rng.range(2, 6);
      damage.atk = player.rng.range(4, 10);
      break;
    case PlayerType.Monster:
      health.maxhp = player.rng.range(4, 12);
      damage.def = player.rng.range(2, 8);
      damage.atk = player.rng.range(3, 9);
      break;
    case PlayerType.NPC:
      health.maxhp = player.rng.range(6, 12);
      damage.def = player.rng.range(3, 8);
      damage.atk = 0;
      break;
  }

  sprite.character = "_";
  position.x = player.rng.range(0, 420) - 100;
  position.y = player.rng.range(0, 340) - 100;
}

function updateApp(app: { w: World; positionQuery: Query }, dt: number): number {
  app.w.progress(0, dt);
  return iterateOne(app.positionQuery, app.positionQuery.count);
}

function createEmptyEntities(count: number): { w: World; items: Entity[] } {
  const w = world();
  const items = createEmptyComponents(w, count);
  scrambleStorage(w, items);
  return { w, items };
}

function createMinimalEntities(count: number): { w: World; items: Entity[] } {
  const w = world();
  const items = createMinimalComponents(w, count);
  scrambleStorage(w, items);
  return { w, items };
}

function createHalfComponentEntities(count: number): { w: World; items: Entity[] } {
  const w = world();
  const items = createHalfComponents(w, count);
  scrambleStorage(w, items);
  return { w, items };
}

/**
 * Simulate the storage state of a world that has been mutated for hours of
 * gameplay rather than freshly populated in a single ordered pass.
 *
 * A freshly built world has a convenient property the reference suite leans
 * on by accident: entities enter every query in creation order, and that order
 * matches the heap-allocation order of their component instances, so iterating
 * a query walks those objects near-sequentially. A long-running game never has
 * that — entities spawn and die, components are added and removed, and the
 * order a query reports its members in drifts away from any allocation order.
 *
 * To model that fairly for every implementation, visit the entities in a
 * deterministic shuffled order and, for each one, detach and re-attach its
 * existing component instances. The component objects keep their original heap
 * positions (re-attach stores the same instance), but every query re-tracks
 * the entity at a fresh position, so query iteration order no longer matches
 * allocation order. No component data is lost and the archetype population is
 * unchanged; only the storage/iteration order is scrambled.
 */
function scrambleStorage(_w: World, items: readonly Entity[]): void {
  const rng = new RandomXoshiro128(0x5c8a3b);
  const order: number[] = items.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const k = rng.range(0, i);
    const tmp = order[i];
    order[i] = order[k];
    order[k] = tmp;
  }

  const instances: object[] = [];
  for (const idx of order) {
    const e = items[idx];
    instances.length = 0;
    e.components.forEach((instance) => instances.push(instance));
    for (const instance of instances) {
      e.remove(instance.constructor as never);
    }
    for (const instance of instances) {
      e.attach(instance);
    }
  }
}

function createEntities(
  w: World,
  count: number,
  create: (w: World, index: number) => Entity
): number {
  let checksum = checksumCount(count);
  for (let i = 0; i < count; i++) {
    checksum += create(w, i).eid;
  }
  return checksum;
}

function createEmptyComponents(w: World, count: number): Entity[] {
  return createComponents(w, count, createEmpty);
}

function createSingleComponents(w: World, count: number): Entity[] {
  return createComponents(w, count, createSingle);
}

function createMinimalComponents(w: World, count: number): Entity[] {
  return createComponents(w, count, createMinimal);
}

function createFullComponents(w: World, count: number): Entity[] {
  return createComponents(w, count, createFull);
}

function createHalfComponents(w: World, count: number): Entity[] {
  const items: Entity[] = [];
  items.length = count;
  for (let i = 0; i < count; i++) {
    items[i] = i % 2 === 0 ? createFull(w, i) : createMinimal(w, i);
  }
  return items;
}

function createMixedComponents(w: World, count: number): Entity[] {
  const items: Entity[] = [];
  items.length = count;
  for (let i = 0, j = 0; i < count; i++) {
    const e = createFull(w, i);
    if (count < 100 || (i >= (2 * count) / 4 && i <= (3 * count) / 4)) {
      if (count < 100 || j % 10 === 0) {
        if (i % 7 === 0) {
          e.remove(PositionComponent);
        }
        if (i % 11 === 0) {
          e.remove(VelocityComponent);
        }
        if (i % 13 === 0) {
          e.remove(DataComponent);
        }
      }
      j++;
    }
    items[i] = e;
  }
  return items;
}

function createComponents(
  w: World,
  count: number,
  create: (w: World, index: number) => Entity
): Entity[] {
  const items: Entity[] = [];
  items.length = count;
  for (let i = 0; i < count; i++) {
    items[i] = create(w, i);
  }
  return items;
}

function createEmpty(w: World): Entity {
  return w.entity();
}

function createSingle(w: World, index: number): Entity {
  const e = w.entity();
  e.set(PositionComponent, { x: index, y: index });
  return e;
}

function createMinimal(w: World, index: number): Entity {
  const e = createSingle(w, index);
  e.set(VelocityComponent, { x: 1, y: 1 });
  return e;
}

function createFull(w: World, index: number): Entity {
  const e = createMinimal(w, index);
  e.set(DataComponent, { thingy: index });
  return e;
}

function iterateOne(q: Query, count: number): number {
  let checksum = checksumCount(count);
  q.forEach([PositionComponent], (_e, [position]) => {
    checksum += position.x;
  });
  return checksum;
}

function iterateTwo(q: Query, count: number): number {
  let checksum = checksumCount(count);
  q.forEach([PositionComponent, VelocityComponent], (_e, [position, velocity]) => {
    checksum += position.x + velocity.x;
  });
  return checksum;
}

function iterateThree(q: Query, count: number): number {
  let checksum = checksumCount(count);
  q.forEach(
    [PositionComponent, VelocityComponent, DataComponent],
    (_e, [position, velocity, data]) => {
      checksum += position.x + velocity.x + data.thingy;
    }
  );
  return checksum;
}

function updatePosition(
  position: PositionComponent,
  direction: Readonly<VelocityComponent>,
  dt: number
): void {
  position.x += direction.x * dt;
  position.y += direction.y * dt;
}

function updateData(data: DataComponent, dt: number): void {
  data.thingy = (data.thingy + 1) % 1_000_000;
  data.dingy += 0.0001 * dt;
  data.mingy = !data.mingy;
  data.numgy = data.rng.next();
}

function updateMoreComplex(
  position: Readonly<PositionComponent>,
  direction: VelocityComponent,
  data: DataComponent
): void {
  if (data.thingy % 10 !== 0) {
    return;
  }
  if (position.x > position.y) {
    direction.x = data.rng.range(3, 19) - 10;
    direction.y = data.rng.range(0, 5);
  } else {
    direction.x = data.rng.range(0, 5);
    direction.y = data.rng.range(3, 19) - 10;
  }
}

function updateHealth(health: HealthComponent): void {
  if (health.hp <= 0 && health.status !== StatusEffect.Dead) {
    health.hp = 0;
    health.status = StatusEffect.Dead;
  } else if (health.status === StatusEffect.Dead && health.hp === 0) {
    health.hp = health.maxhp;
    health.status = StatusEffect.Spawn;
  } else if (health.hp >= health.maxhp && health.status !== StatusEffect.Alive) {
    health.hp = health.maxhp;
    health.status = StatusEffect.Alive;
  } else {
    health.status = StatusEffect.Alive;
  }
}

function updateDamage(health: HealthComponent, damage: Readonly<DamageComponent>): void {
  const totalDamage = damage.atk - damage.def;
  if (health.hp > 0 && totalDamage > 0) {
    health.hp = Math.max(health.hp - totalDamage, 0);
  }
}

function updateSprite(
  sprite: SpriteComponent,
  player: Readonly<PlayerComponent>,
  health: Readonly<HealthComponent>
): void {
  switch (health.status) {
    case StatusEffect.Alive:
      sprite.character =
        player.type === PlayerType.Hero ? "@" : player.type === PlayerType.Monster ? "k" : "h";
      break;
    case StatusEffect.Dead:
      sprite.character = "|";
      break;
    case StatusEffect.Spawn:
      sprite.character = "_";
      break;
  }
}

function world(): World {
  const w = new World();
  w.component(PositionComponent);
  w.component(VelocityComponent);
  w.component(DataComponent);
  w.component(PlayerComponent);
  w.component(HealthComponent);
  w.component(DamageComponent);
  w.component(SpriteComponent);
  w.component(EmptyComponent);
  return w;
}

function entityCounts(max: number): number[] {
  const explicit = process.env.RUN_VECS_ECS_BENCH_COUNTS;
  if (explicit) {
    return explicit.split(",").map((value) => Number(value.trim()));
  }
  const counts = [0, 1];
  for (let value = 2; value <= max; value *= 2) {
    counts.push(value);
  }
  return counts;
}

function checksumCount(count: number): number {
  return count + 1;
}

function median(values: readonly number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function nowNs(): bigint {
  return process.hrtime.bigint();
}

class FrameBuffer {
  private readonly _data: Uint8Array;

  public constructor(
    private readonly width: number,
    height: number
  ) {
    this._data = new Uint8Array(width * height);
  }

  public draw(x: number, y: number, value: number): void {
    const ix = Math.trunc(x);
    const iy = Math.trunc(y);
    if (ix < 0 || iy < 0 || ix >= this.width) {
      return;
    }
    const index = iy * this.width + ix;
    if (index >= 0 && index < this._data.length) {
      this._data[index] = value;
    }
  }
}

class RandomXoshiro128 {
  private _s0: number;
  private _s1: number;
  private _s2: number;
  private _s3: number;

  public constructor(seed: number) {
    this._s0 = (seed + 3) >>> 0;
    this._s1 = (seed + 5) >>> 0;
    this._s2 = (seed + 7) >>> 0;
    this._s3 = (seed + 11) >>> 0;
  }

  public next(): number {
    const result = Math.imul(rotl(Math.imul(this._s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this._s1 << 9) >>> 0;

    this._s2 ^= this._s0;
    this._s3 ^= this._s1;
    this._s1 ^= this._s2;
    this._s0 ^= this._s3;
    this._s2 ^= t;
    this._s3 = rotl(this._s3, 11);

    return result >>> 0;
  }

  public range(low: number, high: number): number {
    return (this.next() % (high - low + 1)) + low;
  }
}

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}
