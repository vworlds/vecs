import { BitPtr } from "./util/bitset.js";
import type { EID, Entity, EntityClass } from "./entity/index.js";

export enum CleanupPolicy {
  Throw = "throw",
  Remove = "remove",
  Delete = "delete",
}

/** Base class for relationship components that point at another entity. */
export abstract class Relationship {
  private _targets: Entity | Entity[] | undefined;

  /** @internal Add an edge without exposing mutable target storage. */
  public _addTarget(target: Entity): void {
    if (this._targets === undefined) {
      this._targets = target;
    } else if (Array.isArray(this._targets)) {
      this._targets.push(target);
    } else {
      this._targets = [this._targets, target];
    }
  }

  /** @internal Remove an edge and restore the single-target representation when possible. */
  public _removeTarget(target: Entity): boolean {
    if (this._targets === target) {
      this._targets = undefined;
      return true;
    }
    if (!Array.isArray(this._targets)) {
      return false;
    }
    const index = this._targets.indexOf(target);
    if (index === -1) {
      return false;
    }
    this._targets.splice(index, 1);
    if (this._targets.length === 1) {
      this._targets = this._targets[0];
    }
    return true;
  }

  /** @internal Replace the sole target of an exclusive relationship. */
  public _replaceTarget(target: Entity): Entity {
    const previous = this._targets as Entity;
    this._targets = target;
    return previous;
  }

  /** @internal Remove and return every target. */
  public _takeTargets(): Entity[] {
    const targets = this._targets;
    this._targets = undefined;
    if (targets === undefined) {
      return [];
    }
    return Array.isArray(targets) ? targets : [targets];
  }

  /** @internal Return the first current target. */
  public _target(): Entity | undefined {
    return Array.isArray(this._targets) ? this._targets[0] : this._targets;
  }

  /** @internal Return the number of current targets without allocating. */
  public _targetCount(): number {
    if (this._targets === undefined) {
      return 0;
    }
    return Array.isArray(this._targets) ? this._targets.length : 1;
  }

  /** @internal Test targets without materializing a public snapshot. */
  public _someTarget(predicate: (target: Entity) => boolean): boolean {
    if (this._targets === undefined) {
      return false;
    }
    if (!Array.isArray(this._targets)) {
      return predicate(this._targets);
    }
    return this._targets.some(predicate);
  }

  /** @internal Test an edge without allocating. */
  public _hasTarget(target: Entity): boolean {
    return Array.isArray(this._targets) ? this._targets.includes(target) : this._targets === target;
  }

  /** @internal Return a safe target snapshot. */
  public _targetArray(): Entity[] {
    if (this._targets === undefined) {
      return [];
    }
    return Array.isArray(this._targets) ? [...this._targets] : [this._targets];
  }
}

/** Callback fired after one relationship edge is added or removed. */
export type TargetHandler<C extends Relationship = Relationship> = (
  source: Entity,
  relationship: C,
  target: Entity
) => void;

/** Callback fired for a component lifecycle event. */
export type HookHandler<C extends ComponentInstance = ComponentInstance> = (
  entity: Entity,
  component: C
) => void;

/** Internal validation run before a component is attached to or removed from an entity. */
export type ComponentValidator = (entity: Entity) => void;

/** A component instance. Components are plain objects created with a no-arg constructor. */
export type ComponentInstance = object;

/** A component constructor used as a component key. */
export type ComponentType<T extends ComponentInstance = ComponentInstance> = abstract new (
  ...args: any[]
) => T;

/** A component class constructor that can be instantiated by entity.add/set. */
export type ComponentClass<T extends ComponentInstance = ComponentInstance> = new () => T;

/** A component class constructor, component eid, or entity component key. */
export type ComponentRef = EID | ComponentType | EntityClass | Entity;

/** Built-in component declaring abstract/interface component aliases. */
export class Implements {
  public interfaces: ComponentType[] = [];
}

/**
 * Lifecycle hook for a registered component class. Exposed by
 * {@link World.component}.
 *
 * Hooks are a lightweight alternative to building a {@link System} when all
 * you need is a callback on add / remove / set for a single component type.
 * Component entities expose the same registration methods, so calls chain:
 *
 * ```ts
 * world.component(Sprite)
 *   .onAdd((e, c) => initSprite(e, c))
 *   .onRemove((e, c) => destroySprite(e, c))
 *   .onSet((e, c) => syncSprite(e, c));
 * ```
 *
 * Callbacks fire synchronously when the corresponding entity command is
 * applied: inline outside deferred mode, or while the world drains its command
 * queue inside a system / `forEach` / `defer` block.
 *
 * @typeParam C - Component class this hook is bound to.
 */
export interface Hook<C extends ComponentInstance = ComponentInstance> {
  /** Return the current add handler, or `undefined` when none is set. */
  onAdd(): HookHandler<C> | undefined;

  /**
   * Set the handler invoked when a component of this type is first attached to
   * an entity (`entity.add(C)` or `entity.set(C, ...)` on an entity that does
   * not yet have the component). Pass `undefined` to remove the current handler.
   *
   * @param handler - Receives the entity and freshly created component instance.
   * @returns This hook, for chaining.
   */
  onAdd(handler: HookHandler<C> | undefined): Hook<C>;

  /** Return the current remove handler, or `undefined` when none is set. */
  onRemove(): HookHandler<C> | undefined;

  /**
   * Set the handler invoked when a component of this type is removed from an
   * entity (explicit `entity.remove(C)` or implicit removal during
   * `entity.destroy()`). Pass `undefined` to remove the current handler.
   *
   * @param handler - Receives the entity and component instance that was removed.
   * @returns This hook, for chaining.
   */
  onRemove(handler: HookHandler<C> | undefined): Hook<C>;

  /** Return the current set handler, or `undefined` when none is set. */
  onSet(): HookHandler<C> | undefined;

  /**
   * Set the handler invoked when a component's data is set or modified. Pass
   * `undefined` to remove the current handler.
   *
   * Fires when:
   * - `entity.set(C, props)` applies data to the component.
   * - `entity.attach(instance)` stores an existing instance.
   * - `entity.modified(C)` is called after in-place mutation.
   * - A system's `getMut(C)` marks the component dirty.
   * - `entity.ensure(C)` creates or marks the component dirty.
   *
   * @param handler - Receives the entity and component instance whose data changed.
   * @returns This hook, for chaining.
   */
  onSet(handler: HookHandler<C> | undefined): Hook<C>;
}

/**
 * Bookkeeping record produced for each component eid.
 *
 * Holds the constructor, component eid, and pre-computed
 * {@link BitPtr} used by archetype checks. Implements {@link Hook}, so the
 * lifecycle handlers attached via `world.component(C)` are stored directly on
 * the meta object.
 */
export class ComponentMeta implements Hook<ComponentInstance> {
  /** The component class constructor this meta represents. */
  public readonly Class: ComponentType;
  /** Component entity id assigned at registration time. */
  public readonly eid: EID;
  /** Pre-computed bit-pointer into the entity archetype {@link Bitset}. */
  public readonly bitPtr: BitPtr;
  /** Whether this component is a relationship pointing at another entity. */
  public readonly isRelationship: boolean;
  /** Whether this relationship permits only one target. */
  public relationshipExclusive = false;

  /** Applied to entities carrying this component when this component entity is deleted. */
  public onDelete = CleanupPolicy.Throw;
  /** Applied to entities targeting a deleted entity through this relationship. */
  public onDeleteTarget = CleanupPolicy.Remove;

  /**
   * @internal Peer metas of components that cannot coexist with this one on
   * the same entity. Set via {@link World.setExclusiveComponents}; `undefined`
   * means no restriction.
   */
  public _exclusive: ComponentMeta[] | undefined = undefined;

  /** @internal Full transitive interface metas exposed as aliases for this component. */
  public _implementsClosure: ComponentMeta[] | undefined = undefined;

  /** @internal Whether this component meta is an abstract/interface alias. */
  public _isInterface = false;

  /** @internal Validate this component before storage. */
  public _validateAdd: ComponentValidator | undefined;
  /** @internal Validate this component before removal. */
  public _validateRemove: ComponentValidator | undefined;

  /** @internal Framework policy applied when this component is attached. */
  public _onPolicyAdd: HookHandler | undefined;
  /** @internal Framework policy applied when this component is removed. */
  public _onPolicyRemove: HookHandler | undefined;

  /** @internal Component instances created by ensure operations but not yet attached. */
  public _pendingEnsures: WeakMap<Entity, ComponentInstance> | undefined;

  /** @internal Current `onAdd` handler. */
  public _onAdd: HookHandler | undefined;
  /** @internal Current `onRemove` handler. */
  public _onRemove: HookHandler | undefined;
  /** @internal Current relationship target-add handler. */
  public _onTargetAdd: TargetHandler | undefined;
  /** @internal Current relationship target-remove handler. */
  public _onTargetRemove: TargetHandler | undefined;
  /** @internal Target-add policies keyed by the trait component eid that installed them. */
  public _targetAddPolicies: Map<EID, TargetHandler> | undefined;
  /** @internal Target-remove policies keyed by the trait component eid that installed them. */
  public _targetRemovePolicies: Map<EID, TargetHandler> | undefined;
  /** @internal Current `onSet` handler. */
  public _onSet: HookHandler | undefined;

  private _usageCount = 0;

  constructor(Class: ComponentType, ceid: EID) {
    this.Class = Class;
    this.eid = ceid;
    this.bitPtr = new BitPtr(ceid);
    this.isRelationship = Class.prototype instanceof Relationship;
  }

  /** Number of entities currently carrying this component eid. */
  public get usageCount(): number {
    return this._usageCount;
  }

  /** @internal */
  public _incrementUsage(): void {
    this._usageCount++;
  }

  /** @internal */
  public _decrementUsage(): void {
    if (this._usageCount > 0) {
      this._usageCount--;
    }
  }

  /** @inheritdoc */
  public onAdd(): HookHandler | undefined;
  public onAdd(handler: HookHandler | undefined): ComponentMeta;
  public onAdd(handler?: HookHandler): ComponentMeta | HookHandler | undefined {
    if (arguments.length === 0) {
      return this._onAdd;
    }
    this._onAdd = handler;
    return this;
  }

  /** @inheritdoc */
  public onRemove(): HookHandler | undefined;
  public onRemove(handler: HookHandler | undefined): ComponentMeta;
  public onRemove(handler?: HookHandler): ComponentMeta | HookHandler | undefined {
    if (arguments.length === 0) {
      return this._onRemove;
    }
    this._onRemove = handler;
    return this;
  }

  /** Return the current target-add handler, or `undefined` when none is set. */
  public onTargetAdd(): TargetHandler | undefined;
  /** Set the handler fired after an edge is added. */
  public onTargetAdd(handler: TargetHandler | undefined): ComponentMeta;
  public onTargetAdd(handler?: TargetHandler): ComponentMeta | TargetHandler | undefined {
    if (!this.isRelationship) {
      throw new Error("onTargetAdd can only be registered on a Relationship component");
    }
    if (arguments.length === 0) {
      return this._onTargetAdd;
    }
    this._onTargetAdd = handler;
    return this;
  }

  /** Return the current target-remove handler, or `undefined` when none is set. */
  public onTargetRemove(): TargetHandler | undefined;
  /** Set the handler fired after an edge is removed. */
  public onTargetRemove(handler: TargetHandler | undefined): ComponentMeta;
  public onTargetRemove(handler?: TargetHandler): ComponentMeta | TargetHandler | undefined {
    if (!this.isRelationship) {
      throw new Error("onTargetRemove can only be registered on a Relationship component");
    }
    if (arguments.length === 0) {
      return this._onTargetRemove;
    }
    this._onTargetRemove = handler;
    return this;
  }

  /** @inheritdoc */
  public onSet(): HookHandler | undefined;
  public onSet(handler: HookHandler | undefined): ComponentMeta;
  public onSet(handler?: HookHandler): ComponentMeta | HookHandler | undefined {
    if (arguments.length === 0) {
      return this._onSet;
    }
    this._onSet = handler;
    return this;
  }
}

/**
 * An array of component classes or numeric type ids, used by query helpers.
 *
 * @internal
 */
export type ComponentRefArray = ComponentRef[];
