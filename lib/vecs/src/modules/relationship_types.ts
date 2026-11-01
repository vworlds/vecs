import { Relationship } from "../component_meta.js";
import { type Entity } from "../entity/index.js";

/** Built-in parent-child relationship. */
export class ChildOf extends Relationship {}

/** Built-in pipeline ordering relationship. */
export class DependsOn extends Relationship {}

/**
 * Built-in relationship marking a feedback **silence domain** for a query
 * or system.
 *
 * When a query carries a `SilenceSource` pointing at a query entity, it
 * ignores `update` notifications whose originating entity (the system
 * that wrote the component) is a member of that query. Configure it through
 * {@link Query.ignoreSource}.
 */
export class SilenceSource extends Relationship {}

/**
 * Pair-form trait: attaching `(With, Y)` to a component `X` makes adding `X`
 * to an entity automatically add `Y` as well.
 *
 * Plain form — `X` and `Y` are both non-relationship components:
 *
 * ```ts
 * world.component(Armor);
 * world.component(Helmet).add(With, world.component(Armor));
 * const e = world.entity().add(Helmet); // e also has Armor
 * ```
 *
 * Relationship form — `X` and `Y` are both relationships; the same target is
 * propagated:
 *
 * ```ts
 * world.component(OwnedBy);
 * world.component(WornBy).add(With, world.component(OwnedBy));
 * const wearer = world.entity();
 * const e = world.entity().add(WornBy, wearer); // e also has (OwnedBy, wearer)
 * ```
 *
 * `With` is irrevocable and rejects attach while `X` is already in use, so
 * configure it during world setup before any entity carries `X`.
 *
 * `With` only brings `Y` along: removing `X` leaves `Y` in place. Use
 * {@link Requires} when `Y` must leave with its last bringer.
 */
export class With extends Relationship {}

/**
 * Pair-form trait, the owning counterpart of {@link With}: attaching
 * `(Requires, Y)` to a plain component `X` adds `Y` whenever `X` is added, and
 * removes `Y` when `X` is removed, unless another component on the entity
 * still brings `Y` through `With` or `Requires`.
 *
 * ```ts
 * world.component(Motion);
 * world.component(DeadReckoned).add(Requires, world.component(Motion));
 * const e = world.entity().add(DeadReckoned); // e also has Motion
 * e.remove(DeadReckoned); // Motion goes too
 * ```
 *
 * - Adding `X` adds `Y` if absent, as `With` does; an existing `Y` is left as it is.
 * - Removing `X` from a live entity removes `Y` unless another present
 *   component brings it. A `Y` the entity got some other way still goes:
 *   `Requires` counts bringers, not how `Y` arrived.
 * - Destroying the entity does nothing extra.
 * - Replacing `X` through `attach` keeps `Y`.
 * - In deferred mode the removal of `Y` is queued when the removal of `X`
 *   applies, so a re-add of `X` later in the same flush brings `Y` back.
 *
 * Both `X` and `Y` must be plain components. `Requires` is irrevocable and
 * rejects attach while `X` is already in use, so configure it during world
 * setup before any entity carries `X`.
 */
export class Requires extends Relationship {}

/**
 * Pair-form trait constraining the targets of a relationship to direct
 * children (via {@link ChildOf}) of a specified parent entity.
 *
 * Self/enum form — the relationship's own entity is the parent. A faction
 * diplomacy alignment enum is a natural fit: every `Alignment` target must be
 * a declared alignment value.
 *
 * ```ts
 * class Alignment extends Relationship {}
 * const alignment = world.component(Alignment).add(OneOf, world.component(Alignment));
 * const good = world.entity().childOf(alignment);
 * const evil = world.entity().childOf(alignment);
 * const weather = world.entity();
 * world.entity().add(Alignment, good);    // ok: good is a child of Alignment
 * world.entity().add(Alignment, weather); // throws: weather is not a child of Alignment
 * ```
 *
 * Other-parent form — a different entity is the parent:
 *
 * ```ts
 * class ResidesIn extends Relationship {}
 * class Region extends Relationship {}
 * world.component(ResidesIn).add(OneOf, world.component(Region));
 * const forest = world.entity().childOf(world.component(Region));
 * const weather = world.entity();
 * world.entity().add(ResidesIn, forest);  // ok: forest is a child of Region
 * world.entity().add(ResidesIn, weather); // throws: weather is not a child of Region
 * ```
 *
 * `OneOf` is irrevocable and rejects attach while the relationship is already
 * in use, so configure it during world setup before any entity carries an
 * edge through the relationship.
 */
export class OneOf extends Relationship {}

/** Marker trait restricting a relationship to one target. */
export class Exclusive {}

/**
 * Marker component that makes every explicit target of a relationship a `ChildOf` child
 * of the relationship source.
 *
 * Add during world setup, before creating relationship instances:
 *
 * ```ts
 * world.component(Inventory).add(OwnedTarget);
 * player.add(Inventory, inventory);
 * ```
 *
 * The relationship must also carry {@link Exclusive}. Removing or replacing an
 * edge destroys its target.
 */
export class OwnedTarget {}

/**
 * Marker component used to tag a relationship component as traversable.
 *
 * Attach to a relationship-component entity (e.g. `ChildOf`) to enable
 * automatic depth tracking: every entity carrying the tagged relationship
 * gets a depth entry whose value is the number of hops to the nearest root
 * (zero for roots).
 *
 * ```ts
 * world.component(ChildOf).add(Traversable);
 * ```
 *
 * The depth map is maintained reactively by {@link RelationshipsModule}.
 */
export class Traversable {
  /** Entity to depth (hops to root, 0-based). */
  depths = new Map<Entity, number>();
}
