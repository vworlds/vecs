import {
  CleanupPolicy,
  Relationship,
  type ComponentClass,
  type ComponentInstance,
  type ComponentMeta,
} from "../component_meta.js";
import { Identity, type Entity } from "../entity/index.js";
import { Module } from "../module.js";
import { Exclusive, OneOf } from "./relationships.js";

/**
 * Exclusive, acyclic template relationship with one-shot component materialization.
 *
 * Adding an edge snapshots the immediate target's current effective ordinary components according
 * to each component's {@link OnInstantiate} policy. Existing child values win. Removing or
 * retargeting a live edge is forbidden; destroying the target cascades to its inheritors. Later
 * template changes are not reconciled.
 */
export class IsA extends Relationship {}

/**
 * Set-once, exclusive per-component relationship selecting an IsA materialization policy.
 *
 * {@link OneOf} constrains targets to direct children; this module registers {@link Override},
 * {@link Inherit}, and {@link DontInherit}. Once selected, a policy cannot be removed or changed.
 */
export class OnInstantiate extends Relationship {}

/** Materialize through normal `set`, producing a fresh constructor-plus-assign shallow copy. */
export class Override {}

/**
 * Materialize the exact template instance through normal `attach`.
 *
 * Existing-value `set` shallow-copies only while the direct IsA parent stores the same pointer.
 */
export class Inherit {}

/** Skip the component during IsA materialization. */
export class DontInherit {}

/**
 * Built-in one-shot IsA inheritance module, registered automatically by every World.
 *
 * The module snapshots only when an IsA edge is added. It does not monitor later component or
 * policy changes. Shared instances use copy-on-write only through existing-value `Entity.set`;
 * every other mutation follows ordinary vecs behavior without repair or special networking.
 */
export class InheritanceModule extends Module {
  public init(): void {
    const world = this.world;
    const isA = world.component(IsA);
    const onInstantiate = world.component(OnInstantiate);
    const override = world.component(Override).childOf(onInstantiate);
    const inherit = world.component(Inherit).childOf(onInstantiate);
    const dontInherit = world.component(DontInherit).childOf(onInstantiate);

    isA.add(Exclusive);
    isA.meta.onDeleteTarget = CleanupPolicy.Delete;
    isA.meta._validateTargetAdd = (source, target) => {
      if (source.targets(IsA).some((existing) => existing !== target)) {
        throw new Error("IsA edges cannot be removed or retargeted while both entities are alive");
      }
      this._validateAcyclic(source, target);
    };
    isA.meta._validateTargetRemove = (source, target) => {
      if (source.alive && target.alive) {
        throw new Error("IsA edges cannot be removed or retargeted while both entities are alive");
      }
    };
    isA.meta.on("targetPolicyAdd", (source, _relationship, template) => {
      const entries = [...template.components];
      for (const [eid, templateInstance] of entries) {
        if (!source.alive || !template.alive || source.target(IsA) !== template) {
          return;
        }

        const component = world.entity(eid);
        const meta = component.meta;
        if (meta.isRelationship || meta._isInterface || source.has(eid)) {
          continue;
        }

        const policy = component.target(onInstantiate);
        if (policy === dontInherit) {
          continue;
        }
        if (policy === inherit) {
          source.attach(meta.Class, templateInstance);
        } else {
          source.set(component, templateInstance);
        }
      }
    });

    onInstantiate.add(Exclusive);
    onInstantiate.meta._validateTargetAdd = (component, policy) => {
      const current = component.target(onInstantiate);
      if (current && current !== policy) {
        throw new Error("OnInstantiate policy cannot be removed or changed once set");
      }
    };
    onInstantiate.meta._validateTargetRemove = (component, policy) => {
      if (component.alive && policy.alive) {
        throw new Error("OnInstantiate policy cannot be removed or changed once set");
      }
    };
    onInstantiate.meta.on("targetAdd", (component, _relationship, policy) => {
      if (policy === inherit) {
        this._installCopyOnWrite(component.meta);
      }
    });
    onInstantiate.add(OneOf, onInstantiate);
    world.component(Identity).add(OnInstantiate, dontInherit);
  }

  private _installCopyOnWrite(meta: ComponentMeta): void {
    meta.on("beforeSet", (entity, candidate) => {
      const original = entity._get(meta.eid)!;
      const parent = entity.target(IsA);
      if (!parent || parent._get(meta.eid) !== original) {
        return undefined;
      }

      const replacement =
        candidate === original
          ? (Object.assign(new (meta.Class as ComponentClass)(), original) as ComponentInstance)
          : candidate;
      const descendants = [...entity.children(IsA)];
      while (descendants.length > 0) {
        const descendant = descendants.pop()!;
        if (descendant._get(meta.eid) !== original) {
          continue;
        }
        descendant._repointComponentSilently(meta, original, replacement);
        descendants.push(...descendant.children(IsA));
      }
      return replacement;
    });
  }

  private _validateAcyclic(source: Entity, target: Entity): void {
    for (let ancestor: Entity | undefined = target; ancestor; ancestor = ancestor.target(IsA)) {
      if (ancestor === source) {
        throw new Error("IsA relationships cannot contain a cycle");
      }
    }
  }
}
