// M8-3 — Query foundation: `physics(world)` accessor + `PhysicsQueries` facade.
//
// The ONE narrow imperative entry point vecs-physics exposes: world-scoped,
// read-only queries against the live Box2D world. Results are always Vecs
// entities (shape entities) and plain data — never Box2D handles.
//
// box2d3-wasm imports are confined to `src/adapter/`; this file is part of
// that boundary. Scratch allocations (b2Vec2, b2QueryFilter, b2AABB) reuse
// global pools allocated at module load. Transient allocations like b2RayResult
// are freed via explicit `finally { .delete() }`.

import { type EID, type Entity, type World } from "@vworlds/vecs";

import { type Vec2 } from "../components/geometry.js";
import { scr_b2AABB, scr_b2QueryFilter, scr_b2Vec2 } from "./runtime.js";
import {
  b2AABB,
  b2QueryFilter,
  getPhysics,
  type b2RayCallbackResult,
  type b2ShapeId,
  type PhysicsState,
} from "./state.js";

/** Category/mask filter applied to a query. Unlike a shape's own filter
 * (default `categoryBits = 1`), a query's default `categoryBits` is
 * `0xffffffff` so the query is not itself filtered out. */
export interface QueryFilter {
  /** Bits this query "is". Default `0xffffffff` (matches every category). */
  categoryBits?: number;
  /** Bits this query "sees". Default `0xffffffff` (sees every category). */
  maskBits?: number;
}

/** A single ray-cast hit, resolved to a Vecs shape entity with plain-data
 * geometry — never a Box2D handle. */
export interface RayHit {
  /** The shape entity that was hit. */
  entity: Entity;
  /** World-space hit point. */
  point: Vec2;
  /** World-space unit surface normal at the hit point. */
  normal: Vec2;
  /** Fraction along `from` → `to`, in `[0, 1]`. */
  fraction: number;
}

/**
 * Stable, world-scoped facade for synchronous read-only physics queries: ray
 * casts and spatial overlaps. Obtained via {@link physics}. Never mutates the
 * world, never creates or destroys entities, and never wakes bodies.
 */
export interface PhysicsQueries {
  /** Casts a ray from `from` to `to` and returns the closest hit, or `undefined`
   * if the ray hits nothing (or only hits shapes whose entity has since been
   * destroyed / removed). */
  rayCastClosest(query: { from: Vec2; to: Vec2; filter?: QueryFilter }): RayHit | undefined;

  /** Casts a ray from `from` to `to` and returns every hit along the way. */
  rayCastAll(query: { from: Vec2; to: Vec2; filter?: QueryFilter }): RayHit[];

  /** Returns every shape entity whose fat AABB overlaps `[min, max]`. This is
   * a broad-phase query: it can over-report relative to exact shape
   * overlap. */
  overlapAABB(query: { min: Vec2; max: Vec2; filter?: QueryFilter }): Entity[];

  /** Returns every shape entity that precisely overlaps a circle centered at
   * `center` with the given `radius`. */
  overlapCircle(query: { center: Vec2; radius: number; filter?: QueryFilter }): Entity[];
}

/**
 * Returns the {@link PhysicsQueries} facade for `world`.
 *
 * Throws if `world.module(PhysicsModule)` has not been called (the error
 * message comes from `getPhysics`). The returned facade is stable: repeated
 * calls for the same world return the same instance, so it never
 * re-allocates.
 */
export function physics(world: World): PhysicsQueries {
  const state = getPhysics(world);
  return (state.queries ??= new PhysicsQueriesImpl(world, state));
}

class PhysicsQueriesImpl implements PhysicsQueries {
  public constructor(
    private readonly world: World,
    private readonly state: PhysicsState
  ) {}

  public rayCastClosest(query: { from: Vec2; to: Vec2; filter?: QueryFilter }): RayHit | undefined {
    const { box2d, worldId } = this.state;

    const origin = scr_b2Vec2[0];
    origin.Set(query.from.x, query.from.y);

    const translation = scr_b2Vec2[1];
    translation.Set(query.to.x - query.from.x, query.to.y - query.from.y);

    const result = box2d.b2World_CastRayClosest(
      worldId,
      origin,
      translation,
      to_b2QueryFilter(query.filter)
    );
    try {
      if (!result.hit) {
        return undefined;
      }

      const entity = resolveShapeEntity(this.state, this.world, result.shapeId);
      if (entity === undefined) {
        return undefined;
      }

      return {
        entity,
        point: { x: result.point.x, y: result.point.y },
        normal: { x: result.normal.x, y: result.normal.y },
        fraction: result.fraction,
      };
    } finally {
      result.delete();
    }
  }

  public rayCastAll(query: { from: Vec2; to: Vec2; filter?: QueryFilter }): RayHit[] {
    const { box2d, worldId } = this.state;

    const origin = scr_b2Vec2[0];
    origin.Set(query.from.x, query.from.y);

    const translation = scr_b2Vec2[1];
    translation.Set(query.to.x - query.from.x, query.to.y - query.from.y);

    const hits: RayHit[] = [];
    box2d.b2World_CastRay(
      worldId,
      origin,
      translation,
      to_b2QueryFilter(query.filter),
      (result: b2RayCallbackResult) => {
        const entity = resolveShapeEntity(this.state, this.world, result.shapeId);
        if (entity !== undefined) {
          hits.push({
            entity,
            point: { x: result.point.x, y: result.point.y },
            normal: { x: result.normal.x, y: result.normal.y },
            fraction: result.fraction,
          });
        }
        return 1;
      }
    );

    return hits;
  }

  public overlapAABB(query: { min: Vec2; max: Vec2; filter?: QueryFilter }): Entity[] {
    const { box2d, worldId } = this.state;

    const aabb = scr_b2AABB!;
    aabb.lowerBound.Set(query.min.x, query.min.y);
    aabb.upperBound.Set(query.max.x, query.max.y);

    const entities: Entity[] = [];
    const seen = new Set<EID>();
    box2d.b2World_OverlapAABB(
      worldId,
      aabb,
      to_b2QueryFilter(query.filter),
      (result: { shapeId: b2ShapeId }) => {
        const entity = resolveShapeEntity(this.state, this.world, result.shapeId);
        if (entity !== undefined && !seen.has(entity.eid)) {
          seen.add(entity.eid);
          entities.push(entity);
        }
        return true;
      }
    );

    return entities;
  }

  public overlapCircle(query: { center: Vec2; radius: number; filter?: QueryFilter }): Entity[] {
    const { box2d, worldId } = this.state;

    const centerVec = scr_b2Vec2[0];
    centerVec.Set(query.center.x, query.center.y);

    const proxy = box2d.b2MakeProxy(centerVec, 1, query.radius);
    try {
      const entities: Entity[] = [];
      const seen = new Set<EID>();
      box2d.b2World_OverlapShape(
        worldId,
        proxy,
        to_b2QueryFilter(query.filter),
        (result: { shapeId: b2ShapeId }) => {
          const entity = resolveShapeEntity(this.state, this.world, result.shapeId);
          if (entity !== undefined && !seen.has(entity.eid)) {
            seen.add(entity.eid);
            entities.push(entity);
          }
          return true;
        }
      );

      return entities;
    } finally {
      proxy.delete();
    }
  }
}

/** Maps a {@link QueryFilter} (default `0xffffffff`/`0xffffffff` — "sees and
 * is seen by everything") and returns a scratch `b2QueryFilter`. `b2QueryFilter` is not
 * `b2DefaultQueryFilter` here: the default-constructed filter is all zeros,
 * which would match nothing.
 * to_b2QueryFilter cannot be called again until the returned b2QueryFilter is no longer in use
 * */
function to_b2QueryFilter(filter: QueryFilter | undefined): b2QueryFilter {
  const target = scr_b2QueryFilter[0];
  target.categoryBits = filter?.categoryBits ?? 0xffffffff;
  target.maskBits = filter?.maskBits ?? 0xffffffff;
  return target;
}

/** Resolves a Box2D shape hit back to its Vecs shape entity, mirroring the
 * `PhysicsEvents` shape→entity resolution (`src/systems/events.ts`):
 * `entityByShapeIndex.get(shapeId.index1)` → `EID` → live `Entity`. Returns
 * `undefined` (drop silently) if the slot is empty or the entity has been
 * destroyed — the same rule as `PhysicsEvents`. */
function resolveShapeEntity(
  state: PhysicsState,
  world: World,
  shapeId: b2ShapeId
): Entity | undefined {
  const eid = state.entityByShapeIndex.get(shapeId.index1);
  if (eid === undefined) {
    return undefined;
  }

  const entity = world.getEntity(eid);
  if (entity === undefined || (entity as unknown as { _destroyed?: boolean })._destroyed === true) {
    return undefined;
  }

  return entity;
}
