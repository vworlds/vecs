import {
  CleanupPolicy,
  Implements,
  Relationship,
  type ComponentClass,
  type ComponentInstance,
  type ComponentMeta,
  type ComponentMutation,
} from "../component_meta.js";
import { type Entity } from "../entity/index.js";
import { Module } from "../module.js";
import { Singleton } from "./singleton.js";
import { ChildOf, Exclusive, OneOf, With } from "./relationships.js";

const OWNER = Symbol("vecs.inheritance.owner");

/**
 * Exclusive template relationship. Adding `child.add(IsA, template)` snapshots or shares the
 * template's effective ordinary components according to each component's {@link OnInstantiate}
 * policy. IsA edges are acyclic and immutable while both entities live, and destroying a template
 * recursively destroys every inheritor. Re-adding the current target is idempotent. Existing child
 * values shadow template values, including through a subtree that existed before its parent edge.
 * Relationships, interface alias scan entries, singleton data, and inheritance infrastructure are
 * not instantiated. IsA is local-only and is not supported by networking.
 */
export class IsA extends Relationship {}

/**
 * Exclusive one-of relationship used on component entities to select an inheritance policy.
 * Configure a component during setup with
 * `world.component(C).add(OnInstantiate, Inherit | Override | DontInherit)`. Components without
 * this relationship use {@link Override}. The three policy targets are direct {@link ChildOf}
 * children of this relationship's component entity, and no other child is accepted. Selecting a
 * policy also attaches that marker component to the configured component entity, keeping the marker
 * in use so its runtime-immutable `CleanupPolicy.Throw` prevents premature destruction. The matching
 * marker cannot be removed or replaced while the edge exists; reattaching its exact current object
 * retains normal attach behavior. Policy is irrevocable and must be selected before the configured
 * component has carriers. Shared Inherit metadata is installed during successful pre-edge
 * validation, before relationship storage or marker query notifications can reenter.
 */
export class OnInstantiate extends Relationship {}

/**
 * On-instantiation policy that shallow-copies a template value into each inheritor. Each copy is
 * created with the component's no-argument constructor followed by `Object.assign`. Override is a
 * snapshot: later additions or writes on the template do not propagate. Nested references remain
 * shared, and every copy is an ordinary local value with normal mutation and remove-hook behavior.
 */
export class Override {}

/**
 * On-instantiation policy that stores the template's exact component object on inheritors.
 * A local addition propagates through existing unshadowed IsA descendants. Calling `set` on an
 * inherited value performs shallow copy-on-write for that entity and descendants sharing the old
 * pointer. Only the explicit setter receives value notifications. Public `attach`, including an
 * attach of the exact current object, and explicit `remove` are rejected; inherited `modified`,
 * `getMut`, and existing-value `ensure` are rejected. Structural query membership remains reactive,
 * but descendant predicates, groups, ordering, updates, and network deltas are intentionally not
 * refreshed. The component must be safe to construct without arguments, and every instance must be
 * extensible so vecs can apply private ownership metadata before propagation. Inherit cannot compose
 * with relationships, aliases, exclusivity, Singleton, With, or a non-default deletion policy.
 * Networking is unsupported but not coupled to this local module through cross-package enforcement.
 */
export class Inherit {}

/**
 * On-instantiation policy that omits the configured component from IsA inheritors. Use it for
 * attached resources and other identity-bearing values that cannot be shallow-copied or shared.
 */
export class DontInherit {}

/**
 * Built-in module implementing IsA template inheritance and OnInstantiate policy.
 *
 * Every {@link World} installs this module immediately after {@link RelationshipsModule}. It
 * configures IsA as exclusive, acyclic, immutable, and target-deleting; configures OnInstantiate
 * as an exclusive {@link OneOf}; and parents the three policy marker component entities directly
 * beneath the OnInstantiate component entity.
 *
 * Shared insertion performs complete structural bookkeeping without add/set policy or public
 * value hooks. Copy-on-write repoints component storage only and never emits descendant value
 * notifications. Components carrying With are omitted from template scans so inheritance cannot
 * create a carrier without its required companion. Shared policy hooks are installed before an
 * Inherit edge or marker becomes observable. Applications normally use the auto-installed module
 * rather than registering it.
 */
export class InheritanceModule extends Module {
  private _dontInherit!: Entity;
  private _inherit!: Entity;
  private _isAEid!: number;
  private _onInstantiate!: Entity;
  private _override!: Entity;

  public init(): void {
    const world = this.world;
    const isA = world.component(IsA);
    const onInstantiate = world.component(OnInstantiate);
    const override = world.component(Override).add(ChildOf, onInstantiate);
    const inherit = world.component(Inherit).add(ChildOf, onInstantiate);
    const dontInherit = world.component(DontInherit).add(ChildOf, onInstantiate);

    this._dontInherit = dontInherit;
    this._inherit = inherit;
    this._isAEid = isA.eid;
    this._onInstantiate = onInstantiate;
    this._override = override;

    this._protectPolicyMarker(override);
    this._protectPolicyMarker(inherit);
    this._protectPolicyMarker(dontInherit);

    onInstantiate.add(Exclusive).add(OneOf, onInstantiate);
    onInstantiate.meta._validateTargetAdd = (component, policy) =>
      this._validatePolicy(component, policy);
    onInstantiate.meta._validateTargetRemove = (component, policy) => {
      if (component.alive && policy.alive) {
        throw new Error("OnInstantiate policy cannot be changed or removed once configured");
      }
    };
    onInstantiate.meta.on("targetPolicyAdd", (component, _relationship, policy) => {
      component._set(policy.meta, undefined);
    });

    isA.add(Exclusive);
    isA.meta.onDeleteTarget = CleanupPolicy.Delete;
    isA.meta._validateTargetAdd = (source, target) => this._validateIsA(source, target);
    isA.meta._validateTargetRemove = (source, target) => {
      if (source.alive && target.alive) {
        throw new Error("IsA edges cannot be removed or retargeted while both entities are alive");
      }
    };
    isA.meta.on("targetPolicyAdd", (source, _relationship, template) =>
      this._instantiateSubtree(source, template)
    );
  }

  private _brand(component: ComponentInstance, owner: Entity): void {
    Object.defineProperty(component, OWNER, {
      configurable: false,
      enumerable: false,
      value: owner,
      writable: false,
    });
  }

  private _clone(meta: ComponentMeta, component: ComponentInstance): ComponentInstance {
    return Object.assign(new (meta.Class as ComponentClass)(), component);
  }

  private _configureSharedInheritance(component: Entity): void {
    const meta = component.meta;
    if (meta._inheritShared) {
      return;
    }
    meta._inheritShared = true;
    meta._prepareSet = (entity, instance) => this._prepareSharedSet(entity, meta, instance);
    meta._shouldNotifyRemove = (entity, instance) => this._ownerOf(instance) === entity;
    meta._validateMutation = (entity, operation, instance) =>
      this._validateSharedMutation(entity, operation, instance);
    meta.on("policyAdd", (entity, instance) => {
      this._brand(instance, entity);
      this._propagateSharedAddition(entity, meta, instance);
    });
  }

  private _instantiate(parent: Entity, child: Entity): void {
    for (const [ceid, instance] of parent.components) {
      if (!parent.alive || !child.alive) {
        return;
      }
      const component = this.world.entity(ceid);
      const meta = component.meta;
      if (child.has(ceid) || this._skipComponent(component, meta)) {
        continue;
      }
      const policy = component.target(OnInstantiate);
      if (policy === this._dontInherit) {
        continue;
      }
      child._storeComponentSilently(
        meta,
        policy === this._inherit ? instance : this._clone(meta, instance)
      );
      if (!parent.alive || !child.alive) {
        return;
      }
    }
  }

  private _instantiateSubtree(source: Entity, template: Entity): void {
    if (!source.alive || !template.alive) {
      return;
    }
    this._instantiate(template, source);
    if (!source.alive || !template.alive) {
      return;
    }
    const queue: Entity[] = [source];
    for (let i = 0; i < queue.length; i++) {
      const parent = queue[i];
      if (!parent.alive) {
        continue;
      }
      for (const child of [...(parent._childrenByEid(this._isAEid) ?? [])]) {
        if (!parent.alive) {
          break;
        }
        if (!child.alive) {
          continue;
        }
        this._instantiate(parent, child);
        if (child.alive) {
          queue.push(child);
        }
      }
    }
  }

  private _ownerOf(component: ComponentInstance): Entity | undefined {
    return (component as Record<PropertyKey, unknown>)[OWNER] as Entity | undefined;
  }

  private _prepareSharedSet(
    entity: Entity,
    meta: ComponentMeta,
    instance: ComponentInstance
  ): ComponentInstance {
    if (this._ownerOf(instance) === entity) {
      return instance;
    }
    const replacement = this._clone(meta, instance);
    this._brand(replacement, entity);
    const queue: Entity[] = [entity];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      if (!current._repointComponentSilently(meta, instance, replacement)) {
        continue;
      }
      for (const child of current._childrenByEid(this._isAEid) ?? []) {
        queue.push(child);
      }
    }
    return replacement;
  }

  private _protectPolicyMarker(marker: Entity): void {
    Object.defineProperty(marker.meta, "onDelete", {
      configurable: false,
      enumerable: true,
      value: CleanupPolicy.Throw,
      writable: false,
    });
    const previous = marker.meta._validateMutation;
    marker.meta._validateMutation = (entity, operation, instance, replacement) => {
      previous?.(entity, operation, instance, replacement);
      if (
        (operation === "remove" ||
          (operation === "attach" && instance !== undefined && instance !== replacement)) &&
        entity.target(OnInstantiate) === marker
      ) {
        throw new Error("OnInstantiate policy marker cannot be removed or replaced while in use");
      }
    };
  }

  private _propagateSharedAddition(
    source: Entity,
    meta: ComponentMeta,
    instance: ComponentInstance
  ): void {
    if (!source.alive) {
      return;
    }
    const queue: [Entity, ComponentInstance][] = [
      ...(source._childrenByEid(this._isAEid) ?? []),
    ].map((child) => [child, instance]);
    for (let i = 0; i < queue.length; i++) {
      const [child, inherited] = queue[i];
      if (!child.alive || !child._storeComponentSilently(meta, inherited)) {
        continue;
      }
      const current = child._get(meta.eid);
      if (!child.alive || current === undefined) {
        continue;
      }
      for (const descendant of [...(child._childrenByEid(this._isAEid) ?? [])]) {
        queue.push([descendant, current]);
      }
    }
  }

  private _skipComponent(component: Entity, meta: ComponentMeta): boolean {
    return (
      meta.isRelationship ||
      meta._isInterface ||
      meta.Class === Singleton ||
      component.has(Singleton) ||
      component.has(With) ||
      component === this._onInstantiate ||
      component === this._override ||
      component === this._inherit ||
      component === this._dontInherit
    );
  }

  private _validateIsA(source: Entity, target: Entity): void {
    for (let ancestor: Entity | undefined = target; ancestor; ancestor = ancestor.target(IsA)) {
      if (ancestor === source) {
        throw new Error("IsA hierarchy cannot contain a cycle");
      }
    }
  }

  private _validatePolicy(component: Entity, policy: Entity): void {
    if (this.world._classRegistry.get(component.meta.Class) !== component) {
      throw new Error("OnInstantiate can only configure a registered component entity");
    }
    const existingPolicy = component.target(OnInstantiate);
    if (existingPolicy !== undefined && existingPolicy !== policy) {
      throw new Error("OnInstantiate policy cannot be changed or removed once configured");
    }
    if (policy !== this._override && policy !== this._inherit && policy !== this._dontInherit) {
      throw new Error("OnInstantiate policy must be Override, Inherit, or DontInherit");
    }
    const meta = component.meta;
    if (meta.isRelationship) {
      throw new Error("OnInstantiate does not support Relationship components");
    }
    if (policy === this._inherit) {
      if (component.has(Implements) || meta._isInterface || meta._implementsClosure) {
        throw new Error("Inherit does not support Implements or interface aliases");
      }
      if (component.has(Singleton)) {
        throw new Error("Inherit does not support Singleton components");
      }
      if (component.has(With)) {
        throw new Error("Inherit does not support With components");
      }
      if (meta._exclusive) {
        throw new Error("Inherit does not support exclusive component groups");
      }
      if (meta.onDelete !== CleanupPolicy.Throw) {
        throw new Error("Inherit requires the default component deletion policy");
      }
    }
    if (meta.usageCount > 0) {
      throw new Error("OnInstantiate policy must be configured before the component has carriers");
    }
    if (policy === this._inherit) {
      this._configureSharedInheritance(component);
    }
  }

  private _validateSharedMutation(
    entity: Entity,
    operation: ComponentMutation,
    instance?: ComponentInstance
  ): void {
    if (operation === "attach") {
      throw new Error("Entity.attach is not supported for Inherit components");
    }
    if (operation === "remove") {
      throw new Error("Entity.remove is not supported for Inherit components");
    }
    if (instance !== undefined && this._ownerOf(instance) !== entity) {
      throw new Error(`Entity.${operation} cannot mutate an inherited Inherit component; use set`);
    }
  }
}
