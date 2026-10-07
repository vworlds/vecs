import { Relationship } from "@vworlds/vecs";
import { tag, wireType } from "@vworlds/vecs-wire";

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
 * derived each frame from the target entity's interpolated `Position` plus
 * `Offset`.
 *
 * The parent is a renderable (no `Container`); the child stays on the scene
 * root (not inside a Phaser Container). A client-side system
 * (`phaser.resolve.offset`) computes the child's world `Position` from the
 * parent's interpolated `Position` + `Offset`. The offset is added as is, in
 * world axes: the parent's `Rotation` does not turn it, and the child's own
 * `Rotation` stays independent of the parent's. Add {@link InheritRotation} to
 * the child to put it in the parent's local frame instead. `DrawBy` auto-adds
 * `Position` on the client to store the computed value (the `Position` is
 * client-local, never networked).
 *
 * Configure with `CleanupPolicy.Remove` (not `Delete`): destroying a display
 * parent detaches children rather than destroying them. The child survives on
 * the scene root, and keeps the last pose it was resolved to.
 *
 * For native parenting (parent has `Container`, child added to the Phaser scene
 * graph), use `DrawIn` instead. `DrawIn` and `DrawBy` are exclusive via
 * `world.setExclusiveComponents`.
 */
export class DrawBy extends Relationship {}

/**
 * Opt-in tag that puts a {@link DrawBy} child in its parent's local frame, so
 * the child turns with its parent: a decal, a crack or a label that spins with
 * the body it is drawn on.
 *
 * Without the tag a `DrawBy` child only follows the parent's `Position`. With
 * it, the client resolver (`phaser.resolve.offset`) works in the parent's
 * frame, in the same pass that resolves the child's `Position`, so position
 * and rotation stay in lockstep on every frame, interpolated ones included.
 * With `a` the parent's `Rotation.angle` (the parent's interpolated rotation;
 * `0` when the parent has no `Rotation`):
 *
 * - the child's `Position` is the parent's `Position` plus the child's
 *   `Offset` rotated by `a`;
 * - the child's `Rotation` is `a + angle`, which the renderer applies to the
 *   child's GameObject like any other `Rotation`.
 *
 * `angle` is the child's own angle relative to its parent, in radians,
 * counter-clockwise positive like every angle in the render components. Leave
 * it `0` for a child that simply follows the parent's orientation. Parent and
 * child may both be tagged: the parent's `Rotation` already holds its derived
 * world angle, so angles add and offsets compose down the chain, and a chain
 * that mixes tagged and untagged children resolves parent-first in one pass,
 * with no frame of lag.
 *
 * The rules:
 *
 * - Adding the tag also adds a client-local `Rotation` that holds the derived
 *   angle, as `DrawBy` adds one for `Position`. It is derived, so writing or
 *   replicating `Rotation` on a tagged child is overwritten every frame.
 * - The tag does nothing while the entity has no `DrawBy`: nothing is derived,
 *   and an existing `Rotation` is left alone.
 * - Removing the tag returns the child to its own rotation: its `Rotation`
 *   becomes `angle`, now taken relative to the world, and its offset is no
 *   longer rotated.
 * - When `DrawBy` is removed (for example because the parent was destroyed, as
 *   `DrawBy` uses `CleanupPolicy.Remove`) the child keeps the pose it was last
 *   resolved to, tagged or not.
 *
 * `InheritRotation` is a wire type, but it is deliberately not part of
 * `phaserNetworkComponents`: that list's order is the wire protocol, and
 * appending to it shifts the wire ids of every application component listed
 * after it. The tag is meant to be client-local, added by client code; the
 * client-side resolver reads it wherever it comes from. An application that
 * wants the server to set it lists it in its own network component list, after
 * its existing components so none of their wire ids moves, on the server and
 * the client alike:
 *
 * ```ts
 * const networkComponents = [...phaserNetworkComponents, ...gameComponents, InheritRotation];
 * ```
 *
 * Only `DrawBy` children use it. A `DrawIn` child inherits its parent's
 * rotation natively, through the parent's Phaser `Container`.
 */
export class InheritRotation {
  /** The child's own angle relative to its parent, in radians, counter-clockwise positive. */
  @wireType("f32")
  public angle = 0;
}

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
