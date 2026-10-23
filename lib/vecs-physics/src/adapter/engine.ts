import { ArrayMap, type EID, type Entity, type World } from "@vworlds/vecs";
import { type FastPath, type MoveExporter } from "@vworlds/box2d3-wasm/fastpath";

import { type WarnSink, WarnDedupe } from "../util/warn.js";
import { type PhysicsQueries } from "./queries.js";
import { type Box2DModule } from "./runtime.js";

export type EntityId = EID;
export type b2WorldId = ReturnType<Box2DModule["b2CreateWorld"]>;
export type b2BodyId = ReturnType<Box2DModule["b2CreateBody"]>;
export type b2ShapeId = ReturnType<Box2DModule["b2CreateCircleShape"]>;
export type b2ChainId = ReturnType<Box2DModule["b2CreateChain"]>;
export type b2JointId = ReturnType<Box2DModule["b2CreateRevoluteJoint"]>;
/** The shared base of every joint def (`localFrameA/B`, `bodyIdA/B`,
 * `collideConnected`). All concrete joint defs expose it as `.base`. */
export type b2JointDefBase = ReturnType<Box2DModule["b2DefaultRevoluteJointDef"]>["base"];
export type b2Vec2 = ReturnType<Box2DModule["b2Body_GetPosition"]>;
export type b2QueryFilter = Parameters<Box2DModule["b2World_OverlapAABB"]>[3];
export type b2AABB = Parameters<Box2DModule["b2World_OverlapAABB"]>[2];
export type b2ShapeProxy = ReturnType<Box2DModule["b2MakeProxy"]>;
/** The transient result object passed to a `b2World_CastRay` collector callback
 * (the binding types the callback parameter as `any`). */
export type b2RayCallbackResult = InstanceType<Box2DModule["b2RayCallbackResult"]>;

/** Fully-resolved engine configuration: every `PhysicsOptions` field with its
 * default applied. Built by `PhysicsModule`; the source of truth for tunables
 * the engine reads at runtime. */
export interface ResolvedPhysicsOptions {
  gravityX: number;
  gravityY: number;
  fixedTimeStep: number;
  subSteps: number;
  debug: boolean;
  restitutionThreshold: number;
  hitEventThreshold: number;
  contactHertz: number;
  contactDampingRatio: number;
  contactSpeed: number;
  maximumLinearSpeed: number;
  enableSleep: boolean;
  enableContinuous: boolean;
}

/** Physics phase spine, including the internal teardown boundary before stepping. */
export interface PhysicsPhases {
  preStep: Entity;
  cleanup: Entity;
  step: Entity;
  postStep: Entity;
}

/** Internal marker tagging every physics **system entity** (systems are entities
 * in Vecs). `PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])` uses it as a
 * silence domain so the engine's own pose write-back is never mistaken for a
 * user teleport. Never exported from the package public API and only ever lives
 * on system entities, so it adds zero per-entity archetype churn. */
export class PhysicsSystemTag {}

export function getPhysicsEngine(world: World): PhysicsEngine {
  const engine = world.get(PhysicsEngine) as PhysicsEngine | undefined;
  if (!engine) {
    throw new Error("world.module(PhysicsModule) must be called before reading physics engine");
  }
  return engine;
}

export function hasPhysicsEngine(world: World): boolean {
  if (!world._classRegistry.has(PhysicsEngine)) {
    return false;
  }
  return world.get(PhysicsEngine) !== undefined;
}

export class PhysicsEngine {
  /** Read only by teardown callbacks, never by the step/pose-out hot path. */
  public disposed = false;
  public worldId!: b2WorldId;
  /** `worldId` packed for the b2x_ fast path: index1 | generation << 16. */
  public world = 0;
  public readonly box2d!: Box2DModule;
  /** The b2x_ fast path: raw exports, layouts and whole-memory views. */
  public readonly fast!: FastPath;
  /** Reusable buffer that `PhysicsPoseSyncOut` exports the move events into. */
  public moveExporter!: MoveExporter;
  /** Reused post-step eid view; only the count-prefix is valid, and growth replaces the buffer. */
  public readonly poseChanges = { eids: new Int32Array(64), count: 0 };
  /** Application poses admitted by the existing pose-in systems, awaiting the next pose-out. */
  public readonly pendingPoseChanges: Entity[] = [];
  public readonly phases!: PhysicsPhases;

  // Resolved configuration (flattened from PhysicsOptions).
  public readonly gravityX!: number;
  public readonly gravityY!: number;
  public readonly fixedTimeStep!: number;
  public readonly subSteps!: number;
  public readonly debug!: boolean;
  public readonly warn!: WarnDedupe;
  public readonly restitutionThreshold!: number;
  public readonly hitEventThreshold!: number;
  public readonly contactHertz!: number;
  public readonly contactDampingRatio!: number;
  public readonly contactSpeed!: number;
  public readonly maximumLinearSpeed!: number;
  public readonly enableSleep!: boolean;
  public readonly enableContinuous!: boolean;

  // Forward handles live on components: Body._bodyId, SingleShape._shapeId, and Chain._chainId.
  // Index-keyed reverse ArrayMaps resolve Box2D event IDs back to entities.
  // Emscripten returns fresh wrapper objects for b2*Id fields on events, so
  // Map<b2*Id, EntityId> misses by object identity. Public index1 slot 0 is
  // unused/null-aligned by Box2D, so ArrayMap slot 0 stays empty too. We do not
  // check id generations in hot lookups: correctness comes from clearing each
  // slot on Box2D destruction before Box2D can reuse that index1.
  public readonly entityByBodyIndex = new ArrayMap<EID>();
  /** Entity objects behind entityByBodyIndex for direct pose-out lookup; set and cleared with it. */
  public readonly bodyEntities: (Entity | undefined)[] = [];
  public readonly entityByShapeIndex = new ArrayMap<EID>();

  // Bodies whose mass needs recomputing this step (populated by shape lifecycle).
  public readonly dirtyMassBodies = new Set<EID>();

  // Deferred Box2D teardown. Immediate lifecycle query exits enqueue handles
  // at the structural-change flush, including changes from late preStep systems.
  // PhysicsReaper drains these in the internal cleanup phase before the step and performs
  // the actual b2Destroy* -- shapes and chains first, then bodies (children
  // before parents, so a body cascade never double-frees an already-reaped
  // shape). Because nothing is destroyed mid-pass, no shape/chain slot is ever
  // freed-then-recycled within a pass, so the "clear the slot before Box2D reuses
  // index1" invariant above holds structurally -- and the stale-id / cascade
  // guards the exits used to carry are unnecessary.
  public readonly pendingShapeDestroys: b2ShapeId[] = [];
  public readonly pendingChainDestroys: b2ChainId[] = [];
  public readonly pendingBodyDestroys: b2BodyId[] = [];

  // Deferred joint teardown. A joint exit enqueues its handle here; the reaper
  // drains it BEFORE pendingBodyDestroys and guards each with b2Joint_IsValid,
  // because destroying a connected body already cascade-destroys its joints, so a
  // joint queued from the cascaded entity may no longer exist by reap time.
  public readonly pendingJointDestroys: b2JointId[] = [];

  // Per-step event tracking sets for PhysicsEvents (M7-8 should-fix: moved from
  // closure-local to engine so they survive future pause/resume cycles).
  // Populated by PhysicsEvents at the end of each step; persist into the next
  // step to detect which entities stopped receiving events.
  public readonly prevTouchedContact = new Set<EID>();
  public readonly prevTouchedSensor = new Set<EID>();
  public readonly prevTouchedHit = new Set<EID>();

  // EIDs of entities that had Impulse or AngularImpulse set this step.
  // PhysicsImpulseZero walks this set in physics-post to silently zero them.
  // Cleared by PhysicsImpulseZero at the end of each post phase.
  public readonly impulseEntitiesThisStep = new Set<EID>();

  // Pending impulses remain wrapper-keyed by invariant: hooks resolve bodyId
  // off the `Body` component via resolveBodyId, then get/set with that same
  // stored wrapper, and the pre-step drain iterates stored keys instead of
  // looking up event wrappers.
  public readonly pendingLinearImpulse = new Map<
    b2BodyId,
    { x: number; y: number; wake: boolean }
  >();
  public readonly pendingAngularImpulse = new Map<b2BodyId, { value: number; wake: boolean }>();

  // Stable PhysicsQueries facade, constructed lazily by `physics(world)` and
  // cached here so repeated calls don't re-allocate. Type-only import above
  // avoids a runtime import cycle (queries.ts imports engine.ts at runtime).
  public queries?: PhysicsQueries;

  public constructor();
  public constructor(
    box2d: Box2DModule,
    options: ResolvedPhysicsOptions,
    phases: PhysicsPhases,
    fast: FastPath,
    warnSink?: WarnSink
  );
  public constructor(
    box2d?: Box2DModule,
    options?: ResolvedPhysicsOptions,
    phases?: PhysicsPhases,
    fast?: FastPath,
    warnSink?: WarnSink
  ) {
    if (
      box2d === undefined ||
      options === undefined ||
      phases === undefined ||
      fast === undefined
    ) {
      return;
    }

    this.box2d = box2d;
    this.fast = fast;
    this.moveExporter = fast.createMoveExporter(64);
    this.phases = phases;
    this.gravityX = options.gravityX;
    this.gravityY = options.gravityY;
    this.fixedTimeStep = options.fixedTimeStep;
    this.subSteps = options.subSteps;
    this.debug = options.debug;
    this.warn = new WarnDedupe(warnSink);
    this.restitutionThreshold = options.restitutionThreshold;
    this.hitEventThreshold = options.hitEventThreshold;
    this.contactHertz = options.contactHertz;
    this.contactDampingRatio = options.contactDampingRatio;
    this.contactSpeed = options.contactSpeed;
    this.maximumLinearSpeed = options.maximumLinearSpeed;
    this.enableSleep = options.enableSleep;
    this.enableContinuous = options.enableContinuous;
  }

  /** Release per-world WASM ownership once; queued child handles die with the world.
   * Live ids are plain fields: install late-use errors only at teardown. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.poseChanges.count = 0;
    this.pendingPoseChanges.length = 0;
    if (this.worldId !== undefined) {
      this.box2d.b2DestroyWorld(this.worldId);
    }
    this.moveExporter.dispose();
    const deadWorld = (): never => {
      throw new Error("Physics world has been disposed");
    };
    Object.defineProperties(this, {
      worldId: { get: deadWorld, set: deadWorld },
      world: { get: deadWorld, set: deadWorld },
    });
  }
}
