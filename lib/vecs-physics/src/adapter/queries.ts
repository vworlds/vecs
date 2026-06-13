// M8-3 — Query foundation: `physics(world)` accessor + `PhysicsQueries` facade.
//
// The ONE narrow imperative entry point vecs-physics exposes: world-scoped,
// read-only queries against the live Box2D world. Results are always Vecs
// entities (shape entities) and plain data — never Box2D handles.
//
// box2d3-wasm imports are confined to `src/adapter/`; this file is part of
// that boundary. Every `new b2Xxx()` allocation (and the `b2RayResult`
// returned by value from `b2World_CastRayClosest`) is freed via
// `withAllocated` or an explicit `finally { .delete() }`.

import { type Entity, type World } from "@vworlds/vecs";

import { type Vec2 } from "../components/geometry.js";
import { withAllocated } from "./disposal.js";
import {
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
  /** Casts a ray from `from` to `to` and returns the closest hit, or `null`
   * if the ray hits nothing (or only hits shapes whose entity has since been
   * destroyed / removed). */
  rayCastClosest(query: { from: Vec2; to: Vec2; filter?: QueryFilter }): RayHit | null;

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

  public rayCastClosest(query: { from: Vec2; to: Vec2; filter?: QueryFilter }): RayHit | null {
    const { box2d, worldId } = this.state;
    return withAllocated(
      () => new box2d.b2Vec2(query.from.x, query.from.y),
      (origin) =>
        withAllocated(
          () => new box2d.b2Vec2(query.to.x - query.from.x, query.to.y - query.from.y),
          (translation) =>
            withAllocated(
              () => new box2d.b2QueryFilter(),
              (filter) => {
                applyQueryFilter(filter, query.filter);

                const result = box2d.b2World_CastRayClosest(worldId, origin, translation, filter);
                try {
                  if (!result.hit) {
                    return null;
                  }

                  const entity = resolveShapeEntity(this.state, this.world, result.shapeId);
                  if (entity === undefined) {
                    return null;
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
            )
        )
    );
  }

  public rayCastAll(query: { from: Vec2; to: Vec2; filter?: QueryFilter }): RayHit[] {
    const { box2d, worldId } = this.state;
    return withAllocated(
      () => new box2d.b2Vec2(query.from.x, query.from.y),
      (origin) =>
        withAllocated(
          () => new box2d.b2Vec2(query.to.x - query.from.x, query.to.y - query.from.y),
          (translation) =>
            withAllocated(
              () => new box2d.b2QueryFilter(),
              (filter) => {
                applyQueryFilter(filter, query.filter);

                const hits: RayHit[] = [];
                box2d.b2World_CastRay(
                  worldId,
                  origin,
                  translation,
                  filter,
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
            )
        )
    );
  }

  public overlapAABB(_query: { min: Vec2; max: Vec2; filter?: QueryFilter }): Entity[] {
    throw new Error("overlapAABB is not yet implemented (M8-4/M8-5)");
  }

  public overlapCircle(_query: { center: Vec2; radius: number; filter?: QueryFilter }): Entity[] {
    throw new Error("overlapCircle is not yet implemented (M8-4/M8-5)");
  }
}

/** Maps a {@link QueryFilter} (default `0xffffffff`/`0xffffffff` — "sees and
 * is seen by everything") onto a `b2QueryFilter`. `b2QueryFilter` is not
 * `b2DefaultQueryFilter` here: the default-constructed filter is all zeros,
 * which would match nothing. */
function applyQueryFilter(
  target: { categoryBits: number; maskBits: number },
  filter: QueryFilter | undefined
): void {
  target.categoryBits = filter?.categoryBits ?? 0xffffffff;
  target.maskBits = filter?.maskBits ?? 0xffffffff;
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
