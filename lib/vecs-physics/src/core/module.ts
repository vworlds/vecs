import {
  insertPhaseAfter,
  Module,
  ON_UPDATE,
  Phase,
  Singleton,
  type Entity,
  type World,
} from "@vworlds/vecs";

import {
  hasPhysicsEngine,
  PhysicsEngine,
  PhysicsSystemTag,
  type ResolvedPhysicsOptions,
} from "../adapter/engine.js";
import { withAllocated } from "../adapter/disposal.js";
import { getBox2D } from "../adapter/runtime.js";

/** Options for {@link import("../module.js").PhysicsModule}. Every field is optional;
 * omitted fields fall back to Box2D-aligned defaults. */
export type PhysicsOptions = {
  gravity?: { x: number; y: number }; // default { x: 0, y: -10 }
  fixedTimeStep?: number; // seconds, default 1/60
  subSteps?: number; // default 4
  debug?: boolean; // default false
  /** Override the warning sink used by `PhysicsDebugValidation` when
   * `debug: true`. Accepts any `(message: string) => void` callback.
   * Primarily for tests; defaults to `console.warn`. */
  debugSink?: (message: string) => void;

  // Optional phase placement. Either pass an entity or a name (created if missing).
  preStepPhase?: Entity | string;
  stepPhase?: Entity | string;
  postStepPhase?: Entity | string;

  // Optional thresholds and tunables, all with Box2D-aligned defaults.
  restitutionThreshold?: number; // m/s, default 1.0
  hitEventThreshold?: number; // m/s, default 1.0
  contactHertz?: number; // default 30
  contactDampingRatio?: number; // default 10
  contactSpeed?: number; // m/s, default 3.0
  maximumLinearSpeed?: number; // m/s, default 400
  enableSleep?: boolean; // default true
  enableContinuous?: boolean; // default true
};

const DEFAULT_PRE_STEP_PHASE = "physics-pre";
const DEFAULT_STEP_PHASE = "physics-step";
const DEFAULT_POST_STEP_PHASE = "physics-post";

export class PhysicsCoreModule extends Module<PhysicsOptions | undefined> {
  public init(options: PhysicsOptions | undefined): void {
    const world = this.world;
    const opts = options ?? {};
    if (hasPhysicsEngine(world)) {
      throw new Error("PhysicsModule has already been registered on this world");
    }

    world.component(PhysicsEngine);
    world.component(PhysicsSystemTag);

    const phases = {
      preStep: resolvePhase(world, opts.preStepPhase, DEFAULT_PRE_STEP_PHASE),
      step: resolvePhase(world, opts.stepPhase, DEFAULT_STEP_PHASE),
      postStep: resolvePhase(world, opts.postStepPhase, DEFAULT_POST_STEP_PHASE),
    };
    const updatePhase = world.entity(ON_UPDATE);
    insertPhaseAfter(phases.preStep, updatePhase);
    insertPhaseAfter(phases.step, phases.preStep);
    insertPhaseAfter(phases.postStep, phases.step);

    const box2d = getBox2D();
    const resolved = resolveOptions(opts);
    const engine = new PhysicsEngine(box2d, resolved, phases, opts.debugSink);
    engine.worldId = createWorldId(engine, resolved);
    world.component(PhysicsEngine).add(Singleton);
    world.component(PhysicsEngine).attach(PhysicsEngine, engine);
  }
}

function createWorldId(
  engine: PhysicsEngine,
  options: ResolvedPhysicsOptions
): PhysicsEngine["worldId"] {
  const box2d = engine.box2d;
  return withAllocated(box2d.b2DefaultWorldDef, (def) => {
    def.gravity.x = options.gravityX;
    def.gravity.y = options.gravityY;
    def.restitutionThreshold = options.restitutionThreshold;
    def.hitEventThreshold = options.hitEventThreshold;
    def.contactHertz = options.contactHertz;
    def.contactDampingRatio = options.contactDampingRatio;
    def.maximumLinearSpeed = options.maximumLinearSpeed;
    def.enableSleep = options.enableSleep;
    def.enableContinuous = options.enableContinuous;
    const worldId = box2d.b2CreateWorld(def);
    box2d.b2World_SetContactTuning(
      worldId,
      options.contactHertz,
      options.contactDampingRatio,
      options.contactSpeed
    );
    return worldId;
  });
}

/** Resolve a phase placement option to a concrete phase entity. */
function resolvePhase(
  world: World,
  given: Entity | string | undefined,
  defaultName: string
): Entity {
  const phase =
    typeof given === "string" || given === undefined ? world.entity(given ?? defaultName) : given;
  phase.add(Phase);
  return phase;
}

/** Apply Box2D-aligned defaults to `opts`. */
function resolveOptions(opts: PhysicsOptions): ResolvedPhysicsOptions {
  return {
    gravityX: opts.gravity?.x ?? 0,
    gravityY: opts.gravity?.y ?? -10,
    fixedTimeStep: opts.fixedTimeStep ?? 1 / 60,
    subSteps: opts.subSteps ?? 4,
    debug: opts.debug ?? false,
    restitutionThreshold: opts.restitutionThreshold ?? 1.0,
    // box2d b2DefaultWorldDef: def.hitEventThreshold = 1.0f * lengthUnits (types.c:16).
    hitEventThreshold: opts.hitEventThreshold ?? 1.0,
    contactHertz: opts.contactHertz ?? 30,
    contactDampingRatio: opts.contactDampingRatio ?? 10,
    // box2d b2DefaultWorldDef: def.contactSpeed = 3.0f * lengthUnits (types.c:18).
    contactSpeed: opts.contactSpeed ?? 3.0,
    maximumLinearSpeed: opts.maximumLinearSpeed ?? 400,
    enableSleep: opts.enableSleep ?? true,
    enableContinuous: opts.enableContinuous ?? true,
  };
}
