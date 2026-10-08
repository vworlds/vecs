import { Module, POST_LOAD, With } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  Motion,
  MotionClock,
  MotionPose,
  MotionState,
  motionAtRest,
  motionPose,
  motionStateFrom,
  Position,
  Rotation,
  stepMotion,
} from "@vworlds/vecs-phaser";

/** Options for {@link DeadReckonedModule}. */
export interface DeadReckonedModuleConfig {
  /**
   * How long a late correction takes to blend in, in milliseconds. Default `100`. A late correction
   * is a baseline that arrives after the client has rendered past its frame, so the body has
   * already been drawn on the old path; its error fades out over this time instead of jumping.
   */
  readonly blendMs?: number;

  /** A correction that moves the body further than this, in meters, snaps. Default `1`. */
  readonly snapDistance?: number;

  /** A correction that turns the body further than this, in radians, snaps. Default `0.5`. */
  readonly snapAngle?: number;
}

/**
 * Client half of dead reckoning: extrapolates every entity that carries a {@link Motion} baseline
 * into a client-local render `Position` and `Rotation`. Install it on a `ClientWorld` whose
 * `networkComponents` end with `phaserMotionComponents`, as the server's do:
 *
 * ```ts
 * const world = new ClientWorld({
 *   networkComponents: [...phaserNetworkComponents, ...appComponents, ...phaserMotionComponents],
 *   interpolators: phaserInterpolators(),
 * });
 * world.module(DeadReckonedModule);
 * world.module(PhaserRenderModule, { scene });
 * ```
 *
 * `Motion` brings `Position` and `Rotation` with it, so an entity that arrives with only a baseline,
 * on joining or on entering the view, gets a render pose to write. The server never sends one for a
 * dead-reckoned body.
 *
 * One system, `phaser.extrapolate.motion`, runs in `POST_LOAD`, right after `ClientWorld` applied
 * the frame in `ON_LOAD`. It samples every baseline at `ClientWorld.renderFrame`, the point the
 * interpolators sample, so dead-reckoned and interpolated entities show the same moment: from the
 * baseline's frame it steps the shared integrator `floor(renderFrame - Motion.frame)` physics steps
 * and interpolates the remaining fraction toward the next step. It writes the pose in place and
 * calls `modified` only when it changed. Because it runs before every gameplay and render phase,
 * game systems, `phaser.resolve.offset` and the `phaser.sync.*` systems see the extrapolated pose in
 * the same frame, exactly as they see an interpolated one, whatever order the modules were
 * installed in. `DrawBy` children of a dead-reckoned body follow it without a frame of lag.
 *
 * Baselines:
 *
 * - A baseline older than the one held is ignored, so reordered datagrams cannot roll the body
 *   back.
 * - A correction the client receives in time, before rendering past its frame, applies at once:
 *   it is the server's pose at the frame being rendered.
 * - A late correction blends: the error between the old and the new path fades out linearly over
 *   `blendMs` of render time. One that moves the body further than `snapDistance` or turns it
 *   further than `snapAngle` snaps instead.
 *
 * The world's `MotionClock`, which the server sends once, supplies the step, substeps, gravity and
 * speed cap. Until it arrives nothing is extrapolated.
 *
 * Per entity per frame the system compares the baseline's frame, takes the steps the render frame
 * crossed (usually none or one), interpolates and compares the pose; it allocates nothing. A body
 * at rest is never stepped. On joining or on view entry it steps from the baseline's frame to the
 * present once; the server bounds that with `maxBaselineAge`.
 *
 * `Motion` itself is not interpolated: register no interpolator for it.
 */
export class DeadReckonedModule extends Module<DeadReckonedModuleConfig | undefined> {
  public init(config: DeadReckonedModuleConfig | undefined): void {
    const world = this.world;
    if (!(world instanceof ClientWorld)) {
      throw new Error("DeadReckonedModule must be installed on a ClientWorld");
    }
    requireNetworkComponents(world);
    const blendSeconds = (config?.blendMs ?? 100) / 1000;
    const snapDistance = config?.snapDistance ?? 1;
    const snapDistanceSquared = snapDistance * snapDistance;
    const snapAngle = config?.snapAngle ?? 0.5;

    world.component(MotionTrack);
    world
      .component(Motion)
      .add(With, world.component(Position).eid)
      .add(With, world.component(Rotation).eid)
      .add(With, world.component(MotionTrack).eid);

    // The one MotionClock the server sends, held for the extrapolator.
    let clock: Readonly<MotionClock> | undefined;
    world
      .component(MotionClock)
      .on("add", (_entity, value) => {
        clock = value;
      })
      .on("set", (_entity, value) => {
        clock = value;
      })
      .on("remove", (_entity, value) => {
        if (clock === value) {
          clock = undefined;
        }
      });

    const sample = new MotionPose();

    world
      .system("phaser.extrapolate.motion")
      .with(Motion, MotionTrack, Position, Rotation)
      .phase(POST_LOAD)
      .each([Motion, MotionTrack, Position, Rotation], (entity, [motion, track, pos, rot]) => {
        if (clock === undefined) {
          return;
        }
        const renderFrame = world.renderFrame;
        if (motion.frame > track.frame) {
          rebaseline(track, motion, clock, renderFrame);
        } else {
          extrapolate(track, clock, renderFrame, sample);
          blend(track, clock, renderFrame, sample);
        }
        if (pos.x !== sample.x || pos.y !== sample.y) {
          pos.x = sample.x;
          pos.y = sample.y;
          entity.modified(Position);
        }
        if (rot.angle !== sample.angle) {
          rot.angle = sample.angle;
          entity.modified(Rotation);
        }
      });

    // Take a newer baseline. The error between the path the body was drawn on and the new one,
    // both at `renderFrame`, is kept to blend out when the correction is late and small enough.
    function rebaseline(
      track: MotionTrack,
      motion: Readonly<Motion>,
      clock: Readonly<MotionClock>,
      renderFrame: number
    ): void {
      const held = track.frame >= 0;
      let oldX = 0;
      let oldY = 0;
      let oldAngle = 0;
      if (held) {
        extrapolate(track, clock, renderFrame, sample);
        blend(track, clock, renderFrame, sample);
        oldX = sample.x;
        oldY = sample.y;
        oldAngle = sample.angle;
      }

      copyMotion(motion, track.baseline);
      track.frame = motion.frame;
      track.rest = motionAtRest(motion, clock);
      restart(track, clock);
      extrapolate(track, clock, renderFrame, sample);

      track.errorX = 0;
      track.errorY = 0;
      track.errorAngle = 0;
      if (!held || renderFrame - track.frame < 1) {
        return;
      }
      const ex = oldX - sample.x;
      const ey = oldY - sample.y;
      const ea = wrapAngle(oldAngle - sample.angle);
      if (ex * ex + ey * ey > snapDistanceSquared || Math.abs(ea) > snapAngle) {
        return;
      }
      track.errorX = ex;
      track.errorY = ey;
      track.errorAngle = ea;
      track.blendFrom = renderFrame;
      sample.x = oldX;
      sample.y = oldY;
      sample.angle = oldAngle;
    }

    // Add what is left of a late correction's error to the sampled pose.
    function blend(
      track: MotionTrack,
      clock: Readonly<MotionClock>,
      renderFrame: number,
      out: MotionPose
    ): void {
      if (track.errorX === 0 && track.errorY === 0 && track.errorAngle === 0) {
        return;
      }
      const remaining = 1 - ((renderFrame - track.blendFrom) * clock.stepSeconds) / blendSeconds;
      if (!(remaining > 0)) {
        track.errorX = 0;
        track.errorY = 0;
        track.errorAngle = 0;
        return;
      }
      out.x += track.errorX * remaining;
      out.y += track.errorY * remaining;
      out.angle += track.errorAngle * remaining;
    }
  }
}

/**
 * Client-local extrapolation state of one dead-reckoned entity. `Motion` brings it. It holds its own
 * copy of the accepted baseline, so an older `Motion` that a reordered datagram writes over the
 * component cannot change the path, and the two poses the render frame falls between.
 */
class MotionTrack {
  /** Frame of the accepted baseline, `-1` before the first. */
  public frame = -1;

  /** The baseline holds the body still ({@link motionAtRest}), so it is never stepped. */
  public rest = false;

  /** Steps from the baseline to `from`. */
  public steps = 0;

  /** Position error of a late correction still blending out, x, in meters. */
  public errorX = 0;

  /** Position error of a late correction, y, in meters. */
  public errorY = 0;

  /** Angle error of a late correction, in radians. */
  public errorAngle = 0;

  /** Render frame the blending correction was taken at. */
  public blendFrom = 0;

  /** The accepted baseline. */
  public readonly baseline = new Motion();

  /** Integrator state one step past `from`, at `to`. */
  public readonly state = new MotionState();

  /** Pose `steps` steps after the baseline. */
  public readonly from = new MotionPose();

  /** Pose one step after `from`. */
  public readonly to = new MotionPose();
}

const TWO_PI = 2 * Math.PI;

/**
 * Sample the track at `renderFrame`: step it to the step the frame falls in, then interpolate the
 * fraction toward the next one.
 */
function extrapolate(
  track: MotionTrack,
  clock: Readonly<MotionClock>,
  renderFrame: number,
  out: MotionPose
): void {
  const from = track.from;
  if (track.rest) {
    out.x = from.x;
    out.y = from.y;
    out.angle = from.angle;
    return;
  }
  const elapsed = renderFrame > track.frame ? renderFrame - track.frame : 0;
  const steps = Math.floor(elapsed);
  if (steps < track.steps) {
    restart(track, clock);
  }
  const to = track.to;
  while (track.steps < steps) {
    from.x = to.x;
    from.y = to.y;
    from.angle = to.angle;
    stepMotion(track.state, track.baseline, clock);
    motionPose(track.state, track.baseline, to);
    track.steps++;
  }
  const fraction = elapsed - steps;
  out.x = from.x + (to.x - from.x) * fraction;
  out.y = from.y + (to.y - from.y) * fraction;
  out.angle = from.angle + wrapAngle(to.angle - from.angle) * fraction;
}

/** Put the track back at its baseline: `from` at the baseline, `to` one step later. */
function restart(track: MotionTrack, clock: Readonly<MotionClock>): void {
  const baseline = track.baseline;
  motionStateFrom(baseline, track.state);
  motionPose(track.state, baseline, track.from);
  if (!track.rest) {
    stepMotion(track.state, baseline, clock);
  }
  motionPose(track.state, baseline, track.to);
  track.steps = 0;
}

function copyMotion(source: Readonly<Motion>, target: Motion): void {
  target.frame = source.frame;
  target.x = source.x;
  target.y = source.y;
  target.angle = source.angle;
  target.vx = source.vx;
  target.vy = source.vy;
  target.w = source.w;
  target.linearDamping = source.linearDamping;
  target.angularDamping = source.angularDamping;
  target.localCenterX = source.localCenterX;
  target.localCenterY = source.localCenterY;
  target.gravityScale = source.gravityScale;
  target.allowFastRotation = source.allowFastRotation;
}

/** `angle` moved into [-π, π] by whole turns. */
function wrapAngle(angle: number): number {
  return angle > Math.PI || angle < -Math.PI ? angle - TWO_PI * Math.round(angle / TWO_PI) : angle;
}

function requireNetworkComponents(world: ClientWorld): void {
  const registered = (Class: unknown): boolean =>
    world.networkComponents.some((component) => component.Class === Class);
  if (!registered(Motion) || !registered(MotionClock)) {
    throw new Error(
      "DeadReckonedModule needs Motion and MotionClock in the ClientWorld's networkComponents: append phaserMotionComponents, as the server does"
    );
  }
}
