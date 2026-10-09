import { wireType, type Decoder, type Encoder } from "@vworlds/vecs-wire";

/**
 * Dead-reckoning baseline of a body: its pose and velocities at a server frame, or the pose the
 * body is held at.
 *
 * A peer that holds a `Motion`, the entity's {@link MotionParams} and the world's {@link MotionClock}
 * predicts the body's pose at any later frame without further traffic, so the server only sends a
 * new `Motion` when the body leaves the predicted path. Every `Motion` is a complete baseline: the
 * replication history keeps only the newest snapshot of a component, so a partial one would lose
 * fields. The body constants the integrator also needs live in `MotionParams`, which the server
 * sends only when they change instead of with every baseline.
 *
 * `x`, `y` and `angle` are the body origin and angle, as the physics pose holds them. `vx` and `vy`
 * are the linear velocity of the center of mass, and `w` the angular velocity, as Box2D reports
 * them. When {@link Motion.rest} is set the body is held at the pose and the velocities are zero.
 *
 * The codec is hand-written so that a body at rest costs no velocities. It writes `frame` as a
 * varint u32, a flags byte, the three pose values as f32 and, unless the body is at rest, the three
 * velocities as f32:
 *
 * | Flags bit | Meaning                                          |
 * | --------- | ------------------------------------------------ |
 * | 0         | `rest`: held at the pose, no velocities are sent |
 *
 * That is 14 bytes at rest and 26 bytes moving, with a frame below 128. Every f32 decodes to
 * exactly the value encoded, so values that are already f32 survive a round trip unchanged; other
 * numbers are rounded to the nearest f32. A baseline at rest decodes with zero velocities.
 *
 * Not part of `phaserNetworkComponents`: an application that uses dead reckoning appends
 * {@link phaserMotionComponents} to its own network components, after its existing entries, so no
 * wire id shifts.
 */
export class Motion {
  /** Server frame the baseline was taken at. */
  public frame = 0;

  /** Body origin, x, in meters. */
  public x = 0;

  /** Body origin, y, in meters. */
  public y = 0;

  /** Body angle in radians, counter-clockwise positive. */
  public angle = 0;

  /** Linear velocity of the center of mass, x, in meters per second. Zero at rest. */
  public vx = 0;

  /** Linear velocity of the center of mass, y, in meters per second. Zero at rest. */
  public vy = 0;

  /** Angular velocity in radians per second. Zero at rest. */
  public w = 0;

  /**
   * The baseline holds the body still: peers hold its pose and never step it, and the velocities are
   * not sent. The sender decides it (a sleeping body, or one that has no velocity and that nothing
   * accelerates), so a peer never works it out from the velocities and the gravity.
   */
  public rest = false;

  /**
   * Decode a `Motion` written by {@link Motion.wireEncode}.
   *
   * @param decoder The decoder positioned at the encoded `Motion`.
   * @returns A new `Motion`, with zero velocities when the flags say it is at rest.
   */
  public static wireDecode(decoder: Decoder): Motion {
    const motion = new Motion();
    motion.frame = decoder.read_u32();
    motion.rest = (decoder.read_u8() & MOTION_REST) !== 0;
    motion.x = decoder.read_f32();
    motion.y = decoder.read_f32();
    motion.angle = decoder.read_f32();
    if (!motion.rest) {
      motion.vx = decoder.read_f32();
      motion.vy = decoder.read_f32();
      motion.w = decoder.read_f32();
    }
    return motion;
  }

  /**
   * Encode this baseline: `frame`, the flags, the pose and, unless it is at rest, the velocities.
   *
   * @param encoder The encoder to write to.
   */
  public wireEncode(encoder: Encoder): void {
    encoder.write_u32(this.frame);
    encoder.write_u8(this.rest ? MOTION_REST : 0);
    encoder.write_f32(this.x);
    encoder.write_f32(this.y);
    encoder.write_f32(this.angle);
    if (!this.rest) {
      encoder.write_f32(this.vx);
      encoder.write_f32(this.vy);
      encoder.write_f32(this.w);
    }
  }
}

/**
 * The constants of a body that the shared integrator needs besides its {@link Motion}: damping,
 * center of mass, gravity scale and Box2D's `allowFastRotation`, as Box2D holds them.
 *
 * They change rarely, so the server sends a `MotionParams` only when a body's constants differ from
 * what its entity already carries, and a peer steps every later `Motion` of that entity with the
 * last one it received. **An entity without a `MotionParams` has the defaults**: no damping, the
 * center of mass at the body origin, a gravity scale of 1 and no fast rotation.
 * {@link defaultMotionParams} holds them for a caller whose entity has none. A body that never
 * leaves the defaults, such as a bullet, never carries the component.
 *
 * `localCenterX` and `localCenterY` are the center of mass in body coordinates. Box2D applies no
 * gravity to a body without mass (`invMass == 0`), whatever its scale, and the integrator cannot
 * tell such a body apart: a sender sets `gravityScale` to 0 for a kinematic body.
 *
 * The codec is hand-written so that default constants cost nothing. It writes a one-byte mask and
 * then the groups the mask lists:
 *
 * | Mask bit | Group                                       | Present when       |
 * | -------- | ------------------------------------------- | ------------------ |
 * | 0        | `linearDamping`, `angularDamping` (2 × f32) | either is non-zero |
 * | 1        | `localCenterX`, `localCenterY` (2 × f32)    | either is non-zero |
 * | 2        | `gravityScale` (f32)                        | it is not 1        |
 * | 3        | none: the bit is `allowFastRotation`        | it is true         |
 *
 * That is 1 byte for the defaults and 21 with every group. An absent group decodes to its default.
 * Every f32 decodes to exactly the value encoded, so values that are already f32 survive a round
 * trip unchanged; other numbers are rounded to the nearest f32.
 *
 * Not part of `phaserNetworkComponents`; see {@link phaserMotionComponents}.
 */
export class MotionParams {
  /** Box2D linear damping of the body, per second. Sent only when it or `angularDamping` is set. */
  public linearDamping = 0;

  /** Box2D angular damping of the body, per second. Sent only when it or `linearDamping` is set. */
  public angularDamping = 0;

  /** Center of mass in body coordinates, x, in meters. Sent only when the center is off the origin. */
  public localCenterX = 0;

  /** Center of mass in body coordinates, y, in meters. Sent only when the center is off the origin. */
  public localCenterY = 0;

  /**
   * Multiplier on the world gravity for this body, as Box2D applies it; 0 for a body without mass.
   * Sent only when it is not 1.
   */
  public gravityScale = 1;

  /** Box2D's `allowFastRotation`: the body is exempt from the cap on rotation per step. One mask bit. */
  public allowFastRotation = false;

  /**
   * Decode a `MotionParams` written by {@link MotionParams.wireEncode}.
   *
   * @param decoder The decoder positioned at the encoded `MotionParams`.
   * @returns A new `MotionParams`, with defaults for the groups the mask leaves out.
   */
  public static wireDecode(decoder: Decoder): MotionParams {
    const params = new MotionParams();
    const mask = decoder.read_u8();
    if ((mask & PARAMS_DAMPING) !== 0) {
      params.linearDamping = decoder.read_f32();
      params.angularDamping = decoder.read_f32();
    }
    if ((mask & PARAMS_LOCAL_CENTER) !== 0) {
      params.localCenterX = decoder.read_f32();
      params.localCenterY = decoder.read_f32();
    }
    if ((mask & PARAMS_GRAVITY_SCALE) !== 0) {
      params.gravityScale = decoder.read_f32();
    }
    params.allowFastRotation = (mask & PARAMS_FAST_ROTATION) !== 0;
    return params;
  }

  /**
   * Encode these constants: the mask and the groups that differ from the defaults.
   *
   * @param encoder The encoder to write to.
   */
  public wireEncode(encoder: Encoder): void {
    const hasDamping = this.linearDamping !== 0 || this.angularDamping !== 0;
    const hasLocalCenter = this.localCenterX !== 0 || this.localCenterY !== 0;
    const hasGravityScale = this.gravityScale !== 1;
    encoder.write_u8(
      (hasDamping ? PARAMS_DAMPING : 0) |
        (hasLocalCenter ? PARAMS_LOCAL_CENTER : 0) |
        (hasGravityScale ? PARAMS_GRAVITY_SCALE : 0) |
        (this.allowFastRotation ? PARAMS_FAST_ROTATION : 0)
    );
    if (hasDamping) {
      encoder.write_f32(this.linearDamping);
      encoder.write_f32(this.angularDamping);
    }
    if (hasLocalCenter) {
      encoder.write_f32(this.localCenterX);
      encoder.write_f32(this.localCenterY);
    }
    if (hasGravityScale) {
      encoder.write_f32(this.gravityScale);
    }
  }
}

/**
 * The constants of an entity that carries no {@link MotionParams}: one shared, frozen instance of
 * the defaults, to read or to copy from. Never write to it, and do not hand it to the integrator
 * directly: copy it into a `MotionParams` of your own first, so the integrator's call sites only
 * ever see one object shape.
 */
export const defaultMotionParams: Readonly<MotionParams> = Object.freeze(new MotionParams());

/**
 * Copy every constant of `source` into `target`, field by field, without allocating.
 *
 * Both peers keep a private `MotionParams` per body, taken from the entity's component (or from
 * {@link defaultMotionParams}) when a baseline is written or accepted, so the per-step path looks
 * up no component and the integrator only ever sees one object shape. This is that copy.
 *
 * @param source The constants to read; {@link defaultMotionParams} is fine.
 * @param target The `MotionParams` to overwrite. Never the frozen defaults.
 */
export function copyMotionParams(source: Readonly<MotionParams>, target: MotionParams): void {
  target.linearDamping = source.linearDamping;
  target.angularDamping = source.angularDamping;
  target.localCenterX = source.localCenterX;
  target.localCenterY = source.localCenterY;
  target.gravityScale = source.gravityScale;
  target.allowFastRotation = source.allowFastRotation;
}

/**
 * The world constants the shared integrator steps a {@link Motion} with: the physics step, its
 * substeps, the gravity and the speed cap, as the server's Box2D world uses them.
 *
 * One entity in the world carries it, sent once with the baseline. Its defaults are Box2D's and
 * `PhysicsModule`'s, except gravity, which defaults to none here.
 *
 * Not part of `phaserNetworkComponents`; see {@link phaserMotionComponents}.
 */
export class MotionClock {
  /** Duration of one physics step, in seconds (`PhysicsModule`'s `fixedTimeStep`). */
  @wireType("f32")
  public stepSeconds = 1 / 60;

  /** Box2D substeps per physics step (`PhysicsModule`'s `subSteps`). */
  @wireType("u8")
  public subSteps = 4;

  /** World gravity, x, in meters per second squared. */
  @wireType("f32")
  public gravityX = 0;

  /** World gravity, y, in meters per second squared. */
  @wireType("f32")
  public gravityY = 0;

  /** Box2D's maximum linear speed, in meters per second (`PhysicsModule`'s `maximumLinearSpeed`). */
  @wireType("f32")
  public maxLinearSpeed = 400;
}

/** {@link Motion} flags bit: the body is at rest, so the velocities are not sent. */
const MOTION_REST = 1;

/** {@link MotionParams} mask bit: the damping pair follows. */
const PARAMS_DAMPING = 1;

/** {@link MotionParams} mask bit: the local center follows. */
const PARAMS_LOCAL_CENTER = 2;

/** {@link MotionParams} mask bit: the gravity scale follows. */
const PARAMS_GRAVITY_SCALE = 4;

/** {@link MotionParams} mask bit: `allowFastRotation` is set. It carries no payload. */
const PARAMS_FAST_ROTATION = 8;
