import { CleanupPolicy, Relationship } from "../component_meta.js";
import { type Entity } from "../entity/index.js";
import { Module } from "../module.js";
import { Exclusive, OneOf } from "./relationship_types.js";

/**
 * Built-in exclusive relationship modeling prototype-style entity
 * inheritance.
 *
 * Adding `(IsA, template)` to an entity walks the template's ordinary
 * components and attaches each onto the inheritor according to that
 * component's `OnInstantiate` policy: copy (`Override`, the default),
 * dirty-on-write proxy (`Inherit`), or skip (`DontInherit`).
 *
 * `IsA` is exclusive (one template per inheritor) and does not allow
 * retargeting — add a different template only after removing the existing
 * edge.
 *
 * Destroying the template removes the `IsA` edge from each inheritor;
 * inherited components stay on the inheritor. Proxies that pointed at the
 * template's instances keep reading the last-known values (a documented
 * stale-proxy caveat).
 */
export class IsA extends Relationship {}

/**
 * Built-in self-parent `OneOf` enum relationship that declares the `IsA`
 * inheritance policy for a component class.
 *
 * Attach during world setup as `world.component(C).add(OnInstantiate, option)`
 * where `option` is one of the exported {@link Override}, {@link Inherit}, or
 * {@link DontInherit} entities (all `ChildOf` children of the `OnInstantiate`
 * component entity). The default policy when no `OnInstantiate` edge is
 * present is `Override`.
 *
 * `OnInstantiate` is irrevocable via the `OneOf` trait: re-adding with a
 * different option atomically replaces the edge (and updates the policy read
 * on subsequent `IsA` additions); removing the edge throws.
 */
export class OnInstantiate extends Relationship {}

/**
 * The default `OnInstantiate` policy: copy the template's instance onto the
 * inheritor. Re-exported as a per-world entity; assigned by
 * {@link InheritanceModule.init}.
 */
export let Override: Entity;

/**
 * The `OnInstantiate` policy that attaches a dirty-on-write proxy of the
 * template's instance onto the inheritor. Reads delegate to the template
 * while clean; the first write snapshots the proxy into a real instance.
 * Re-exported as a per-world entity; assigned by {@link InheritanceModule.init}.
 */
export let Inherit: Entity;

/**
 * The `OnInstantiate` policy that skips the component during the `IsA` walk.
 * Re-exported as a per-world entity; assigned by {@link InheritanceModule.init}.
 */
export let DontInherit: Entity;

/**
 * Built-in world module that registers `IsA`, `OnInstantiate`, and the three
 * inheritance-policy option entities.
 *
 * Registered automatically by every {@link World}. Creates `Override`,
 * `Inherit`, and `DontInherit` as `ChildOf` children of the `OnInstantiate`
 * component entity, configures `OnInstantiate` as a self-parent `OneOf` enum,
 * and marks `IsA` as `Exclusive`.
 *
 * The component-walk handler that copies or proxies the template's components
 * onto an inheritor is installed in a later phase; this module only wires up
 * the registration and the policy enum.
 */
export class InheritanceModule extends Module {
  public init(): void {
    const world = this.world;
    const isa = world.component(IsA);
    const onInstantiate = world.component(OnInstantiate);

    onInstantiate.add(OneOf, onInstantiate);

    const overrideEntity = world.entity().childOf(onInstantiate);
    const inheritEntity = world.entity().childOf(onInstantiate);
    const dontInheritEntity = world.entity().childOf(onInstantiate);

    isa.add(Exclusive);

    isa.meta.onDeleteTarget = CleanupPolicy.Remove;

    Override = overrideEntity;
    Inherit = inheritEntity;
    DontInherit = dontInheritEntity;
  }
}
