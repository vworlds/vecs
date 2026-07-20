import { Relationship } from "../component_meta.js";

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
 * {@link DontInherit} marker classes (registered as `ChildOf` children of the
 * `OnInstantiate` component entity by {@link InheritanceModule}). The default
 * policy when no `OnInstantiate` edge is present is `Override`.
 *
 * `OnInstantiate` is irrevocable via the `OneOf` trait: re-adding with a
 * different option atomically replaces the edge (and updates the policy read
 * on subsequent `IsA` additions); removing the edge throws.
 */
export class OnInstantiate extends Relationship {}

/**
 * The default `OnInstantiate` policy: copy the template's instance onto the
 * inheritor. Registered as a `ChildOf` child of the `OnInstantiate` component
 * entity by `InheritanceModule`, so it can be passed by class to
 * `world.component(C).add(OnInstantiate, Override)`.
 */
export class Override {}

/**
 * The `OnInstantiate` policy that attaches a dirty-on-write proxy of the
 * template's instance onto the inheritor. Reads delegate to the template
 * while clean; the first write snapshots the proxy into a real instance.
 * Registered as a `ChildOf` child of the `OnInstantiate` component entity by
 * `InheritanceModule`, so it can be passed by class to
 * `world.component(C).add(OnInstantiate, Inherit)`.
 */
export class Inherit {}

/**
 * The `OnInstantiate` policy that skips the component during the `IsA` walk.
 * Registered as a `ChildOf` child of the `OnInstantiate` component entity by
 * `InheritanceModule`, so it can be passed by class to
 * `world.component(C).add(OnInstantiate, DontInherit)`.
 */
export class DontInherit {}
