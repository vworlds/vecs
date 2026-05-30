// Internal engine state and its world-scoped attachment.
//
// `PhysicsState` is the single private container the whole engine reads and
// writes. It rides on a `Singleton` component (`PhysicsRoot`) so it is reachable
// in O(1) via `world.get(PhysicsRoot)` — no per-step query, no `WeakMap` — and
// is GC'd with the world. `PhysicsRoot` is never exported: user code cannot
// reach `PhysicsState`. See PLAN.md → _Internal-state attachment_.
//
// `PhysicsState` holds resolved configuration, the entity↔handle maps, a step
// counter, and (since VP-5) body storage plus the solver sets. The remaining
// solver subsystems (shapes, contacts, broad-phase, islands, sensors) and event
// scratch land in later tickets, alongside the systems that populate them.

import { Singleton, type World } from "@vworlds/vecs";

import type { BodyHandle, Handle, ShapeHandle } from "../util/handle.js";
import { BodyStorage } from "./body.js";
import { BroadPhase } from "./broad_phase.js";
import { ContactStorage, type ContactSim } from "./contact.js";
import { IslandStorage } from "./island.js";
import { SensorStorage } from "./sensor.js";
import { ShapeStorage } from "./shape.js";
import { createBaseSolverSets, type SolverSet } from "./solver_set.js";

// ─── Engine-internal contact touch event (VP-21a) ─────────────────────────────
//
// Raw begin/end touch events recorded by the collide pass and by destroyContact.
// NOT a public type — stays inside engine/. VP-21b (`PhysicsEvents`) resolves
// handles → entities and fans these arrays out to `ContactEvents` components.
//
// Both handles are recorded at event-emit time (engine-internal indices).
// `shapeA`/`shapeB` may refer to a shape that was destroyed mid-step (e.g.
// a shape removed in the same step it stopped touching). VP-21b resolves via
// `IdPool.isValid` and skips stale handles — the surviving other shape still
// receives its end event. See PLAN.md → _Entity-reference safety_.

/** Raw contact touch event held in {@link PhysicsState}'s per-step arrays.
 * Engine-internal only; not exported from the package.
 * Both fields are shape (index, generation) pairs built from `shapeIdA/shapeIdB`
 * on the contact's canonical ordering at event-emit time.
 * Uses the base {@link Handle} type — the `ShapeHandle` brand is an API-boundary
 * guard and is not needed inside the engine. */
export interface ContactTouchEvent {
  shapeA: Handle;
  shapeB: Handle;
}

/** Raw sensor touch event held in {@link PhysicsState}'s per-step arrays.
 * Engine-internal only; not exported from the package.
 * Mirrors box2d's `b2SensorBeginTouchEvent` / `b2SensorEndTouchEvent` (types.h).
 * `sensorShape` is the sensor shape handle; `visitorShape` is the overlapping
 * (non-sensor) shape handle. Both use the base {@link Handle} type — the
 * `ShapeHandle` brand is an API-boundary guard not needed inside the engine.
 * VP-21b `PhysicsEvents` resolves handles → entities and fans to `SensorEvents`
 * components; stale handles (shape freed mid-step) are skipped via
 * `ShapeStorage.idPool.isValid`. */
export interface SensorTouchEvent {
  sensorShape: Handle;
  visitorShape: Handle;
}

/** Fully-resolved engine configuration: every `PhysicsOptions` field with its
 * default applied. Built by `installPhysics`; the source of truth for tunables
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

/** Private engine state for one world. Allocated by `installPhysics` and reached
 * inside the package via {@link getPhysics}. */
export class PhysicsState {
  // Resolved configuration (flattened from PhysicsOptions).
  public gravityX: number;
  public gravityY: number;
  public fixedTimeStep: number;
  public subSteps: number;
  public debug: boolean;
  public restitutionThreshold: number;
  public hitEventThreshold: number;
  public contactHertz: number;
  public contactDampingRatio: number;
  public contactSpeed: number;
  public maximumLinearSpeed: number;
  public enableSleep: boolean;
  public enableContinuous: boolean;

  // Body records (sparse, handle-indexed) and the index allocator.
  public readonly bodies = new BodyStorage();

  // Shape records (sparse, handle-indexed) and the index allocator.
  // VP-8: shape storage + geometry union. Proxy linkage (VP-10), body
  // linkage + material/filter/sensor (VP-11), and mass (VP-12) slot in later.
  public readonly shapes = new ShapeStorage();

  // Broad-phase: three DynamicTrees (static/kinematic/dynamic), move buffer,
  // and pair set. Added VP-10; VP-11 inserts proxies; M3 consumes pairs.
  public readonly broadPhase = new BroadPhase();

  // Contact records (sparse, handle-indexed) and the index allocator. Added
  // VP-15a; the contact lifecycle (create/destroy) and VP-15b (narrow-phase
  // update) populate it.
  public readonly contacts = new ContactStorage();

  // The single overflow constraint-graph color's touching-contact sims (box2d
  // `constraintGraph.colors[OVERFLOW].contactSims`). v1 has no graph coloring,
  // so this is the only color. VP-16/VP-17 populate and read it; VP-15a's
  // destroyContact swap-removes from it when a touching contact is destroyed.
  public readonly graphContactSims: ContactSim[] = [];

  // Island storage (sparse, id-indexed) + id allocator. Added VP-16; islands
  // are built (link/merge/unlink + body hooks) but NOT consumed by the solver
  // in M3, and split is deferred to M5. Mirrors box2d's `world->islands`.
  public readonly islands = new IslandStorage();

  // Solver sets: static, disabled, awake (sleeping sets added with sleep).
  public readonly solverSets: SolverSet[] = createBaseSolverSets();

  // Maps between Vecs entities and internal engine handles.
  public readonly bodyByEntity = new Map<number /* eid */, BodyHandle>();
  public readonly shapeByEntity = new Map<number /* eid */, ShapeHandle>();
  // Chain entities expand to N segment shapes; this map holds all N handles.
  // Non-chain geometry entities use shapeByEntity (1:1). Chain entities use
  // chainShapeByEntity (1:N) only, to keep the common path branch-free.
  public readonly chainShapeByEntity = new Map<number /* eid */, ShapeHandle[]>();

  // Body handle indices that the solver finalized this step (Box2D's
  // `bodyMoveEvents`). Rebuilt each step; `PhysicsPoseSyncOut` consumes it to
  // write simulated pose back. One entry per awake body in finalize order.
  public readonly bodyMoveEvents: number[] = [];

  // ── VP-21a: raw contact touch events (engine-internal) ────────────────────
  //
  // Mirrors box2d's `world->contactBeginEvents` / `world->contactEndEvents`
  // (physics_world.c), which are cleared at the top of `b2World_Step` and
  // populated by the collide state-change loop (`b2Collide`) and by
  // `b2DestroyContact` (end-touch only). Cleared each step in `engineStep`
  // (alongside `bodyMoveEvents.length = 0`) so the arrays accumulate only the
  // current step's events and the prior step's entries survive until
  // `PhysicsEvents` (VP-21b) publishes them in the post phase.
  //
  // Consumed by: VP-21b `PhysicsEvents` (fans out to `ContactEvents` ECS
  // components). Must NOT be used by sensors (VP-21c) or hit events (VP-22).

  /** Raw contact begin-touch events. Cleared at the start of each step.
   * Mirrors box2d's `world->contactBeginEvents` (physics_world.c). */
  public readonly contactBeginEvents: ContactTouchEvent[] = [];

  /** Raw contact end-touch events. Cleared at the start of each step.
   * Mirrors box2d's `world->contactEndEvents` (physics_world.c). */
  public readonly contactEndEvents: ContactTouchEvent[] = [];

  // ── VP-21c: sensor overlap records + raw sensor touch events ─────────────
  //
  // In box2d v3, sensors do NOT generate contacts — they run a separate overlap
  // pass (`b2OverlapSensors`, sensor.c) after the solver. This pass is ported in
  // `engine/sensor.ts` and wired into `engineStep` after `finalizeBodies`.
  //
  // `sensors` holds the per-sensor double-buffered visitor lists (one record per
  // live sensor shape, indexed via `InternalShape.sensorIndex`). Created by
  // `shape_lifecycle.ts` on sensor-shape enter; destroyed on exit.
  //
  // `sensorBeginEvents` / `sensorEndEvents` are cleared at the top of
  // `engineStep` (step-only generated, consistent with contactBeginEvents).
  // VP-21b consolidates the clear at end-of-publish (ARCHITECT RESOLUTION in
  // PROGRESS.md); until then, cleared in engineStep like contactBeginEvents.
  //
  // Consumed by: VP-21b `PhysicsEvents` (fans out to `SensorEvents` ECS
  // components).

  /** Per-sensor double-buffered visitor lists. Mirrors box2d's `world->sensors`
   * array (sensor.h / sensor.c). Indexed via `InternalShape.sensorIndex`.
   * `SensorStorage` owns the dense array and provides create/destroy helpers. */
  public readonly sensors = new SensorStorage();

  /** Raw sensor begin-touch events for the current step. Cleared at step start.
   * Mirrors box2d's `world->sensorBeginEvents` (physics_world.c). Each entry
   * records the sensor shape handle and the visitor (overlapping) shape handle.
   * Consumed by VP-21b `PhysicsEvents`. */
  public readonly sensorBeginEvents: SensorTouchEvent[] = [];

  /** Raw sensor end-touch events for the current step. Cleared at step start.
   * Mirrors box2d's `world->sensorEndEvents` (physics_world.c). Populated by
   * the two-finger merge in `overlapSensors` and by `destroySensor` (when a
   * sensor shape is removed while still overlapping). Consumed by VP-21b. */
  public readonly sensorEndEvents: SensorTouchEvent[] = [];

  // ── VP-19: impulse accumulation (M4 scoping decision in PROGRESS.md) ────────
  //
  // Box2D applies impulses immediately to body velocity in `b2Body_ApplyLinearImpulse`
  // (body.c:1020: state->linearVelocity = b2MulAdd(state->linearVelocity, invMass, impulse)).
  // We cannot do this in `physics-pre` because `PhysicsMassRecompute` (the last
  // pre-step system) may update invMass for the same frame. So we defer: the
  // accumulate system sums impulses here, and `engineStep` applies them at the
  // very top (after mass recompute has run), using fresh invMass.
  //
  // Keyed by body handle index (InternalBody.localIndex is unstable across
  // swap-pops; the handle index, i.e. IdPool slot, is stable for the body's
  // lifetime and is how all other maps in PhysicsState are keyed).
  public readonly pendingImpulses = new Map<
    number /* body handle index */,
    { x: number; y: number; angular: number; wake: boolean }
  >();

  // EIDs of entities that had Impulse or AngularImpulse set this step.
  // PhysicsImpulseZero walks this set in physics-post to silently zero them.
  // Cleared by PhysicsImpulseZero at the end of each post phase.
  public readonly impulseEntitiesThisStep = new Set<number /* eid */>();

  // Monotonic step counter (determinism + event tagging).
  public stepIndex = 0;

  public constructor(options: ResolvedPhysicsOptions) {
    this.gravityX = options.gravityX;
    this.gravityY = options.gravityY;
    this.fixedTimeStep = options.fixedTimeStep;
    this.subSteps = options.subSteps;
    this.debug = options.debug;
    this.restitutionThreshold = options.restitutionThreshold;
    this.hitEventThreshold = options.hitEventThreshold;
    this.contactHertz = options.contactHertz;
    this.contactDampingRatio = options.contactDampingRatio;
    this.contactSpeed = options.contactSpeed;
    this.maximumLinearSpeed = options.maximumLinearSpeed;
    this.enableSleep = options.enableSleep;
    this.enableContinuous = options.enableContinuous;
  }
}

// Internal singleton state holder. Never exported from the package; the only way
// to reach `PhysicsState` from inside the package is `getPhysics(world)`.
class PhysicsRoot {
  public state!: PhysicsState;
}

/** Internal marker tagging every physics **system entity** (systems are entities
 * in Vecs). `PhysicsPoseSyncIn.ignoreSource([PhysicsSystemTag])` uses it as a
 * silence domain so the engine's own pose write-back is never mistaken for a
 * user teleport. Never exported from the package and only ever lives on system
 * entities, so it adds zero per-entity archetype churn. See PLAN.md → _Pose And
 * Velocity Synchronization_. */
export class PhysicsSystemTag {}

/** Register the package's two internal, non-exported components in their
 * documented order (`PhysicsRoot` then `PhysicsSystemTag`, registration step 9).
 * Keeping the order stable keeps Vecs' registration-order-assigned type ids
 * deterministic across worlds. The singleton marking and state attachment for
 * `PhysicsRoot` happen later in {@link attachPhysics} (step 13). */
export function registerInternalComponents(world: World): void {
  world.component(PhysicsRoot);
  world.component(PhysicsSystemTag);
}

/** Bind `state` to `world` via the `PhysicsRoot` singleton. Marking the
 * component singleton auto-attaches the instance to its own meta entity (the
 * `Singleton` module does `target.add(target)`), so it is reachable through
 * `world.get(PhysicsRoot)` with no extra entity and no query. */
export function attachPhysics(world: World, state: PhysicsState): void {
  world.component(PhysicsRoot).add(Singleton);
  world.set(PhysicsRoot, { state });
}

/** O(1) read of the engine state for `world`. Throws if physics was never
 * installed. The single legal way to reach engine internals inside the package. */
export function getPhysics(world: World): PhysicsState {
  const root = world.get(PhysicsRoot) as PhysicsRoot | undefined;
  if (!root) {
    throw new Error("installPhysics(world, ...) must be called before world.start()");
  }
  return root.state;
}

/** Whether `installPhysics` has already run on `world`. Side-effect free: it
 * does not register `PhysicsRoot` if it is absent. */
export function hasPhysics(world: World): boolean {
  if (!world._classRegistry.has(PhysicsRoot)) {
    return false;
  }
  const root = world.get(PhysicsRoot) as PhysicsRoot | undefined;
  return root?.state !== undefined;
}
