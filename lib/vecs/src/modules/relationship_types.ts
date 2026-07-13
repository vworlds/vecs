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
 * Marker component that makes every target of a relationship a `ChildOf` child
 * of the relationship source.
 *
 * Add during world setup, before creating relationship instances:
 *
 * ```ts
 * world.component(Inventory).add(OwnedTarget);
 * ```
 *
 * Ownership is sticky: retargeting or removing the marked relationship does
 * not remove `ChildOf` from targets it previously owned.
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
