import { wireType } from "@vworlds/vecs-wire";

/**
 * One-shot particle burst at the entity's `Position` — the flagship of the
 * client-expansion pattern: one small component crosses the wire; the client
 * expands it into a Phaser particle emitter. No per-particle replication.
 *
 * The client fires a burst on every **set** (including entry) and disposes
 * the emitter after the particles die; the entity itself is typically a
 * short-lived effect entity (`ParticleBurst` + server `Lifetime`).
 */
export class ParticleBurst {
  /** Resource id of the particle texture (spritesheet/tileset). */
  @wireType("u32")
  public texture = 0;

  /** Frame index within the texture. */
  @wireType("u16")
  public frame = 0;

  /** Number of particles in the burst. */
  @wireType("u16")
  public count = 16;

  /** Maximum particle speed in meters/second (particles spread 50–100%). */
  @wireType("f32")
  public speed = 2;

  /** Particle lifetime in milliseconds. */
  @wireType("u16")
  public lifespanMs = 500;

  /** Initial particle scale (shrinks to 0 over the lifetime). */
  @wireType("f32")
  public scale = 1;

  /** Downward acceleration in meters/second² (math convention: negative = down). */
  @wireType("f32")
  public gravityY = 0;

  /** Multiplicative tint (white = untinted). */
  @wireType("u32")
  public tint = 0xffffff;
}
