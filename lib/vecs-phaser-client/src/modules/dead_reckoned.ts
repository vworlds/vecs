import { Module, POST_LOAD, With, type Entity } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  copyMotionParams,
  defaultMotionParams,
  Motion,
  MotionClock,
  MotionParams,
  MotionPose,
  MotionState,
  motionPose,
  motionStateFrom,
  Position,
  Rotation,
  stepMotion,
} from "@vworlds/vecs-phaser";

/** Options for {@link DeadReckonedModule}, also exported by the Phaser-free `/headless` entry. */
export interface DeadReckonedModuleConfig {
  /**
   * How long a late correction takes to blend in, in milliseconds. Default `100`. A late correction
   * is a baseline that arrives after the client has rendered past its frame, so the body has
   * already been drawn on the old path; its error fades out over this time instead of jumping. The
   * same blend smooths the hand-off when the server switches a body between a streamed pose and
   * dead reckoning, in either direction. `0` turns blending off: every correction snaps.
   * Measured in render-loop time from `progress(now, delta)`, so blends complete even
   * while the replicated-state `renderFrame` holds or after the render loop resumes.
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
 * Node clients can import this module from `@vworlds/vecs-phaser-client/headless` without Phaser.
 *
 * `Motion` brings `Position` and `Rotation` with it, so an entity that arrives with only a baseline,
 * on joining or on entering the view, gets a render pose to write. The server never sends one for a
 * dead-reckoned body.
 *
 * ## Switching paths
 *
 * A server may switch a body between a streamed pose and a baseline while it lives (see
 * `DeadReckoned` in `@vworlds/vecs-phaser-server`). The render pose stays present through the
 * hand-off in both directions: `ClientWorld` skips a network removal of a component that another
 * one brings through `With`, so the server's removal of `Position` and `Rotation` in the diff that
 * sets `Motion` leaves them in place, and the entity's `DrawBy` children never see them go.
 *
 * - **Streamed to dead reckoned.** The module's `Motion` hook finds the entity already showing a pose
 *   and remembers it. The pose just shown can differ from the track's first sample (a streamed
 *   body that stops being updated holds its last pose until the baseline's frame), so the first
 *   baseline blends the difference out like a late correction. A track created on view entry has
 *   no pose to remember and never blends.
 * - **Dead reckoned to streamed.** On `Motion`'s removal the track stays for the length of the
 *   blend, as a hand-off: the difference between the pose the track would still show and the
 *   freshly streamed one fades out over `blendMs`, added to the interpolated pose, and then the
 *   track is removed. The hand-off writes its own pose instances; replication-owned instances are
 *   read-only sources. Its final, unoffset pose stays attached until the network replaces it. A
 *   later `Motion` starts a fresh track from the shown pose.
 *
 * In both directions a difference above `snapDistance` or `snapAngle` snaps instead (and
 * `blendMs: 0` snaps every one). An entity in steady state pays nothing for any of it: the hand-off
 * is a second `POST_LOAD` system, `phaser.extrapolate.handoff`, whose query holds only the entities
 * in a hand-off.
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
 *   `blendMs` of render-loop time, advanced by `progress(now, delta)` in milliseconds.
 *   It completes even when `renderFrame` holds during an idle keepalive pause, including
 *   after a render-loop stall. One that moves the body further than `snapDistance` or turns it
 *   further than `snapAngle` snaps instead.
 * - After an idle keepalive pause, the first moving baseline can be applied up to one frame
 *   late and then blends like any late correction. The pre-existing buffer compaction race
 *   is tracked in https://github.com/vworlds/vecs/issues/271.
 *
 * The world's `MotionClock`, which the server sends once, supplies the step, substeps, gravity and
 * speed cap. Until it arrives nothing is extrapolated.
 *
 * The body constants (damping, center of mass, gravity scale, fast rotation) come from the entity's
 * `MotionParams`, which the server sends only when they change, in the same frame as the `Motion`
 * they belong to. An entity without one has the defaults. They take effect at the next rebaseline:
 * when the extrapolator accepts a newer `Motion` it copies the entity's `MotionParams` (or the
 * defaults) into its own track, and steps every later frame of that baseline with the copy. Whether
 * the body is held still is read from `Motion.rest`, which the server decides.
 *
 * Per entity per frame the system compares the baseline's frame, takes the steps the render frame
 * crossed (usually none or one), interpolates and compares the pose; it allocates nothing and looks
 * up no component. A body at rest is never stepped. On joining or on view entry it steps from the
 * baseline's frame to the present once; the server bounds that with `maxBaselineAge`.
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
    const blendMs = config?.blendMs ?? 100;
    let blendClock = 0;
    const snapDistance = config?.snapDistance ?? 1;
    const snapDistanceSquared = snapDistance * snapDistance;
    const snapAngle = config?.snapAngle ?? 0.5;

    world.component(MotionTrack);
    world
      .component(Motion)
      .on("add", (entity) => {
        startTrack(entity);
      })
      .on("remove", (entity) => {
        startHandoff(entity, world.renderFrame);
      })
      .add(With, world.component(Position).eid)
      .add(With, world.component(Rotation).eid);

    // The Position instances created while their entity has a Motion: the ones `With` brings, which
    // hold no pose the entity showed. Outside a deferred scope `With` has added the Position by the
    // time the `Motion` hook runs, and inside one it adds it later, so the hook cannot tell a view
    // entry from a streamed body that switched to dead reckoning by whether there is a Position
    // (both have one in the first case, only the switched body in the second); it tells them by
    // whether that Position is one of these.
    const brought = new WeakSet<object>();
    world.component(Position).on("add", (entity, position) => {
      if (entity.has(Motion)) {
        brought.add(position);
      }
    });

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
      // The existing system's run callback precedes each and runs even with no
      // Motion entities, advancing one shared clock for hand-offs too. World
      // progress and run callbacks receive delta in milliseconds.
      .run((_now, delta) => {
        blendClock += delta;
      })
      .each([Motion, MotionTrack, Position, Rotation], (entity, [motion, track, pos, rot]) => {
        if (clock === undefined) {
          return;
        }
        const renderFrame = world.renderFrame;
        if (motion.frame > track.frame) {
          rebaseline(entity, track, motion, clock, renderFrame);
        } else {
          extrapolate(track, clock, renderFrame, sample);
          blend(track, sample);
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

    // The path the body is drawn on when it leaves dead reckoning: the hand-off fades the difference
    // between it and the streamed pose out over `blendMs`, then drops the track. Only an entity in
    // this state is in the query, so a body in steady state pays nothing for it. Replication-owned
    // instances are read-only: the track owns its output and remembers the last network source.
    world
      .system("phaser.extrapolate.handoff")
      .with(MotionTrack, Position, Rotation)
      .without(Motion)
      .phase(POST_LOAD)
      .each([MotionTrack, Position, Rotation], (entity, [track, pos, rot]) => {
        const remaining = remainingBlend(track);
        if (pos !== track.position) {
          track.sourceX = pos.x;
          track.sourceY = pos.y;
        }
        if (rot !== track.rotation) {
          track.sourceAngle = rot.angle;
        }
        const position = (track.position ??= new Position());
        const rotation = (track.rotation ??= new Rotation());
        const fading = remaining > 0;
        const x = track.sourceX + (fading ? track.errorX * remaining : 0);
        const y = track.sourceY + (fading ? track.errorY * remaining : 0);
        const angle = track.sourceAngle + (fading ? track.errorAngle * remaining : 0);
        const moved = position.x !== x || position.y !== y;
        if (moved) {
          position.x = x;
          position.y = y;
        }
        if (pos !== position) {
          entity.attach(position);
        } else if (moved) {
          entity.modified(Position);
        }
        const turned = rotation.angle !== angle;
        if (turned) {
          rotation.angle = angle;
        }
        if (rot !== rotation) {
          entity.attach(rotation);
        } else if (turned) {
          entity.modified(Rotation);
        }
        if (!fading) {
          entity.remove(MotionTrack);
        }
      });

    // A new Motion gets its track, replacing the hand-off of a body that returns to dead reckoning
    // within it. An entity that already shows a pose when its first baseline arrives, a streamed
    // body the server just switched to dead reckoning, hands that pose to the track, which blends
    // its first sample from it. A track created on view entry finds no pose but the one `Motion`
    // brings, so it has nothing to blend from and never blends.
    function startTrack(entity: Entity): void {
      const track = new MotionTrack();
      const position = entity.get(Position);
      if (position !== undefined && !brought.has(position)) {
        track.shown = true;
        track.from.x = position.x;
        track.from.y = position.y;
        track.from.angle = entity.get(Rotation)?.angle ?? 0;
      }
      entity.attach(MotionTrack, track);
    }

    // `Motion` is gone: the server switched the body to a streamed pose, whose first value has no
    // interpolation history and may sit off the path the body was drawn on. Keep the track as a
    // hand-off whose error is the difference between the two at `renderFrame`; the handoff system
    // fades it out. Without a path to compare, or when the difference is a snap, drop the track.
    function startHandoff(entity: Entity, renderFrame: number): void {
      if (entity.destroyed) {
        return;
      }
      const track = entity.get(MotionTrack) as MotionTrack | undefined;
      if (track === undefined) {
        return;
      }
      const position = entity.get(Position);
      const rotation = entity.get(Rotation);
      if (
        clock !== undefined &&
        track.frame >= 0 &&
        position !== undefined &&
        rotation !== undefined
      ) {
        extrapolate(track, clock, renderFrame, sample);
        blend(track, sample);
        const ex = sample.x - position.x;
        const ey = sample.y - position.y;
        const ea = wrapAngle(sample.angle - rotation.angle);
        if (!snaps(ex, ey, ea) && (ex !== 0 || ey !== 0 || ea !== 0)) {
          track.errorX = ex;
          track.errorY = ey;
          track.errorAngle = ea;
          track.blendFrom = blendClock;
          track.handoff = true;
          return;
        }
      }
      entity.remove(MotionTrack);
    }

    // Take a newer baseline. The error between the path the body was drawn on and the new one,
    // both at `renderFrame`, is kept to blend out when the correction is late and small enough. A
    // body's first baseline has no path of its own; if the entity was already showing a pose, that
    // pose is the one to blend from.
    function rebaseline(
      entity: Entity,
      track: MotionTrack,
      motion: Readonly<Motion>,
      clock: Readonly<MotionClock>,
      renderFrame: number
    ): void {
      const held = track.frame >= 0;
      const shown = !held && track.shown;
      let oldX = 0;
      let oldY = 0;
      let oldAngle = 0;
      if (held) {
        extrapolate(track, clock, renderFrame, sample);
        blend(track, sample);
        oldX = sample.x;
        oldY = sample.y;
        oldAngle = sample.angle;
      } else if (shown) {
        oldX = track.from.x;
        oldY = track.from.y;
        oldAngle = track.from.angle;
      }

      // The body constants come with the baseline: the entity's MotionParams, or the defaults for an
      // entity without one. The server writes a changed MotionParams in the same frame as the
      // Motion it belongs to, so this is the only place they are looked up.
      copyMotion(motion, track.baseline);
      copyMotionParams(entity.get(MotionParams) ?? defaultMotionParams, track.params);
      track.frame = motion.frame;
      track.rest = motion.rest;
      track.shown = false;
      restart(track, clock);
      extrapolate(track, clock, renderFrame, sample);

      track.errorX = 0;
      track.errorY = 0;
      track.errorAngle = 0;
      // A correction received in time is applied at once: the track was never drawn ahead of it. A
      // pose shown before the first baseline always was drawn, so it blends however recent.
      if (!(shown || (held && renderFrame - track.frame >= 1))) {
        return;
      }
      const ex = oldX - sample.x;
      const ey = oldY - sample.y;
      const ea = wrapAngle(oldAngle - sample.angle);
      if (snaps(ex, ey, ea)) {
        return;
      }
      track.errorX = ex;
      track.errorY = ey;
      track.errorAngle = ea;
      track.blendFrom = blendClock;
      sample.x = oldX;
      sample.y = oldY;
      sample.angle = oldAngle;
    }

    // Whether an error is shown at once instead of blended: it is further than the snap limits, or
    // blending is off.
    function snaps(ex: number, ey: number, ea: number): boolean {
      return !(blendMs > 0) || ex * ex + ey * ey > snapDistanceSquared || Math.abs(ea) > snapAngle;
    }

    // The fraction of a blend's error left on the shared render-loop clock.
    function remainingBlend(track: MotionTrack): number {
      return 1 - (blendClock - track.blendFrom) / blendMs;
    }

    // Add what is left of a late correction's error to the sampled pose.
    function blend(track: MotionTrack, out: MotionPose): void {
      if (track.errorX === 0 && track.errorY === 0 && track.errorAngle === 0) {
        return;
      }
      const remaining = remainingBlend(track);
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
 * Client-local extrapolation state of one dead-reckoned entity. The module attaches it when `Motion`
 * is added and drops it when the entity no longer needs it: at once when `Motion` goes, or, for a
 * body the server switches to a streamed pose, after the hand-off has faded out. It holds its own
 * copy of the accepted baseline and of the entity's `MotionParams` as they were at that baseline, so
 * an older `Motion` that a reordered datagram writes over the component cannot change the path, and
 * the two poses the render frame falls between. During a hand-off it owns Position and Rotation
 * output instances, allocated once, and caches the last network source values. Replication-owned
 * instances are read-only to the hand-off, including ones held as interpolation history. The owned
 * output remains attached at the plain source pose when the track is dropped.
 */
class MotionTrack {
  /** Frame of the accepted baseline, `-1` before the first. */
  public frame = -1;

  /** The baseline holds the body still (`Motion.rest`), so it is never stepped. */
  public rest = false;

  /** Steps from the baseline to `from`. */
  public steps = 0;

  /** Position error of a late correction still blending out, x, in meters. */
  public errorX = 0;

  /** Position error of a late correction, y, in meters. */
  public errorY = 0;

  /** Angle error of a late correction, in radians. */
  public errorAngle = 0;

  /** Shared render-loop blend clock, in milliseconds, when the correction was taken. */
  public blendFrom = 0;

  /**
   * The entity already showed a pose when its first baseline arrived, and `from` holds it, for the
   * first baseline to blend from. Cleared once that baseline is taken.
   */
  public shown = false;

  /**
   * `Motion` is gone and the server streams the pose: this track only fades the difference between
   * the path it was drawn on and the streamed pose, then removes itself.
   */
  public handoff = false;

  /** Hand-off output position, allocated at most once and never shared with replication. */
  public position: Position | undefined = undefined;

  /** Hand-off output rotation, allocated at most once and never shared with replication. */
  public rotation: Rotation | undefined = undefined;

  /** Last network source position, x, in meters, without the fading offset. */
  public sourceX = 0;

  /** Last network source position, y, in meters, without the fading offset. */
  public sourceY = 0;

  /** Last network source angle, in radians, without the fading offset. */
  public sourceAngle = 0;

  /** The accepted baseline. */
  public readonly baseline = new Motion();

  /**
   * The body constants the baseline is stepped with: a copy of the entity's `MotionParams` (or the
   * defaults) taken when the baseline was accepted. A copy, so the per-frame path looks up no
   * component and the integrator's call sites only see one object shape.
   */
  public readonly params = new MotionParams();

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
    stepMotion(track.state, track.params, clock);
    motionPose(track.state, track.params, to);
    track.steps++;
  }
  const fraction = elapsed - steps;
  out.x = from.x + (to.x - from.x) * fraction;
  out.y = from.y + (to.y - from.y) * fraction;
  out.angle = from.angle + wrapAngle(to.angle - from.angle) * fraction;
}

/**
 * Put the track back at its baseline: `from` at the baseline, `to` one step later. A baseline at
 * rest bypasses the integrator: the track holds exactly the baseline's `x`, `y` and `angle`, not a
 * pose derived through the center of mass and `atan2`.
 */
function restart(track: MotionTrack, clock: Readonly<MotionClock>): void {
  track.steps = 0;
  if (track.rest) {
    const baseline = track.baseline;
    track.from.x = track.to.x = baseline.x;
    track.from.y = track.to.y = baseline.y;
    track.from.angle = track.to.angle = baseline.angle;
    return;
  }
  const params = track.params;
  motionStateFrom(track.baseline, params, track.state);
  motionPose(track.state, params, track.from);
  stepMotion(track.state, params, clock);
  motionPose(track.state, params, track.to);
}

function copyMotion(source: Readonly<Motion>, target: Motion): void {
  target.frame = source.frame;
  target.x = source.x;
  target.y = source.y;
  target.angle = source.angle;
  target.vx = source.vx;
  target.vy = source.vy;
  target.w = source.w;
  target.rest = source.rest;
}

/** `angle` moved into [-π, π] by whole turns. */
function wrapAngle(angle: number): number {
  return angle > Math.PI || angle < -Math.PI ? angle - TWO_PI * Math.round(angle / TWO_PI) : angle;
}

function requireNetworkComponents(world: ClientWorld): void {
  const registered = (Class: unknown): boolean =>
    world.networkComponents.some((component) => component.Class === Class);
  if (!registered(Motion) || !registered(MotionParams) || !registered(MotionClock)) {
    throw new Error(
      "DeadReckonedModule needs Motion, MotionParams and MotionClock in the ClientWorld's networkComponents: append phaserMotionComponents, as the server does"
    );
  }
}
