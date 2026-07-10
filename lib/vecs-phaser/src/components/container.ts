import { tag } from "@vworlds/vecs-wire";

export { ChildOf } from "@vworlds/vecs";

/**
 * Marker component: the entity renders as a Phaser {@link Phaser.GameObjects.Container},
 * not a renderable shape. Exclusive with all renderable components (`Arc`, `Image`, …).
 *
 * Add this to entities that have children via `ChildOf` so those children can be
 * reparented into the Container for native scene-graph transform composition. The
 * entity's own visual (if any) moves to a separate `ChildOf` sub-entity.
 *
 * Registered as a presence-only wire tag: it encodes to zero bytes and its mere
 * presence on an entity is the payload.
 */
@tag
export class Container {}
