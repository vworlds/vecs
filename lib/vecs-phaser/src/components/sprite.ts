import { wireType } from "@vworlds/vecs-wire";

/**
 * Animated textured renderable. Like {@link Image} but rendered as a Phaser
 * `Sprite`, so it can play tileset animations via the {@link Animation}
 * component. Without `Animation` it shows the static `frame`, exactly like
 * an `Image`.
 */
export class Sprite {
  /** Resource id of the source texture (spritesheet/tileset). */
  @wireType("u32")
  public texture = 0;

  /** Frame shown while no {@link Animation} is playing. */
  @wireType("u16")
  public frame = 0;
}

/**
 * Plays a tileset animation on the entity's {@link Sprite}: presence means
 * playing (looped), removal stops it and restores `Sprite.frame`.
 *
 * `tile` is the Tiled tile id that owns the animation (the client registers
 * every animated tile of a spritesheet as `"<textureId>:<tileId>"` during
 * `loadAssets`). Retargeting `tile` switches animations; changing `speed`
 * adjusts playback without restarting.
 */
export class Animation {
  /** Tiled tile id whose animation plays (also its spritesheet frame index). */
  @wireType("u16")
  public tile = 0;

  /** Playback-rate multiplier (1 = authored Tiled durations). */
  @wireType("f32")
  public speed = 1;
}
