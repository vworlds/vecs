// Internal engine state and its world-scoped attachment.
//
// `PhysicsState` is the single private container the whole engine reads and
// writes. It rides on a `Singleton` component (`PhysicsRoot`) so it is reachable
// in O(1) via `world.get(PhysicsRoot)` — no per-step query, no `WeakMap` — and
// is GC'd with the world. `PhysicsRoot` is never exported: user code cannot
// reach `PhysicsState`. See PLAN.md → _Internal-state attachment_.
//
// VP-4 keeps `PhysicsState` skeletal: resolved configuration, the entity↔handle
// maps, and a step counter. The solver storage subsystems (bodies, shapes,
// contacts, broad-phase, islands, sensors) and event scratch land in later
// tickets, alongside the systems that populate them.

import { Singleton, type World } from "@vworlds/vecs";

import type { BodyHandle, ShapeHandle } from "../util/handle.js";

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
  public maximumLinearSpeed: number;
  public enableSleep: boolean;
  public enableContinuous: boolean;

  // Maps between Vecs entities and internal engine handles.
  public readonly bodyByEntity = new Map<number /* eid */, BodyHandle>();
  public readonly shapeByEntity = new Map<number /* eid */, ShapeHandle>();

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
