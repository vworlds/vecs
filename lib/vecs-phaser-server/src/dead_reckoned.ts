import { DontSnapshot, Module, POST_UPDATE, With, type Entity } from "@vworlds/vecs";
import {
  Motion,
  MotionClock,
  MotionPose,
  MotionState,
  motionAtRest,
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
 * other entity.
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
 * A baseline holds the physics pose, Box2D's velocities, damping, center of mass, effective gravity
 * scale (0 for a body without mass) and `allowFastRotation`, every value rounded to the f32 the wire
 * carries, and is stamped with `ServerWorld.frame`: the frame clients receive it as. A sleeping body,
 * or an entity without a body, gets a baseline at rest, with no velocity and a gravity scale of 0,
 * so clients hold it still. The baseline is written in place and announced with `modified`, so it
 * replicates through the ordinary acknowledged history and loss only delays it.
 *
 * Per body per step the system steps the integrator once, reads its pose and compares; it allocates
 * nothing. It asks Box2D whether the body is awake only when the physics pose did not change since
 * the previous step, since a sleeping body never moves, and reads the rest of the body's motion only
 * when it writes a baseline. A body whose baseline is at rest costs a comparison of its pose.
 *
 * `Motion` and the prediction are world-local: a body restored in another world, by
 * `moveSubtree` or `restoreSubtree`, starts with a fresh prediction and gets a new baseline, at the
 * destination's frame, on its first step there.
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
          while (prediction.frame < frame) {
            stepMotion(state, motion, clock);
            prediction.frame++;
          }
          motionPose(state, motion, prediction.pose);
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
        motion.linearDamping = f32(scratch.linearDamping);
        motion.angularDamping = f32(scratch.angularDamping);
        motion.localCenterX = f32(scratch.localCenterX);
        motion.localCenterY = f32(scratch.localCenterY);
        motion.gravityScale = f32(scratch.gravityScale);
        motion.allowFastRotation = scratch.allowFastRotation;
      } else {
        // At rest: clients hold the pose, so only the pose is sent.
        motion.vx = 0;
        motion.vy = 0;
        motion.w = 0;
        motion.linearDamping = 0;
        motion.angularDamping = 0;
        motion.localCenterX = 0;
        motion.localCenterY = 0;
        motion.gravityScale = 0;
        motion.allowFastRotation = false;
      }
      entity.modified(Motion);

      motionStateFrom(motion, prediction.state);
      motionPose(prediction.state, motion, prediction.pose);
      prediction.frame = frame;
      prediction.rest = motionAtRest(motion, clock);
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

  /** The baseline holds the body still ({@link motionAtRest}), so the prediction is not stepped. */
  public rest = false;

  /** Server frame the prediction state is at. */
  public frame = 0;

  /** Physics position x on the previous step, to tell a pose that did not change. */
  public lastX = Number.NaN;

  /** Physics position y on the previous step. */
  public lastY = Number.NaN;

  /** Physics angle on the previous step. */
  public lastAngle = Number.NaN;

  /** Integrator state at `frame`. */
  public readonly state = new MotionState();

  /** Predicted pose at `frame`. */
  public readonly pose = new MotionPose();
}

const TWO_PI = 2 * Math.PI;

function requireNetworkComponents(world: ServerWorld): void {
  const registered = (Class: unknown): boolean =>
    world.networkComponents.some((component) => component.Class === Class);
  if (!registered(Motion) || !registered(MotionClock)) {
    throw new Error(
      "DeadReckonedModule needs Motion and MotionClock in the ServerWorld's networkComponents: append phaserMotionComponents after your existing entries"
    );
  }
}
