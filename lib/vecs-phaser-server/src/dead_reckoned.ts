import { DontSnapshot, Module, POST_UPDATE, With, type Entity } from "@vworlds/vecs";
import {
  defaultMotionParams,
  Motion,
  MotionClock,
  MotionParams,
  MotionPose,
  MotionState,
  motionPose,
  motionStateFrom,
  Position as RenderPosition,
  Rotation as RenderRotation,
  stepMotion,
} from "@vworlds/vecs-phaser";
import {
  BodyMotion,
  physics,
  Position as PhysicsPosition,
  Rotation as PhysicsRotation,
} from "@vworlds/vecs-physics";
import { Networked, ServerWorld } from "@vworlds/vecs-server";

import { PhaserServerModule } from "./PhaserServerModule.js";

/**
 * Server-only tag that sends a body's pose by dead reckoning instead of streaming it.
 *
 * A dead-reckoned entity carries a {@link Motion} baseline and **no render `Position` or
 * `Rotation`**. Clients extrapolate the baseline with the shared integrator, and the server sends a
 * new one only when the body leaves the predicted path or falls asleep (see
 * {@link DeadReckonedModule}). Game code keeps reading and writing the physics pose, as for every
 * other entity. When the body's damping, center of mass, gravity scale or `allowFastRotation`
 * differ from the defaults, the entity also carries a {@link MotionParams}, which the module adds
 * and keeps up to date.
 *
 * The tag is structural, so the guarantees hold whatever order an entity is built in:
 *
 * - Adding it adds `Motion`, the physics `Rotation` and a server-local prediction, and removes any
 *   render `Position` and `Rotation` the entity carried.
 * - Adding a render `Position` or `Rotation` to an entity that carries it throws.
 *
 * Decide it at spawn. Removing the tag, or adding it to a body that clients already stream, is not
 * supported: nothing turns a dead-reckoned body back into a streamed one.
 *
 * It is not a network component: clients see the `Motion` it brings, never the tag. A subtree
 * snapshot carries it like any other tag, so a body that moves to another world stays dead
 * reckoned there.
 */
export class DeadReckoned {}

/** Options for {@link DeadReckonedModule}. */
export interface DeadReckonedOptions {
  /**
   * How far, in meters, the body may stray from the predicted position before the server sends a
   * new baseline. Default `0.01`. Keep it above any quantization of `Motion` a later protocol
   * applies.
   */
  readonly positionTolerance?: number;

  /**
   * How far, in radians, the body may turn away from the predicted angle before the server sends a
   * new baseline. Default `0.01`.
   */
  readonly angleTolerance?: number;

  /**
   * The oldest a moving body's baseline may get, in seconds, before the server sends a fresh one.
   * Default `30`; `0` never refreshes.
   *
   * A client that first sees a body, on joining or when the body enters its view, steps the
   * integrator from the baseline's frame to the present, one physics step at a time. The refresh
   * bounds that catch-up, at the cost of one baseline per moving body per period. A baseline at
   * rest is never refreshed: the client holds its pose without stepping.
   */
  readonly maxBaselineAge?: number;
}

/**
 * Server half of dead reckoning: sends a body's pose as an occasional {@link Motion} baseline that
 * clients extrapolate, instead of streaming every change of its render pose. Install it on a
 * `ServerWorld` after `PhysicsModule`:
 *
 * ```ts
 * const world = new ServerWorld({
 *   networkComponents: [...phaserNetworkComponents, ...appComponents, ...phaserMotionComponents],
 * });
 * world.module(PhysicsModule, { fixedTimeStep: 1 / 30 });
 * world.module(DeadReckonedModule);
 * world.entity().add(Networked).add(DeadReckoned).set(Body, { type: BodyType.Dynamic });
 * ```
 *
 * It installs {@link PhaserServerModule}, gives {@link DeadReckoned} its structural guarantees, and
 * creates the world's single {@link MotionClock} entity from the physics settings (step, substeps,
 * gravity and speed cap). That entity is `Networked`, and adding `MotionClock` to any other entity
 * throws. Clients need it to extrapolate, so every `View` must include it.
 *
 * One `POST_UPDATE` system, `phaser.sync.motion`, runs after the physics step on every entity with
 * the physics pose, `DeadReckoned` and `Motion`. Each step it advances a server-local prediction by
 * one physics step with the shared integrator, from the baseline exactly as clients decode it, and
 * compares it with the physics pose. It writes a new baseline when the position strays further than
 * `positionTolerance`, the angle further than `angleTolerance`, the body falls asleep, or a moving
 * baseline outlives `maxBaselineAge`. Collisions, teleports, joints and forces all show up as that
 * divergence, with no special case.
 *
 * A baseline holds the physics pose and, for a moving body, Box2D's velocities, every value rounded
 * to the f32 the wire carries, and is stamped with `ServerWorld.frame`: the frame clients receive
 * it as. It is at rest (`Motion.rest`, with no velocities on the wire) when the body sleeps, when
 * the entity has no body, or when the body has no velocity and nothing accelerates it (the world has
 * no gravity, or the body's effective gravity scale is 0), so clients hold it still. The baseline is
 * written in place and announced with `modified`, so it replicates through the ordinary
 * acknowledged history and loss only delays it.
 *
 * The body constants the integrator needs travel in {@link MotionParams}, not in the baseline. Each
 * time it writes a moving baseline the module compares the body's damping, center of mass, effective
 * gravity scale (0 for a body without mass) and `allowFastRotation`, rounded to f32, with the
 * entity's `MotionParams`, or with the defaults when it has none. Only when they differ does it add
 * the component, or update it in place, and announce it with `modified` in the same frame as the
 * `Motion`, so both land in the same diff. A body with default constants, such as a bullet, never
 * carries one. Once added it is kept and updated, never removed, and a baseline at rest leaves it
 * untouched. Clients take the entity's `MotionParams` when they take the baseline.
 *
 * Per body per step the system steps the integrator once, reads its pose and compares; it allocates
 * nothing and looks up no component. The prediction keeps its own copy of the constants, taken when
 * the baseline is written. It asks Box2D whether the body is awake only when the physics pose did
 * not change since the previous step, since a sleeping body never moves, and reads the rest of the
 * body's motion only when it writes a baseline. A body whose baseline is at rest costs a comparison
 * of its pose.
 *
 * `Motion` and the prediction are world-local: a body restored in another world, by
 * `moveSubtree` or `restoreSubtree`, starts with a fresh prediction and gets a new baseline, at the
 * destination's frame, on its first step there. Its `MotionParams` travels with it like any other
 * component, and the first baseline compares it with the body again.
 */
export class DeadReckonedModule extends Module<DeadReckonedOptions | undefined> {
  public init(options: DeadReckonedOptions | undefined): void {
    const world = this.world;
    if (!(world instanceof ServerWorld)) {
      throw new Error("DeadReckonedModule must be installed on a ServerWorld");
    }
    requireNetworkComponents(world);
    const positionTolerance = options?.positionTolerance ?? 0.01;
    const angleTolerance = options?.angleTolerance ?? 0.01;
    const maxBaselineAge = options?.maxBaselineAge ?? 30;
    const queries = physics(world);
    const settings = queries.settings();

    world.module(PhaserServerModule);
    world.component(MotionPrediction).snapshotPolicy(DontSnapshot);
    world
      .component(DeadReckoned)
      .add(With, world.component(Motion).eid)
      .add(With, world.component(PhysicsRotation).eid)
      .add(With, world.component(MotionPrediction).eid)
      .on("add", (entity) => {
        entity.remove(RenderPosition);
        entity.remove(RenderRotation);
      });
    const rejectRenderPose = (entity: Entity): void => {
      if (entity.has(DeadReckoned)) {
        throw new Error(
          `entity ${entity.eid} is DeadReckoned: its pose replicates as Motion, so it cannot carry a render Position or Rotation`
        );
      }
    };
    world.component(RenderPosition).on("add", rejectRenderPose);
    world.component(RenderRotation).on("add", rejectRenderPose);

    const clock = new MotionClock();
    clock.stepSeconds = Math.fround(settings.fixedTimeStep);
    clock.subSteps = settings.subSteps;
    clock.gravityX = Math.fround(settings.gravity.x);
    clock.gravityY = Math.fround(settings.gravity.y);
    clock.maxLinearSpeed = Math.fround(settings.maximumLinearSpeed);
    const clockEntity = world.entity();
    world.component(MotionClock).on("add", (entity) => {
      if (entity !== clockEntity) {
        throw new Error(
          `MotionClock is owned by DeadReckonedModule, which keeps it on entity ${clockEntity.eid}; it cannot be added to entity ${entity.eid}`
        );
      }
    });
    clockEntity.add(Networked).attach(clock);

    const noWorldGravity = clock.gravityX === 0 && clock.gravityY === 0;
    const positionToleranceSquared = positionTolerance * positionTolerance;
    const maxAgeFrames = maxBaselineAge > 0 ? Math.round(maxBaselineAge / clock.stepSeconds) : 0;
    const scratch = new BodyMotion();

    world
      .system("phaser.sync.motion")
      .with(PhysicsPosition, PhysicsRotation, DeadReckoned, Motion, MotionPrediction)
      .phase(POST_UPDATE)
      .each(
        [PhysicsPosition, PhysicsRotation, Motion, MotionPrediction],
        (entity, [position, rotation, motion, prediction]) => {
          const frame = world.frame;
          const unchanged =
            position.x === prediction.lastX &&
            position.y === prediction.lastY &&
            rotation.angle === prediction.lastAngle;
          prediction.lastX = position.x;
          prediction.lastY = position.y;
          prediction.lastAngle = rotation.angle;

          if (!prediction.primed) {
            writeBaseline(entity, position, rotation, motion, prediction, frame);
            return;
          }
          if (prediction.rest) {
            // The prediction holds still; it only diverges when the pose moves.
            if (!unchanged && diverged(position, rotation, prediction.pose)) {
              writeBaseline(entity, position, rotation, motion, prediction, frame);
            }
            return;
          }

          const state = prediction.state;
          const params = prediction.params;
          while (prediction.frame < frame) {
            stepMotion(state, params, clock);
            prediction.frame++;
          }
          motionPose(state, params, prediction.pose);
          if (
            // A sleeping body never moves, so only a pose that did not change can be asleep.
            (unchanged && !queries.isAwake(entity)) ||
            (maxAgeFrames > 0 && frame - motion.frame >= maxAgeFrames) ||
            diverged(position, rotation, prediction.pose)
          ) {
            writeBaseline(entity, position, rotation, motion, prediction, frame);
          }
        }
      );

    function diverged(
      position: Readonly<PhysicsPosition>,
      rotation: Readonly<PhysicsRotation>,
      pose: Readonly<MotionPose>
    ): boolean {
      const dx = position.x - pose.x;
      const dy = position.y - pose.y;
      if (dx * dx + dy * dy > positionToleranceSquared) {
        return true;
      }
      let da = rotation.angle - pose.angle;
      if (da > Math.PI || da < -Math.PI) {
        da -= TWO_PI * Math.round(da / TWO_PI);
      }
      return Math.abs(da) > angleTolerance;
    }

    // Writes the baseline as the wire carries it: every value an f32, so the component equals what
    // a client decodes, and the prediction restarts from exactly the values clients start from.
    function writeBaseline(
      entity: Entity,
      position: Readonly<PhysicsPosition>,
      rotation: Readonly<PhysicsRotation>,
      motion: Motion,
      prediction: MotionPrediction,
      frame: number
    ): void {
      const f32 = Math.fround;
      const moving = queries.bodyMotion(entity, scratch) && scratch.awake;
      motion.frame = frame;
      motion.x = f32(position.x);
      motion.y = f32(position.y);
      motion.angle = f32(rotation.angle);
      if (moving) {
        motion.vx = f32(scratch.vx);
        motion.vy = f32(scratch.vy);
        motion.w = f32(scratch.w);
      } else {
        motion.vx = 0;
        motion.vy = 0;
        motion.w = 0;
      }
      // A baseline holds the body still when it cannot move: it sleeps (or has no body), or it has
      // no velocity and nothing accelerates it. Peers then hold the pose and never step it.
      motion.rest =
        !moving ||
        (motion.vx === 0 &&
          motion.vy === 0 &&
          motion.w === 0 &&
          (noWorldGravity || f32(scratch.gravityScale) === 0));
      entity.modified(Motion);

      // The constants ride in MotionParams, which is written only when the body's differ from the
      // entity's (or the defaults, for an entity with none), in the same frame as the baseline. A
      // baseline at rest never steps, so it leaves them alone. `ensure` adds the component when it
      // is missing and announces an existing one as modified.
      let params: Readonly<MotionParams> = entity.get(MotionParams) ?? defaultMotionParams;
      if (!motion.rest && differsFromBody(params, scratch)) {
        const next = entity.ensure(MotionParams);
        assignFromBody(next, scratch);
        params = next;
      }
      copyParams(params, prediction.params);

      motionStateFrom(motion, prediction.params, prediction.state);
      motionPose(prediction.state, prediction.params, prediction.pose);
      prediction.frame = frame;
      prediction.rest = motion.rest;
      prediction.primed = true;
    }
  }
}

/**
 * Server-local dead-reckoning state of one body: the prediction the clients run, advanced to the
 * current frame. {@link DeadReckoned} brings it. It never replicates, and it is never captured in a
 * subtree snapshot, so a restored body starts unprimed and gets a new baseline.
 */
class MotionPrediction {
  /** Set once the first baseline is written; an unprimed prediction writes one on its next step. */
  public primed = false;

  /** The baseline holds the body still (`Motion.rest`), so the prediction is not stepped. */
  public rest = false;

  /** Server frame the prediction state is at. */
  public frame = 0;

  /** Physics position x on the previous step, to tell a pose that did not change. */
  public lastX = Number.NaN;

  /** Physics position y on the previous step. */
  public lastY = Number.NaN;

  /** Physics angle on the previous step. */
  public lastAngle = Number.NaN;

  /**
   * The body constants clients step the baseline with: a copy of the entity's `MotionParams` (or
   * the defaults) taken when the baseline was written, so the per-step path looks up no component.
   * Never the shared default itself, so the integrator's call sites only see one object shape.
   */
  public readonly params = new MotionParams();

  /** Integrator state at `frame`. */
  public readonly state = new MotionState();

  /** Predicted pose at `frame`. */
  public readonly pose = new MotionPose();
}

const TWO_PI = 2 * Math.PI;

// Whether the body's constants, rounded to the f32 the wire carries, differ from `params`.
function differsFromBody(params: Readonly<MotionParams>, body: Readonly<BodyMotion>): boolean {
  const f32 = Math.fround;
  return (
    params.linearDamping !== f32(body.linearDamping) ||
    params.angularDamping !== f32(body.angularDamping) ||
    params.localCenterX !== f32(body.localCenterX) ||
    params.localCenterY !== f32(body.localCenterY) ||
    params.gravityScale !== f32(body.gravityScale) ||
    params.allowFastRotation !== body.allowFastRotation
  );
}

// Writes the body's constants into `params`, rounded to the f32 the wire carries.
function assignFromBody(params: MotionParams, body: Readonly<BodyMotion>): void {
  const f32 = Math.fround;
  params.linearDamping = f32(body.linearDamping);
  params.angularDamping = f32(body.angularDamping);
  params.localCenterX = f32(body.localCenterX);
  params.localCenterY = f32(body.localCenterY);
  params.gravityScale = f32(body.gravityScale);
  params.allowFastRotation = body.allowFastRotation;
}

function copyParams(source: Readonly<MotionParams>, target: MotionParams): void {
  target.linearDamping = source.linearDamping;
  target.angularDamping = source.angularDamping;
  target.localCenterX = source.localCenterX;
  target.localCenterY = source.localCenterY;
  target.gravityScale = source.gravityScale;
  target.allowFastRotation = source.allowFastRotation;
}

function requireNetworkComponents(world: ServerWorld): void {
  const registered = (Class: unknown): boolean =>
    world.networkComponents.some((component) => component.Class === Class);
  if (!registered(Motion) || !registered(MotionParams) || !registered(MotionClock)) {
    throw new Error(
      "DeadReckonedModule needs Motion, MotionParams and MotionClock in the ServerWorld's networkComponents: append phaserMotionComponents after your existing entries"
    );
  }
}
