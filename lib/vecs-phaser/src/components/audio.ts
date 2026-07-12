import { wireType } from "@vworlds/vecs-wire";

/**
 * One-shot sound effect: the client plays the referenced audio asset every
 * time this component is **set** (including entry). Typical patterns:
 *
 * - A short-lived effect entity: create with `Sound` (+ a server `Lifetime`)
 *   and let the entity expire.
 * - Re-set on a live entity to re-trigger (e.g. a fire sound on each shot).
 *
 * Like `CameraShake`, a baseline resend replays the latest set — prefer
 * short-lived entities for one-shots so late joiners hear nothing.
 */
export class Sound {
  /** Resource id of the audio asset in the catalog. */
  @wireType("u32")
  public asset = 0;

  /** Volume 0..1. */
  @wireType("f32")
  public volume = 1;

  /** Playback-rate multiplier (1 = normal pitch/speed). */
  @wireType("f32")
  public rate = 1;
}

/**
 * Looping/background audio: plays while the component is present, stops on
 * removal (or entity destruction/baseline reset). One playback per entity;
 * `volume`/`loop` changes apply to the live playback without restarting.
 */
export class Music {
  /** Resource id of the audio asset in the catalog. */
  @wireType("u32")
  public asset = 0;

  /** Volume 0..1. */
  @wireType("f32")
  public volume = 1;

  /** Whether playback loops (default true). */
  @wireType("bool")
  public loop = true;
}
