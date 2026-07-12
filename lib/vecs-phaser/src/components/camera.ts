import { Relationship } from "@vworlds/vecs";
import { wireType } from "@vworlds/vecs-wire";

/**
 * Camera-follow relationship: the target entity is what this client's camera
 * tracks. Set by the server on the client's **session entity** (the entity
 * carrying `NetworkClient` server-side); the client resolves its own session
 * entity via `ClientWorld.sessionEntity()` and ignores camera components on
 * any other entity — every client only obeys its own session's camera.
 *
 * The camera centers on the target's interpolated `Position` each frame.
 * `lerp` smooths the chase: 1 locks the camera to the target, lower values
 * ease toward it (fraction of the remaining distance per tick).
 *
 * The session entity must be inside the client's `View` for camera
 * components to replicate — include session entities in the view DSL.
 */
export class CameraFollow extends Relationship {
  /** Fraction of the remaining distance covered per tick (0..1; 1 = locked). */
  @wireType("f32")
  public lerp = 1;
}

/** Camera zoom multiplier (1 = 1:1 pixels; 2 doubles the on-screen size). */
export class CameraZoom {
  @wireType("f32")
  public value = 1;
}

/**
 * World-space scroll limits for the camera, in meters. `x`/`y` is the
 * **bottom-left corner** (math convention, +y up) and `width`/`height`
 * extend right/up. The client converts to Phaser's y-down bounds rectangle.
 * Removing the component lifts the limits.
 */
export class CameraBounds {
  /** Bottom-left corner X in meters. */
  @wireType("f32")
  public x = 0;

  /** Bottom-left corner Y in meters. */
  @wireType("f32")
  public y = 0;

  /** Extent to the right in meters. */
  @wireType("f32")
  public width = 0;

  /** Extent upward in meters. */
  @wireType("f32")
  public height = 0;
}

/**
 * One-shot camera shake, triggered every time the component is **set** (a
 * baseline resend also replays the latest set — keep `duration` short, or
 * remove the component a few ticks after setting it so late joiners see
 * nothing).
 */
export class CameraShake {
  /** Shake duration in seconds. */
  @wireType("f32")
  public duration = 0.25;

  /** Shake intensity as a fraction of the viewport (Phaser convention). */
  @wireType("f32")
  public intensity = 0.01;
}
