import { Relationship } from "@vworlds/vecs";
import { tag } from "@vworlds/vecs-wire";

/**
 * Display-hierarchy relationship: this entity draws inside the target entity.
 *
 * Networked counterpart to the server-local `ChildOf` for render-layer
 * parenting. Use `ChildOf` for ownership/lifecycle (collider shapes, bullets
 * belonging to a player) — it stays server-side. Use `DrawIn` when the client
 * needs to know the display parent to build the Phaser scene graph.
 *
 * Configure with `CleanupPolicy.Remove` (not `Delete`): destroying a display
 * parent detaches children rather than destroying them. The reparent system
 * re-adds orphaned children to the scene root.
 */
export class DrawIn extends Relationship {}

/**
 * Marker component: the entity renders as a Phaser {@link Phaser.GameObjects.Container},
 * not a renderable shape. Exclusive with all renderable components (`Arc`, `Image`, …).
 *
 * Add this to entities that have children via `DrawIn` so those children can be
 * reparented into the Container for native scene-graph transform composition. The
 * entity's own visual (if any) moves to a separate `DrawIn` sub-entity.
 *
 * Registered as a presence-only wire tag: it encodes to zero bytes and its mere
 * presence on an entity is the payload.
 */
@tag
export class Container {}
