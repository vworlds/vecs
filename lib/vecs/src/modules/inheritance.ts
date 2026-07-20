import { CleanupPolicy } from "../component_meta.js";
import { Module } from "../module.js";
import { Singleton } from "./singleton.js";
import { Exclusive, OneOf } from "./relationships.js";
import { DontInherit, Inherit, IsA, OnInstantiate, Override } from "./inheritance_types.js";

export { DontInherit, Inherit, IsA, OnInstantiate, Override } from "./inheritance_types.js";

/**
 * Built-in module that implements template inheritance through {@link IsA}.
 *
 * Registered automatically by every {@link World}. `Override` components are
 * shallow-copied once. `Inherit` components occupy ordinary query-visible
 * component slots but borrow the template's instance until the inheritor
 * mutates it. Source additions, replacements, updates, and removals reconcile
 * borrowed slots through any number of `IsA` layers.
 */
export class InheritanceModule extends Module {
  public init(): void {
    const world = this.world;
    const isa = world.component(IsA);
    const onInstantiate = world.component(OnInstantiate);
    world.component(Override).childOf(onInstantiate);
    const inherit = world.component(Inherit).childOf(onInstantiate);
    const dontInherit = world.component(DontInherit).childOf(onInstantiate);

    onInstantiate.add(OneOf, onInstantiate);
    isa.add(Exclusive);
    isa.meta.onDeleteTarget = CleanupPolicy.Remove;

    world._inheritance = {
      isaEid: isa.eid,
      onInstantiateEid: onInstantiate.eid,
      inherit,
      dontInherit,
      singletonEid: world.component(Singleton).eid,
    };

    isa.meta.on("targetPolicyAdd", (entity, _relationship, template): void =>
      entity._applyInheritance(template)
    );
    isa.meta.on("targetPolicyRemove", (entity, _relationship, template): void =>
      entity._clearInheritance(template)
    );
  }
}
