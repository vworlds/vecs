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
 */
export class With extends Relationship {}

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

/**
 * Pair-form trait choosing what happens to an entity's carriers when that
 * entity, used as a component key, is destroyed.
 *
 * Attach it to the component entity; its target is one of the policy values
 * {@link Throw} (the default), {@link Remove}, or {@link Delete}. It is
 * exclusive, so adding another policy replaces the current one, and removing
 * the edge restores the default.
 *
 * ```ts
 * world.component(Temporary).add(OnDelete, Remove);
 * world.component(Temporary).destroy(); // strips Temporary from every carrier
 * ```
 */
export class OnDelete extends Relationship {}

/**
 * Pair-form trait choosing what happens to the sources of a relationship edge
 * when the edge's target is destroyed.
 *
 * Attach it to the relationship's component entity; its target is
 * {@link Remove} (the default) or {@link Delete}. It is exclusive, so adding
 * another policy replaces the current one, and removing the edge restores the
 * default.
 *
 * ```ts
 * world.component(InRoom).add(OnDeleteTarget, Delete);
 * room.destroy(); // destroys every entity with (InRoom, room)
 * ```
 */
export class OnDeleteTarget extends Relationship {}

/**
 * Cleanup policy value for {@link OnDelete}: destroying the component entity
 * while other entities carry it throws. The default for {@link OnDelete}; not
 * accepted by {@link OnDeleteTarget}.
 */
export class Throw {}

/**
 * Cleanup policy value: remove only the component or edge. Under
 * {@link OnDelete} every carrier loses the component; under
 * {@link OnDeleteTarget} (the default) each source loses only the edge to the
 * destroyed target.
 */
export class Remove {}

/**
 * Cleanup policy value: destroy the dependent entities. Under {@link OnDelete}
 * every carrier is destroyed; under {@link OnDeleteTarget} every source with an
 * edge to the destroyed target is destroyed.
 */
export class Delete {}
