import {
  CleanupPolicy,
  type ComponentClass,
  type ComponentInstance,
  Relationship,
} from "../component_meta.js";
import { type EID, type Entity } from "../entity/index.js";
import { Module } from "../module.js";
import { Exclusive, OneOf } from "./relationship_types.js";
import { Singleton } from "./singleton.js";

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
 * entity by {@link InheritanceModule}, so it can be passed by class to
 * `world.component(C).add(OnInstantiate, Override)`.
 */
export class Override {}

/**
 * The `OnInstantiate` policy that attaches a dirty-on-write proxy of the
 * template's instance onto the inheritor. Reads delegate to the template
 * while clean; the first write snapshots the proxy into a real instance.
 * Registered as a `ChildOf` child of the `OnInstantiate` component entity by
 * {@link InheritanceModule}, so it can be passed by class to
 * `world.component(C).add(OnInstantiate, Inherit)`.
 */
export class Inherit {}

/**
 * The `OnInstantiate` policy that skips the component during the `IsA` walk.
 * Registered as a `ChildOf` child of the `OnInstantiate` component entity by
 * {@link InheritanceModule}, so it can be passed by class to
 * `world.component(C).add(OnInstantiate, DontInherit)`.
 */
export class DontInherit {}

/**
 * Built-in world module that registers `IsA`, `OnInstantiate`, and the three
 * inheritance-policy option marker classes.
 *
 * Registered automatically by every {@link World}. Registers `Override`,
 * `Inherit`, and `DontInherit` as components and makes their component
 * entities `ChildOf` children of the `OnInstantiate` component entity,
 * configures `OnInstantiate` as a self-parent `OneOf` enum, and marks `IsA`
 * as `Exclusive`.
 *
 * The component-walk handler installed by {@link InheritanceModule.init}
 * copies or proxies the template's components onto the inheritor according
 * to each component's `OnInstantiate` policy.
 */
export class InheritanceModule extends Module {
  public init(): void {
    const world = this.world;
    const isa = world.component(IsA);
    const onInstantiate = world.component(OnInstantiate);

    onInstantiate.add(OneOf, onInstantiate);

    // Register each option as a component and make its entity a child of
    // OnInstantiate. The user passes the class to add(OnInstantiate, Option),
    // which resolves to the option entity via world.entity(Option).
    const overrideEntity = world.component(Override).childOf(onInstantiate);
    const inheritEntity = world.component(Inherit).childOf(onInstantiate);
    const dontInheritEntity = world.component(DontInherit).childOf(onInstantiate);

    isa.add(Exclusive);
    onInstantiate.add(Exclusive);

    isa.meta.onDeleteTarget = CleanupPolicy.Remove;

    // Resolve once and capture in the handler closure. These are stable
    // after init completes.
    const onInstantiateEid = onInstantiate.eid;
    const isaEid = isa.eid;
    const singletonEid = world.component(Singleton).eid;

    isa.meta.on(
      "targetPolicyAdd",
      (inheritor: Entity, _rel: Relationship, template: Entity): void => {
        template.components.forEach((instance: ComponentInstance, ceid: EID) => {
          if (ceid === isaEid) {
            return; // never inherit the IsA relationship itself
          }
          const componentEntity = world.entity(ceid);
          const meta = componentEntity.meta;
          if (meta.isRelationship) {
            return; // skip all relationships (ChildOf, OnInstantiate, etc.)
          }
          if (ceid === onInstantiateEid) {
            return; // OnInstantiate is meta-policy, not inherited
          }
          if (componentEntity.has(singletonEid)) {
            return; // skip Singleton components
          }

          const optionEntity = componentEntity.target(OnInstantiate);
          if (optionEntity === dontInheritEntity) {
            return;
          }
          const c =
            optionEntity === inheritEntity
              ? meta._proxy(instance)
              : Object.assign(new (meta.Class as ComponentClass)(), instance);
          inheritor._attach(meta, c);
        });
      }
    );
  }
}
