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
import { DontInherit, Inherit, IsA, OnInstantiate, Override } from "./inheritance_types.js";

export { DontInherit, Inherit, IsA, OnInstantiate, Override } from "./inheritance_types.js";

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
 * The component-walk handler installed by `InheritanceModule.init` copies or
 * proxies the template's components onto the inheritor according to each
 * component's `OnInstantiate` policy.
 */
export class InheritanceModule extends Module {
  public init(): void {
    const world = this.world;
    const isa = world.component(IsA);
    const onInstantiate = world.component(OnInstantiate);

    onInstantiate.add(OneOf, onInstantiate);

    // Options are registered as components whose entities are children of
    // OnInstantiate. add(OnInstantiate, Inherit) resolves the class to the
    // option entity via world.entity(Inherit).
    const overrideEntity = world.component(Override).childOf(onInstantiate);
    const inheritEntity = world.component(Inherit).childOf(onInstantiate);
    const dontInheritEntity = world.component(DontInherit).childOf(onInstantiate);

    isa.add(Exclusive);
    onInstantiate.add(Exclusive);

    isa.meta.onDeleteTarget = CleanupPolicy.Remove;

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

    // No-retarget guard. During an exclusive replacement, _replaceTarget
    // swaps the target before the hooks fire, so targetPolicyRemove sees
    // a non-empty relationship. A legitimate remove empties it first.
    isa.meta.on(
      "targetPolicyRemove",
      (source: Entity, relationship: Relationship, _oldTarget: Entity): void => {
        if (relationship._targetCount() > 0) {
          throw new Error(
            `IsA does not allow retargeting; remove the existing edge first (entity ${source.eid})`
          );
        }
      }
    );
  }
}
