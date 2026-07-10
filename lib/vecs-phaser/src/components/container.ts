import { wireType } from "@vworlds/vecs-wire";

export { ChildOf } from "@vworlds/vecs";

/**
 * Marker component: the entity renders as a Phaser {@link Phaser.GameObjects.Container},
 * not a renderable shape. Exclusive with all renderable components (`Arc`, `Image`, …).
 *
 * Add this to entities that have children via `ChildOf` so those children can be
 * reparented into the Container for native scene-graph transform composition. The
 * entity's own visual (if any) moves to a separate `ChildOf` sub-entity.
 *
 * Carries a single placeholder wire field so the wire codec can serialise its
 * presence/absence. The value is always 0 and carries no semantic meaning.
 */
export class Container {
  @wireType("u8")
  public placeholder = 0;
}
