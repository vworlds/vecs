import {
  CleanupPolicy,
  type ComponentClass,
  type ComponentInstance,
  type ComponentMeta,
  type HookHandler,
} from "../component_meta.js";
import { type EID, type Entity } from "../entity/index.js";
import { Module } from "../module.js";
import { Exclusive, OneOf } from "./relationship_types.js";
import { Singleton } from "./singleton.js";
import { DontInherit, Inherit, IsA, OnInstantiate, Override } from "./inheritance_types.js";

export { DontInherit, Inherit, IsA, OnInstantiate, Override } from "./inheritance_types.js";

/** @internal Live-sync handlers installed on an `Inherit`-marked component meta. */
interface LiveSyncHooks {
  onAdd: HookHandler;
  onRemove: HookHandler;
  onSet: HookHandler;
}

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
 * Inheritance is implemented without proxies. Creating an `(IsA, template)`
 * edge instantiates the template's ordinary components onto the inheritor as
 * real copies. For components marked `OnInstantiate=Inherit`, the module
 * additionally installs `add` / `set` / `remove` hooks on the component meta
 * that keep the copies live: a change on any entity propagates to the
 * entities inheriting from it (transitively, through the `IsA` reverse
 * index), while an inheritor's own write marks that component diverged on
 * its edge and stops future mirroring. Module-initiated writes run under a
 * re-entrancy flag so they are never mistaken for user writes.
 */
export class InheritanceModule extends Module {
  private _dontInheritEntity!: Entity;
  private _inheritEntity!: Entity;
  private _isaEid!: EID;
  private _liveHooks = new Map<EID, LiveSyncHooks>();
  private _onInstantiateEid!: EID;
  private _propagating = false;
  private _singletonEid!: EID;

  public init(): void {
    const world = this.world;
    const isa = world.component(IsA);
    const onInstantiate = world.component(OnInstantiate);

    onInstantiate.add(OneOf, onInstantiate);

    // Options are registered as components whose entities are children of
    // OnInstantiate. add(OnInstantiate, Inherit) resolves the class to the
    // option entity via world.entity(Inherit).
    world.component(Override).childOf(onInstantiate);
    this._inheritEntity = world.component(Inherit).childOf(onInstantiate);
    this._dontInheritEntity = world.component(DontInherit).childOf(onInstantiate);

    isa.add(Exclusive);
    onInstantiate.add(Exclusive);
    isa.meta.onDeleteTarget = CleanupPolicy.Remove;

    this._isaEid = isa.eid;
    this._onInstantiateEid = onInstantiate.eid;
    this._singletonEid = world.component(Singleton).eid;

    onInstantiate.meta.on("targetPolicyAdd", (componentEntity, _rel, option): void => {
      if (option === this._inheritEntity) {
        this._installLiveSync(componentEntity.meta);
      }
    });
    onInstantiate.meta.on("targetPolicyRemove", (componentEntity, _rel, option): void => {
      if (option === this._inheritEntity) {
        this._uninstallLiveSync(componentEntity.meta);
      }
    });

    isa.meta.on("targetPolicyAdd", (inheritor, relationship, template): void => {
      this._applyTemplate(inheritor, relationship as IsA, template);
    });
    // During an exclusive retarget, _replaceTarget swaps the target before the
    // hooks fire, so targetPolicyRemove sees a non-empty relationship. A plain
    // removal (or the cleanup cascade) empties it first and keeps the copies.
    isa.meta.on("targetPolicyRemove", (source, relationship, _oldTarget): void => {
      if (relationship._targetCount() > 0) {
        this._shedInherited(source, relationship as IsA);
      }
    });
  }

  /**
   * Instantiate `template`'s ordinary components onto `inheritor`.
   *
   * Relationships, interface aliases, `Singleton`-marked components, and
   * `DontInherit`-marked components are skipped, and a component the
   * inheritor already carries wins over the template's. `Inherit`-marked
   * copies are recorded on the edge and propagated to the inheritor's own
   * inheritors, so adding `IsA` to an entity that already has inheritors
   * cascades down the chain.
   */
  private _applyTemplate(inheritor: Entity, edge: IsA, template: Entity): void {
    const world = this.world;
    this._withPropagation(() => {
      template.components.forEach((instance, ceid) => {
        if (ceid === this._isaEid) {
          return;
        }
        const componentEntity = world.entity(ceid);
        const meta = componentEntity.meta;
        if (meta.isRelationship || meta._isInterface) {
          return;
        }
        if (ceid === this._singletonEid || componentEntity.has(this._singletonEid)) {
          return;
        }
        const policy = componentEntity.target(this._onInstantiateEid);
        if (policy === this._dontInheritEntity || inheritor.has(ceid)) {
          return;
        }
        const copy = this._clone(meta, instance);
        inheritor._attach(meta, copy);
        if (policy === this._inheritEntity) {
          (edge._inherited ??= new Set()).add(ceid);
          this._syncAdd(inheritor, meta, copy, new Set([inheritor]));
        }
      });
    });
  }

  /** Copy `source`'s fields onto a fresh instance of `meta`'s class. */
  private _clone(meta: ComponentMeta, source: ComponentInstance): ComponentInstance {
    return Object.assign(new (meta.Class as ComponentClass)(), source);
  }

  /**
   * Install the live-sync hooks on an `Inherit`-marked component meta.
   *
   * Each hook interprets user-initiated events only (module-initiated writes
   * run under the propagation flag and are skipped) and then propagates the
   * event to the entities inheriting from the written entity. A `set` on an
   * entity that mirrors the component through its own `IsA` edge marks that
   * component diverged before propagating the new values downward.
   */
  private _installLiveSync(meta: ComponentMeta): void {
    if (this._liveHooks.has(meta.eid)) {
      return;
    }
    const onAdd: HookHandler = (e, c): void => {
      if (this._propagating || e.destroyed) {
        return;
      }
      this._withPropagation(() => this._syncAdd(e, meta, c, new Set([e])));
    };
    const onRemove: HookHandler = (e): void => {
      if (this._propagating || e.destroyed) {
        return;
      }
      (e._get(this._isaEid) as IsA | undefined)?._inherited?.delete(meta.eid);
      this._withPropagation(() => this._syncRemove(e, meta, new Set([e])));
    };
    const onSet: HookHandler = (e, c): void => {
      if (this._propagating || e.destroyed) {
        return;
      }
      (e._get(this._isaEid) as IsA | undefined)?._inherited?.delete(meta.eid);
      this._withPropagation(() => this._syncSet(e, meta, c, new Set([e])));
    };
    meta.on("add", onAdd);
    meta.on("remove", onRemove);
    meta.on("set", onSet);
    this._liveHooks.set(meta.eid, { onAdd, onRemove, onSet });
  }

  /**
   * Shed the components still mirrored through `edge` from `source` when the
   * edge is retargeted, removing each from `source`'s own inheritors as well.
   * Diverged and own components are untouched; the subsequent
   * `targetPolicyAdd` instantiates the new template in their place.
   */
  private _shedInherited(source: Entity, edge: IsA): void {
    const inherited = edge._inherited;
    if (inherited === undefined || inherited.size === 0) {
      return;
    }
    edge._inherited = undefined;
    this._withPropagation(() => {
      for (const ceid of inherited) {
        const meta = this.world.entity(ceid).meta;
        source._remove(meta);
        this._syncRemove(source, meta, new Set([source]));
      }
    });
  }

  /** Attach a copy of `values` to every inheritor of `source` that lacks the component. */
  private _syncAdd(
    source: Entity,
    meta: ComponentMeta,
    values: ComponentInstance,
    visited: Set<Entity>
  ): void {
    for (const child of source._childrenByEid(this._isaEid) ?? []) {
      if (visited.has(child) || child.destroyed) {
        continue;
      }
      visited.add(child);
      if (child.has(meta.eid)) {
        continue;
      }
      const edge = child._get(this._isaEid) as IsA;
      const copy = this._clone(meta, values);
      child._attach(meta, copy);
      (edge._inherited ??= new Set()).add(meta.eid);
      this._syncAdd(child, meta, copy, visited);
    }
  }

  /** Remove the component from every inheritor of `source` still mirroring it. */
  private _syncRemove(source: Entity, meta: ComponentMeta, visited: Set<Entity>): void {
    for (const child of source._childrenByEid(this._isaEid) ?? []) {
      if (visited.has(child) || child.destroyed) {
        continue;
      }
      visited.add(child);
      const edge = child._get(this._isaEid) as IsA;
      if (!edge._inherited?.has(meta.eid)) {
        continue;
      }
      edge._inherited.delete(meta.eid);
      child._remove(meta);
      this._syncRemove(child, meta, visited);
    }
  }

  /** Copy `values` onto every inheritor of `source` still mirroring the component. */
  private _syncSet(
    source: Entity,
    meta: ComponentMeta,
    values: ComponentInstance,
    visited: Set<Entity>
  ): void {
    for (const child of source._childrenByEid(this._isaEid) ?? []) {
      if (visited.has(child) || child.destroyed) {
        continue;
      }
      visited.add(child);
      const edge = child._get(this._isaEid) as IsA;
      if (!edge._inherited?.has(meta.eid)) {
        continue;
      }
      const instance = child._get(meta.eid);
      if (instance === undefined) {
        continue;
      }
      Object.assign(instance, values);
      child._modified(meta);
      this._syncSet(child, meta, instance, visited);
    }
  }

  /** Remove the live-sync hooks when a component is no longer `Inherit`-marked. */
  private _uninstallLiveSync(meta: ComponentMeta): void {
    const hooks = this._liveHooks.get(meta.eid);
    if (hooks === undefined) {
      return;
    }
    this._liveHooks.delete(meta.eid);
    meta.off("add", hooks.onAdd);
    meta.off("remove", hooks.onRemove);
    meta.off("set", hooks.onSet);
  }

  /** Run `fn` with the propagation flag raised so the live-sync hooks skip it. */
  private _withPropagation(fn: () => void): void {
    const previous = this._propagating;
    this._propagating = true;
    try {
      fn();
    } finally {
      this._propagating = previous;
    }
  }
}
