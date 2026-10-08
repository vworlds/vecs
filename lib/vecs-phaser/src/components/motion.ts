import { wireType, type Decoder, type Encoder } from "@vworlds/vecs-wire";

/**
 * Dead-reckoning baseline of a body: its pose and velocities at a server frame, plus the body
 * constants the shared integrator needs to extrapolate it (see `stepMotion`).
 *
 * A peer that holds a `Motion` and the world's {@link MotionClock} predicts the body's pose at any
 * later frame without further traffic, so the server only sends a new `Motion` when the body leaves
 * the predicted path. Every `Motion` is a complete baseline: the replication history keeps only the
 * newest snapshot of a component, so a partial one would lose fields.
 *
 * `x`, `y` and `angle` are the body origin and angle, as the physics pose holds them. `vx` and `vy`
 * are the linear velocity of the center of mass, and `w` the angular velocity, as Box2D reports
 * them. The local center is the center of mass in body coordinates.
 *
 * The codec is hand-written so that default constants cost nothing. It writes `frame` as a varint
 * u32, the six always-present f32 values, a one-byte mask and then the groups the mask lists:
 *
 * | Mask bit | Group | Present when |
 * | --- | --- | --- |
 * | 0 | `linearDamping`, `angularDamping` (2 × f32) | either is non-zero |
 * | 1 | `localCenterX`, `localCenterY` (2 × f32) | either is non-zero |
 * | 2 | `gravityScale` (f32) | it is not 1 |
 * | 3 | none: the bit is `allowFastRotation` | it is true |
 *
 * An absent group decodes to its default: zeros, a gravity scale of 1. Every f32 decodes to exactly
 * the value encoded, so values that are already f32 survive a round trip unchanged; other numbers
 * are rounded to the nearest f32.
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

  /** Linear velocity of the center of mass, x, in meters per second. */
  public vx = 0;

  /** Linear velocity of the center of mass, y, in meters per second. */
  public vy = 0;

  /** Angular velocity in radians per second. */
  public w = 0;

  /** Box2D linear damping of the body, per second. Sent only when it or `angularDamping` is set. */
  public linearDamping = 0;

  /** Box2D angular damping of the body, per second. Sent only when it or `linearDamping` is set. */
  public angularDamping = 0;

  /** Center of mass in body coordinates, x, in meters. Sent only when the center is off the origin. */
  public localCenterX = 0;

  /** Center of mass in body coordinates, y, in meters. Sent only when the center is off the origin. */
  public localCenterY = 0;

  /**
   * Multiplier on the world gravity for this body, as Box2D applies it. Sent only when it is not 1.
   *
   * Box2D applies no gravity to a body without mass (`invMass == 0`), whatever its scale, and the
   * integrator cannot tell such a body apart: set 0 here for a kinematic body.
   */
  public gravityScale = 1;

  /** Box2D's `allowFastRotation`: the body is exempt from the cap on rotation per step. One mask bit. */
  public allowFastRotation = false;

  /**
   * Decode a `Motion` written by {@link Motion.wireEncode}.
   *
   * @param decoder The decoder positioned at the encoded `Motion`.
   * @returns A new `Motion`, with defaults for the groups the mask leaves out.
   */
  public static wireDecode(decoder: Decoder): Motion {
    const motion = new Motion();
    motion.frame = decoder.read_u32();
    motion.x = decoder.read_f32();
    motion.y = decoder.read_f32();
    motion.angle = decoder.read_f32();
    motion.vx = decoder.read_f32();
    motion.vy = decoder.read_f32();
    motion.w = decoder.read_f32();
    const mask = decoder.read_u8();
    if ((mask & MOTION_DAMPING) !== 0) {
      motion.linearDamping = decoder.read_f32();
      motion.angularDamping = decoder.read_f32();
    }
    if ((mask & MOTION_LOCAL_CENTER) !== 0) {
      motion.localCenterX = decoder.read_f32();
      motion.localCenterY = decoder.read_f32();
    }
    if ((mask & MOTION_GRAVITY_SCALE) !== 0) {
      motion.gravityScale = decoder.read_f32();
    }
    motion.allowFastRotation = (mask & MOTION_FAST_ROTATION) !== 0;
    return motion;
  }

  /**
   * Encode this baseline: `frame`, the always-present values, the mask and the present groups.
   *
   * @param encoder The encoder to write to.
   */
  public wireEncode(encoder: Encoder): void {
    const hasDamping = this.linearDamping !== 0 || this.angularDamping !== 0;
    const hasLocalCenter = this.localCenterX !== 0 || this.localCenterY !== 0;
    const hasGravityScale = this.gravityScale !== 1;
    encoder.write_u32(this.frame);
    encoder.write_f32(this.x);
    encoder.write_f32(this.y);
    encoder.write_f32(this.angle);
    encoder.write_f32(this.vx);
    encoder.write_f32(this.vy);
    encoder.write_f32(this.w);
    encoder.write_u8(
      (hasDamping ? MOTION_DAMPING : 0) |
        (hasLocalCenter ? MOTION_LOCAL_CENTER : 0) |
        (hasGravityScale ? MOTION_GRAVITY_SCALE : 0) |
        (this.allowFastRotation ? MOTION_FAST_ROTATION : 0)
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

/** {@link Motion} mask bit: the damping pair follows. */
const MOTION_DAMPING = 1;

/** {@link Motion} mask bit: the local center follows. */
const MOTION_LOCAL_CENTER = 2;

/** {@link Motion} mask bit: the gravity scale follows. */
const MOTION_GRAVITY_SCALE = 4;

/** {@link Motion} mask bit: `allowFastRotation` is set. It carries no payload. */
const MOTION_FAST_ROTATION = 8;
