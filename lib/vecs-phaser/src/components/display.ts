import { tag } from "@vworlds/vecs-wire";
import { wireType } from "@vworlds/vecs-wire";

/**
 * Marker component: the entity's GameObject is not rendered while this tag is
 * present. Removing the tag shows the GameObject again.
 *
 * Hiding is presence-driven — the ECS way to toggle visibility without
 * destroying and recreating the renderable (respawn timers, blinking,
 * fog of war). Encodes to zero wire bytes; presence is the payload.
 */
@tag
export class Hidden {}

/**
 * Horizontal/vertical mirroring for textured renderables and text.
 *
 * Applies to GameObjects with Phaser's Flip mixin (`Image`, `Text`, and
 * future textured renderables). Primitive shapes do not support flipping;
 * adding `Flip` to a shape entity is a silent no-op by design (mirror shapes
 * with a negative `Scale` instead).
 */
export class Flip {
  /** Mirror horizontally. */
  @wireType("bool")
  public x = false;

  /** Mirror vertically. */
  @wireType("bool")
  public y = false;
}
