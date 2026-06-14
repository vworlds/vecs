import { ArrayMap, Singleton, type EID, type World } from "@vworlds/vecs";

import { type WarnSink, WarnDedupe } from "../util/warn.js";
import { type PhysicsQueries } from "./queries.js";
import { type Box2DModule } from "./runtime.js";

export type EntityId = EID;
export type b2WorldId = ReturnType<Box2DModule["b2CreateWorld"]>;
export type b2BodyId = ReturnType<Box2DModule["b2CreateBody"]>;
export type b2ShapeId = ReturnType<Box2DModule["b2CreateCircleShape"]>;
export type b2ChainId = ReturnType<Box2DModule["b2CreateChain"]>;
export type b2Vec2 = ReturnType<Box2DModule["b2Body_GetPosition"]>;
export type b2QueryFilter = Parameters<Box2DModule["b2World_OverlapAABB"]>[2];
export type b2AABB = Parameters<Box2DModule["b2World_OverlapAABB"]>[1];
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

/** Internal marker tagging every physics **system entity** (systems are entities
 * in Vecs). `PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])` uses it as a
 * silence domain so the engine's own pose write-back is never mistaken for a
 * user teleport. Never exported from the package public API and only ever lives
 * on system entities, so it adds zero per-entity archetype churn. */
export class PhysicsSystemTag {}

export function registerInternalComponents(world: World): void {
  world.component(PhysicsRoot);
  world.component(PhysicsSystemTag);
}

export function attachPhysics(world: World, state: PhysicsState): void {
  world.component(PhysicsRoot).add(Singleton);
  world.set(PhysicsRoot, { state });
}

export function getPhysics(world: World): PhysicsState {
  const root = world.get(PhysicsRoot) as PhysicsRoot | undefined;
  if (!root) {
    throw new Error("world.module(PhysicsModule) must be called before reading physics state");
  }
  return root.state;
}

export function hasPhysics(world: World): boolean {
  if (!world._classRegistry.has(PhysicsRoot)) {
    return false;
  }
  const root = world.get(PhysicsRoot) as PhysicsRoot | undefined;
  return root?.state !== undefined;
}

export class PhysicsState {
  public worldId!: b2WorldId;
  public readonly box2d: Box2DModule;

  // Resolved configuration (flattened from PhysicsOptions).
  public readonly gravityX: number;
  public readonly gravityY: number;
  public readonly fixedTimeStep: number;
  public readonly subSteps: number;
  public readonly debug: boolean;
  public readonly warn: WarnDedupe;
  public readonly restitutionThreshold: number;
  public readonly hitEventThreshold: number;
  public readonly contactHertz: number;
  public readonly contactDampingRatio: number;
  public readonly contactSpeed: number;
  public readonly maximumLinearSpeed: number;
  public readonly enableSleep: boolean;
  public readonly enableContinuous: boolean;

  // Forward handles live on components: Body._bodyId and Shape._shapeId.
  // Index-keyed reverse ArrayMaps resolve Box2D event IDs back to entities.
  // Emscripten returns fresh wrapper objects for b2*Id fields on events, so
  // Map<b2*Id, EntityId> misses by object identity. Public index1 slot 0 is
  // unused/null-aligned by Box2D, so ArrayMap slot 0 stays empty too. We do not
  // check id generations in hot lookups: correctness comes from clearing each
  // slot on Box2D destruction before Box2D can reuse that index1.
  public readonly entityByBodyIndex = new ArrayMap<EID>();
  public readonly entityByShapeIndex = new ArrayMap<EID>();

  // Bodies whose mass needs recomputing this step (populated by shape lifecycle).
  public readonly dirtyMassBodies = new Set<EID>();

  // Per-step event tracking sets for PhysicsEvents (M7-8 should-fix: moved from
  // closure-local to state so they survive future pause/resume cycles).
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

  // World-lifetime scratch vector reused by hot pose/velocity setters.
  // It is intentionally not wrapped in withAllocated: teardown does not exist yet.
  public readonly scratchVec2: b2Vec2;

  // Stable PhysicsQueries facade, constructed lazily by `physics(world)` and
  // cached here so repeated calls don't re-allocate. Type-only import above
  // avoids a runtime import cycle (queries.ts imports state.ts at runtime).
  public queries?: PhysicsQueries;

  public constructor(box2d: Box2DModule, options: ResolvedPhysicsOptions, warnSink?: WarnSink) {
    this.box2d = box2d;
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
    this.scratchVec2 = new box2d.b2Vec2();
  }
}

// Internal singleton state holder. Never exported from the package public API.
class PhysicsRoot {
  public state!: PhysicsState;
}
