import { Relationship } from "../component_meta.js";
import type { EID } from "../entity/index.js";

/**
 * Built-in exclusive relationship modeling prototype-style entity
 * inheritance.
 *
 * Adding `(IsA, template)` to an entity walks the template's ordinary
 * components and instantiates each onto the inheritor according to that
 * component's `OnInstantiate` policy: copy once (`Override`, the default),
 * live-mirror (`Inherit`), or skip (`DontInherit`).
 *
 * Inherited components are ordinary component instances — there are no
 * proxies or wrappers. `Inherit`-marked components stay live: value changes,
 * later additions, and removals on the template propagate to every inheritor
 * that has not diverged by writing its own value. Divergence is tracked
 * per component on the edge itself.
 *
 * `IsA` is exclusive (one template per inheritor). Re-adding with a different
 * template retargets: components still mirrored from the old template are
 * shed and the new template is instantiated in their place, while diverged
 * and own components are kept.
 *
 * Destroying the template (or removing the edge) leaves the inherited
 * components on the inheritor as ordinary own components holding their last
 * values.
 */
export class IsA extends Relationship {
  /**
   * @internal Component eids currently live-mirrored (not diverged) through
   * this edge. Lazily allocated; `undefined` means nothing is mirrored.
   */
  public _inherited: Set<EID> | undefined;
}

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
 * `OnInstantiate` is exclusive: re-adding with a different option atomically
 * replaces the edge. Switching applies to future `IsA` edges; switching away
 * from `Inherit` also stops live mirroring for existing inheritors, which
 * keep their current values.
 */
export class OnInstantiate extends Relationship {}

/**
 * The default `OnInstantiate` policy: copy the template's instance onto the
 * inheritor once, when the `IsA` edge is created. The copy is independent
 * afterwards — later changes to the template do not propagate. Registered as
 * a `ChildOf` child of the `OnInstantiate` component entity by
 * `InheritanceModule`, so it can be passed by class to
 * `world.component(C).add(OnInstantiate, Override)`.
 */
export class Override {}

/**
 * The `OnInstantiate` policy that live-mirrors the template's component onto
 * the inheritor. The inheritor holds a real copy that is kept in sync with
 * the template: value changes (`set` / `modified`), later additions, and
 * removals on the template propagate to the inheritor — transitively through
 * `IsA` chains — until the inheritor writes its own value for that component,
 * at which point it diverges and owns an independent copy. Registered as a
 * `ChildOf` child of the `OnInstantiate` component entity by
 * `InheritanceModule`, so it can be passed by class to
 * `world.component(C).add(OnInstantiate, Inherit)`.
 */
export class Inherit {}

/**
 * The `OnInstantiate` policy that skips the component during `IsA`
 * instantiation and live propagation. Registered as a `ChildOf` child of the
 * `OnInstantiate` component entity by `InheritanceModule`, so it can be
 * passed by class to `world.component(C).add(OnInstantiate, DontInherit)`.
 */
export class DontInherit {}
