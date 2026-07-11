import { Relationship } from "@vworlds/vecs";
import { tag } from "@vworlds/vecs-wire";

/**
 * Native display-parenting relationship: this entity is a child of the target
 * entity's Phaser {@link Phaser.GameObjects.Container}.
 *
 * The child's Phaser GameObject is added to the parent Container so Phaser
 * composes transforms natively — moving/rotating the Container moves/rotates
 * all children. `Offset` sets the child's local position inside the container.
 * Zero per-frame JS. The child must NOT have a `Position` component: native
 * children never get world-coords-as-local.
 *
 * Networked counterpart to the server-local `ChildOf` for render-layer
 * parenting. Use `ChildOf` for ownership/lifecycle (collider shapes, bullets
 * belonging to a player) — it stays server-side. Use `DrawIn` when the client
 * needs to know the display parent to build the Phaser scene graph.
 *
 * Configure with `CleanupPolicy.Remove` (not `Delete`): destroying a display
 * parent detaches children rather than destroying them. The reparent system
 * re-adds orphaned children to the scene root.
 *
 * For computed parenting (parent is a renderable, child's world `Position`
 * derived each frame), use `DrawBy` instead. `DrawIn` and `DrawBy` are
 * exclusive via `world.setExclusiveComponents`.
 */
export class DrawIn extends Relationship {}

/**
 * Computed display-parenting relationship: this entity's world `Position` is
 * derived each frame from the target entity's interpolated `Position` plus a
 * rotated `Offset`.
 *
 * The parent is a renderable (no `Container`); the child stays on the scene
 * root (not inside a Phaser Container). A client-side system
 * (`phaser.resolve.offset`) computes the child's world `Position` from the
 * parent's interpolated `Position` + `Offset` rotated by the parent's
 * `Rotation`. `DrawBy` auto-adds `Position` on the client to store the computed
 * value (the `Position` is client-local, never networked).
 *
 * Configure with `CleanupPolicy.Remove` (not `Delete`): destroying a display
 * parent detaches children rather than destroying them. The child survives on
 * the scene root.
 *
 * For native parenting (parent has `Container`, child added to the Phaser scene
 * graph), use `DrawIn` instead. `DrawIn` and `DrawBy` are exclusive via
 * `world.setExclusiveComponents`.
 */
export class DrawBy extends Relationship {}

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
