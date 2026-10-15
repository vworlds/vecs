// M8-3 — Query foundation: `physics(world)` accessor + `PhysicsQueries` facade.
//
// The ONE narrow imperative entry point vecs-physics exposes: world-scoped,
// read-only queries against the live Box2D world. Results are always Vecs
// entities (shapes for spatial hits, bodies for pose changes) and plain data — never Box2D handles.
//
// box2d3-wasm imports are confined to `src/adapter/`; this file is part of
// that boundary. Scratch allocations (b2Vec2, b2QueryFilter, b2AABB,
// b2ShapeProxy) reuse global pools allocated at module load. Transient
// allocations like b2RayResult are freed via explicit `finally { .delete() }`.

import { type EID, type Entity, type Vec2, type World } from "@vworlds/vecs";

import { Body } from "../body/components.js";
import { Box, Capsule, Circle, Polygon, Segment } from "../shapes/components.js";
import {
  scr_b2AABB,
  scr_b2QueryFilter,
  scr_b2ShapeProxy,
  scr_b2Vec2,
  rev,
  scr_fastOut,
  type Box2DModule,
} from "./runtime.js";
import {
  b2QueryFilter,
  getPhysicsEngine,
  type b2RayCallbackResult,
  type b2ShapeId,
  type b2ShapeProxy,
  type PhysicsEngine,
} from "./engine.js";

/** Box2D's `B2_MAX_POLYGON_VERTICES` — the most points a cast {@link Polygon}
 * (and a `b2ShapeProxy`) can carry. Mirrors `src/shapes/lifecycle.ts`. */
const MAX_POLYGON_VERTICES = 8;

/** Category/mask filter applied to a query. Unlike a shape's own filter
 * (default `categoryBits = 1`), a query's default `categoryBits` is
 * `0xffffffff` so the query is not itself filtered out. */
export interface QueryFilter {
  /** Bits this query "is". Default `0xffffffff` (matches every category). */
  categoryBits?: number;
  /** Bits this query "sees". Default `0xffffffff` (sees every category). */
  maskBits?: number;
}

/** Live Box2D object counts for one physics world, read by {@link PhysicsQueries.stats}. */
export interface PhysicsStats {
  /** Bodies currently alive in Box2D. */
  bodyCount: number;
  /** Shapes currently alive in Box2D; every segment of a chain counts as one shape. */
  shapeCount: number;
  /** Joints currently alive in Box2D. */
  jointCount: number;
  /** Contacts currently alive in Box2D, touching or not. */
  contactCount: number;
}

/**
 * The resolved settings of a physics world, read by {@link PhysicsQueries.settings}: the values
 * `PhysicsModule` built the Box2D world with, defaults filled in.
 */
export interface PhysicsSettings {
  /** World gravity in m/s². */
  readonly gravity: Readonly<Vec2>;
  /** Duration of one physics step, in seconds. */
  readonly fixedTimeStep: number;
  /** Box2D substeps per physics step. */
  readonly subSteps: number;
  /** Box2D's cap on the linear speed of a body, in m/s. */
  readonly maximumLinearSpeed: number;
}

/**
 * A body's motion as Box2D holds it, filled by {@link PhysicsQueries.bodyMotion}: what a peer needs
 * to extrapolate the body, such as a dead-reckoning baseline. Plain data; allocate one and reuse it.
 */
export class BodyMotion {
  /** Whether the body is awake. A sleeping body does not move and reports zero velocities. */
  public awake = false;
  /** Linear velocity of the center of mass, x, in m/s. */
  public vx = 0;
  /** Linear velocity of the center of mass, y, in m/s. */
  public vy = 0;
  /** Angular velocity in rad/s. */
  public w = 0;
  /** Linear damping, per second. */
  public linearDamping = 0;
  /** Angular damping, per second. */
  public angularDamping = 0;
  /** Center of mass in body coordinates, x, in meters. */
  public localCenterX = 0;
  /** Center of mass in body coordinates, y, in meters. */
  public localCenterY = 0;
  /**
   * The gravity scale Box2D applies: the body's own scale, or 0 for a body without mass (a static
   * or kinematic body), which Box2D never accelerates by gravity.
   */
  public gravityScale = 1;
  /** Whether the body is exempt from Box2D's cap on rotation per step (`Body.allowFastRotation`). */
  public allowFastRotation = false;
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
 * Geometry accepted by shape casts: any single-shape geometry component, in
 * local space exactly as it would sit on a shape entity. Pass a live entity's
 * component (`entity.get(Circle)!`) or a standalone instance (`new Circle()`).
 * `Chain` is excluded — Box2D cannot sweep a chain.
 */
export type CastGeometry = Box | Capsule | Circle | Polygon | Segment;

/** A single shape-cast hit, resolved to a Vecs shape entity with plain-data
 * geometry — never a Box2D handle. */
export interface ShapeCastHit {
  /** The shape entity that was hit. */
  entity: Entity;
  /** World-space contact point at first touch. */
  point: Vec2;
  /** World-space unit surface normal at the contact point. Zero vector when
   * `fraction` is `0` (cast started overlapping this shape). */
  normal: Vec2;
  /** Fraction along `from` → `to` at first touch, in `[0, 1]`. `0` means the
   * cast geometry already touches or overlaps this shape at `from`. */
  fraction: number;
}

/**
 * Stable, world-scoped facade for synchronous read-only physics queries: ray
 * casts, shape casts, spatial overlaps and the post-step pose-change view. Obtained via {@link physics}.
 * Never mutates the world, never creates or destroys entities, and never
 * wakes bodies.
 */
export interface PhysicsQueries {
  /**
   * Returns the live Box2D body, shape, joint and contact counts. Cheap and read-only: it never
   * allocates Box2D handles that outlive the call. Counts track Box2D, not entities, so a
   * destroyed entity's body leaves them when the `PhysicsReaper` runs during the next step,
   * which makes them suitable for asserting that handles return to baseline after teardown.
   */
  stats(): PhysicsStats;

  /** Returns the settings the Box2D world was built with. The object is shared: do not mutate it. */
  settings(): PhysicsSettings;

  /**
   * Reused read-only entity view published by the most recent pose-out. Contains live Dynamic
   * move events (including unchanged final sleep events), preceded by application pose writes
   * admitted by the existing pose-in systems, including static/disabled bodies. Entries may repeat.
   * Empty before the first pose-out and cleared on disposal. The same array is overwritten by the
   * next pose-out: consume it after physics, do not mutate it, and copy it if retaining a snapshot.
   * No Box2D handles or per-call allocations. Application writes made after pose-in drains appear
   * on the following tick; this is not a synchronous ECS pose-write notification.
   */
  poseChanges(): readonly Entity[];

  /**
   * Returns whether `entity`'s body is awake: `false` for an entity without a live body. It
   * Uses a scalar fast-path read and allocates nothing, so it is cheap enough per body per step.
   */
  isAwake(entity: Entity): boolean;

  /**
   * Reads `entity`'s body motion into `out`: whether it is awake, its velocities, its damping, its
   * center of mass and the gravity scale Box2D applies to it. One composite fast-path call reads
   * the same Box2D getters into reusable wasm scratch, with refreshed memory views and no
   * per-call handle or marshalling allocation. The supplied output remains caller-owned.
   *
   * @param entity The body entity.
   * @param out The object to overwrite.
   * @returns `false`, leaving `out` untouched, when `entity` has no live body.
   */
  bodyMotion(entity: Entity, out: BodyMotion): boolean;

  /** Casts a ray from `from` to `to` and returns the closest hit, or `undefined`
   * if the ray hits nothing (or only hits shapes whose entity has since been
   * destroyed / removed). */
  rayCastClosest(query: { from: Vec2; to: Vec2; filter?: QueryFilter }): RayHit | undefined;

  /** Casts a ray from `from` to `to` and returns every hit along the way. */
  rayCastAll(query: { from: Vec2; to: Vec2; filter?: QueryFilter }): RayHit[];

  /** Sweeps `shape` — placed with its local origin at `from`, rotated by
   * `rotation` radians (default `0`) — until the origin reaches `to`, and
   * returns the closest hit, or `undefined` if the sweep touches nothing.
   * Throws if `shape` is a {@link Polygon} with no vertices or more than 8. */
  shapeCastClosest(query: {
    shape: CastGeometry;
    from: Vec2;
    to: Vec2;
    rotation?: number;
    filter?: QueryFilter;
  }): ShapeCastHit | undefined;

  /** Sweeps `shape` along `from` → `to` like {@link shapeCastClosest} and
   * returns every shape the sweep would touch, each with its own
   * first-contact point, normal, and fraction. */
  shapeCastAll(query: {
    shape: CastGeometry;
    from: Vec2;
    to: Vec2;
    rotation?: number;
    filter?: QueryFilter;
  }): ShapeCastHit[];

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
 * message comes from `getPhysicsEngine`). The returned facade is stable: repeated
 * calls for the same world return the same instance, so it never
 * re-allocates.
 */
export function physics(world: World): PhysicsQueries {
  const engine = getPhysicsEngine(world);
  return (engine.queries ??= new PhysicsQueriesImpl(world, engine));
}

class PhysicsQueriesImpl implements PhysicsQueries {
  private _settings: PhysicsSettings | undefined;

  public constructor(
    private readonly world: World,
    private readonly engine: PhysicsEngine
  ) {}

  public bodyMotion(entity: Entity, out: BodyMotion): boolean {
    const body = entity.get(Body);
    const bodyId = body?._bodyId;
    if (body === undefined || bodyId === undefined) {
      return false;
    }
    // The eight getters in one crossing, read in the same order.
    const fast = this.engine.fast;
    fast.module._b2x_Body_GetMotion(bodyId.index1, rev(bodyId), scr_fastOut);
    fast.sync();
    const m = fast.layout.motion;
    const f32 = fast.f32;
    const at = scr_fastOut;
    out.awake = fast.i32[(at + m.awake) >> 2] !== 0;
    out.vx = f32[(at + m.vx) >> 2]!;
    out.vy = f32[(at + m.vy) >> 2]!;
    out.w = f32[(at + m.w) >> 2]!;
    out.linearDamping = f32[(at + m.linearDamping) >> 2]!;
    out.angularDamping = f32[(at + m.angularDamping) >> 2]!;
    out.localCenterX = f32[(at + m.localCenterX) >> 2]!;
    out.localCenterY = f32[(at + m.localCenterY) >> 2]!;
    // Box2D applies gravity times the scale only to a body with mass (src/solver.c:99).
    out.gravityScale = f32[(at + m.mass) >> 2]! > 0 ? f32[(at + m.gravityScale) >> 2]! : 0;
    out.allowFastRotation = body.allowFastRotation;
    return true;
  }

  public isAwake(entity: Entity): boolean {
    const bodyId = entity.get(Body)?._bodyId;
    return (
      bodyId !== undefined &&
      this.engine.fast.module._b2x_Body_IsAwake(bodyId.index1, rev(bodyId)) !== 0
    );
  }

  public poseChanges(): readonly Entity[] {
    return this.engine.poseChanges;
  }

  public settings(): PhysicsSettings {
    const engine = this.engine;
    return (this._settings ??= Object.freeze({
      gravity: Object.freeze({ x: engine.gravityX, y: engine.gravityY }),
      fixedTimeStep: engine.fixedTimeStep,
      subSteps: engine.subSteps,
      maximumLinearSpeed: engine.maximumLinearSpeed,
    }));
  }

  public stats(): PhysicsStats {
    const { box2d, worldId } = this.engine;
    const counters = box2d.b2World_GetCounters(worldId);
    try {
      return {
        bodyCount: counters.bodyCount,
        shapeCount: counters.shapeCount,
        jointCount: counters.jointCount,
        contactCount: counters.contactCount,
      };
    } finally {
      counters.delete();
    }
  }

  public rayCastClosest(query: { from: Vec2; to: Vec2; filter?: QueryFilter }): RayHit | undefined {
    const { box2d, worldId } = this.engine;

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

      const entity = resolveShapeEntity(this.engine, this.world, result.shapeId);
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
    const { box2d, worldId } = this.engine;

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
        const entity = resolveShapeEntity(this.engine, this.world, result.shapeId);
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

  public shapeCastClosest(query: {
    shape: CastGeometry;
    from: Vec2;
    to: Vec2;
    rotation?: number;
    filter?: QueryFilter;
  }): ShapeCastHit | undefined {
    const { box2d, worldId } = this.engine;

    const proxy = to_b2ShapeProxy(box2d, query.shape, query.from, query.rotation ?? 0);

    const translation = scr_b2Vec2[1];
    translation.Set(query.to.x - query.from.x, query.to.y - query.from.y);

    let closest: ShapeCastHit | undefined;
    box2d.b2World_CastShape(
      worldId,
      proxy,
      translation,
      to_b2QueryFilter(query.filter),
      (result: b2RayCallbackResult) => {
        const entity = resolveShapeEntity(this.engine, this.world, result.shapeId);
        if (entity === undefined) {
          // -1 filters the hit out without tightening the clip fraction.
          return -1;
        }

        if (closest === undefined || result.fraction < closest.fraction) {
          closest = {
            entity,
            point: { x: result.point.x, y: result.point.y },
            normal: { x: result.normal.x, y: result.normal.y },
            fraction: result.fraction,
          };
        }
        // Clip the sweep so only nearer hits are reported from here on.
        return result.fraction;
      }
    );

    return closest;
  }

  public shapeCastAll(query: {
    shape: CastGeometry;
    from: Vec2;
    to: Vec2;
    rotation?: number;
    filter?: QueryFilter;
  }): ShapeCastHit[] {
    const { box2d, worldId } = this.engine;

    const proxy = to_b2ShapeProxy(box2d, query.shape, query.from, query.rotation ?? 0);

    const translation = scr_b2Vec2[1];
    translation.Set(query.to.x - query.from.x, query.to.y - query.from.y);

    const hits: ShapeCastHit[] = [];
    box2d.b2World_CastShape(
      worldId,
      proxy,
      translation,
      to_b2QueryFilter(query.filter),
      (result: b2RayCallbackResult) => {
        const entity = resolveShapeEntity(this.engine, this.world, result.shapeId);
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
    const { box2d, worldId } = this.engine;

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
        const entity = resolveShapeEntity(this.engine, this.world, result.shapeId);
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
    const { box2d, worldId } = this.engine;

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
          const entity = resolveShapeEntity(this.engine, this.world, result.shapeId);
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

/** Fills the scratch `b2ShapeProxy` with `shape`'s geometry transformed to
 * world space: each local point is rotated by `rotation` and translated by
 * `at`. `setPoint` copies by value, so the scratch `b2Vec2` and the returned
 * proxy are free for reuse as soon as the consuming cast returns. Throws for
 * a {@link Polygon} whose vertex count Box2D cannot represent (0, or more
 * than `B2_MAX_POLYGON_VERTICES` = 8). */
function to_b2ShapeProxy(
  box2d: Box2DModule,
  shape: CastGeometry,
  at: Vec2,
  rotation: number
): b2ShapeProxy {
  const proxy = scr_b2ShapeProxy!;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const point = scr_b2Vec2[0];

  const setPoint = (index: number, x: number, y: number): void => {
    point.Set(at.x + cos * x - sin * y, at.y + sin * x + cos * y);
    proxy.setPoint(index, point);
  };

  if (shape instanceof Box) {
    setPoint(0, -shape.hx, -shape.hy);
    setPoint(1, shape.hx, -shape.hy);
    setPoint(2, shape.hx, shape.hy);
    setPoint(3, -shape.hx, shape.hy);
    proxy.count = 4;
    proxy.radius = 0;
  } else if (shape instanceof Circle) {
    setPoint(0, 0, 0);
    proxy.count = 1;
    proxy.radius = shape.radius;
  } else if (shape instanceof Capsule) {
    setPoint(0, shape.x1, shape.y1);
    setPoint(1, shape.x2, shape.y2);
    proxy.count = 2;
    proxy.radius = shape.radius;
  } else if (shape instanceof Segment) {
    setPoint(0, shape.x1, shape.y1);
    setPoint(1, shape.x2, shape.y2);
    proxy.count = 2;
    proxy.radius = 0;
  } else {
    const count = shape.vertices.length;
    if (count < 1 || count > MAX_POLYGON_VERTICES) {
      throw new Error(
        `shape cast Polygon must have 1 to ${MAX_POLYGON_VERTICES} vertices, got ${count}`
      );
    }
    for (let i = 0; i < count; i++) {
      setPoint(i, shape.vertices[i].x, shape.vertices[i].y);
    }
    proxy.count = count;
    proxy.radius = shape.radius;
  }

  return proxy;
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
 * `PhysicsEvents` shape→entity resolution (`src/events/publish.ts`):
 * `entityByShapeIndex.get(shapeId.index1)` → `EID` → live `Entity`. Returns
 * `undefined` (drop silently) if the slot is empty or the entity has been
 * destroyed — the same rule as `PhysicsEvents`. */
function resolveShapeEntity(
  engine: PhysicsEngine,
  world: World,
  shapeId: b2ShapeId
): Entity | undefined {
  const eid = engine.entityByShapeIndex.get(shapeId.index1);
  if (eid === undefined) {
    return undefined;
  }

  const entity = world.getEntity(eid);
  if (entity === undefined || entity.destroyed) {
    return undefined;
  }

  return entity;
}
