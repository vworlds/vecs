import { BitPtr } from "./util/bitset.js";
import { DenseSet } from "./util/dense_set.js";
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

/** A component instance. Components are plain objects created with a no-arg constructor. */
export type ComponentInstance = object;

/**
 * Event → handler signature map for the unified `on` / `off` hook API.
 *
 * Each key is a hook event name; its value is the handler signature accepted
 * by {@link ComponentMeta.on} and {@link ComponentMeta.off} for that event.
 * The `target*` events require a relationship meta; registering one on a
 * non-relationship meta throws at registration time.
 */
export interface HookEventMap {
  /** Fired when a component of this type is first attached to an entity. */
  add: HookHandler;
  /** Fired when a component of this type is removed from an entity. */
  remove: HookHandler;
  /** Fired when a component's data is set or modified. */
  set: HookHandler;
  /** Fired after a relationship edge is added. Relationship metas only. */
  targetAdd: TargetHandler;
  /** Fired after a relationship edge is removed. Relationship metas only. */
  targetRemove: TargetHandler;
  /** @internal Framework policy applied when this component is attached. */
  policyAdd: HookHandler;
  /** @internal Framework policy applied when this component is removed. */
  policyRemove: HookHandler;
  /** @internal Framework policy applied after a relationship edge is added. Relationship metas only. */
  targetPolicyAdd: TargetHandler;
  /** @internal Framework policy applied after a relationship edge is removed. Relationship metas only. */
  targetPolicyRemove: TargetHandler;
}

/** Event names accepted by {@link ComponentMeta.on} / {@link ComponentMeta.off}. */
export type HookEvent = keyof HookEventMap;

/**
 * Multi-handler metadata attached to a wrapper function when two or more
 * handlers are registered for the same event.
 *
 * @internal
 */
export interface HookMetadata {
  /** Live handler array; mutated in place by `on` / `off`. */
  handlers: Function[];
}

/**
 * A registered hook slot: `undefined` when empty, the single handler when
 * exactly one is registered, or a wrapper function (with `HookMetadata`)
 * iterating its `handlers` array when two or more are registered.
 *
 * @internal
 */
export type HookSlot<H extends Function> = H | (H & HookMetadata) | undefined;

/**
 * Install a handler into a hook slot, preserving invocation order.
 *
 * - Empty slot → store the handler directly (zero-overhead single-handler case).
 * - Single-handler slot → wrap both handlers into a multi-handler wrapper
 *   whose `handlers` array is captured by reference and mutated in place by
 *   future `on` / `off` calls.
 * - Multi-handler slot → push (append) or unshift (prepend) into the existing
 *   `handlers` array; the wrapper closure sees the mutation without reinstallation.
 *
 * @internal
 */
export function _installHook<H extends Function>(
  slot: HookSlot<H>,
  handler: H,
  insert: boolean
): HookSlot<H> {
  if (slot === undefined) {
    return handler;
  }
  if ("handlers" in slot) {
    if (insert) {
      slot.handlers.unshift(handler);
    } else {
      slot.handlers.push(handler);
    }
    return slot;
  }
  const handlers = insert ? [handler, slot] : [slot, handler];
  const wrapper = ((...args: unknown[]) => {
    for (const h of handlers) {
      (h as Function)(...args);
    }
  }) as unknown as H & HookMetadata;
  wrapper.handlers = handlers;
  return wrapper;
}

/**
 * Remove a handler from a hook slot by reference.
 *
 * - Empty slot → no-op, return `undefined`.
 * - Single-handler slot, match → return `undefined` (slot becomes empty).
 * - Single-handler slot, no match → return the slot unchanged.
 * - Multi-handler slot → splice the handler from `handlers`; if one handler
 *   remains, unwrap it back to a single-handler slot; if none remain, return
 *   `undefined`.
 *
 * @internal
 */
export function _removeHook<H extends Function>(slot: HookSlot<H>, handler: H): HookSlot<H> {
  if (slot === undefined) {
    return undefined;
  }
  if (slot === handler) {
    return undefined;
  }
  if ("handlers" in slot) {
    const i = slot.handlers.indexOf(handler);
    if (i === -1) {
      return slot;
    }
    slot.handlers.splice(i, 1);
    if (slot.handlers.length === 0) {
      return undefined;
    }
    if (slot.handlers.length === 1) {
      return slot.handlers[0] as H;
    }
    return slot;
  }
  return slot;
}

/**
 * Iterate the handlers in a slot in registration order.
 *
 * Use this instead of invoking the slot directly when callers need to run
 * after each handler (e.g. a short-circuit predicate between edge policies).
 * For plain "fire and forget" dispatch, call the slot directly:
 * `this._onAdd?.(e, c)` runs every registered handler with no per-handler
 * callback opportunity.
 *
 * @internal
 */
export function _slotHandlers<H extends Function>(slot: HookSlot<H>): H[] {
  if (slot === undefined) {
    return [];
  }
  if ("handlers" in slot) {
    return slot.handlers as H[];
  }
  return [slot];
}

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
 * Lifecycle hook registration for a registered component class. Exposed by
 * {@link World.component} and on every entity.
 *
 * Hooks are a lightweight alternative to building a {@link System} when all
 * you need is a callback on add / remove / set for a single component type.
 * Registration chains because `on` / `off` return the receiver:
 *
 * ```ts
 * world.component(Sprite)
 *   .on("add", (e, c) => initSprite(e, c))
 *   .on("remove", (e, c) => destroySprite(e, c))
 *   .on("set", (e, c) => syncSprite(e, c));
 * ```
 *
 * Multiple handlers may be registered for the same event: they fire in
 * registration order (or in reverse registration order when `insert` is `true`).
 * Remove a handler with {@link ComponentMeta.off} by the same reference used
 * to register it. Callers rarely need to remove handlers.
 *
 * Callbacks fire synchronously when the corresponding entity command is
 * applied: inline outside deferred mode, or while the world drains its command
 * queue inside a system / `forEach` / `defer` block. An invariant violation
 * thrown from a handler propagates out of the applying call (or out of
 * `progress()` / `flush()` in deferred mode) and leaves the world partially
 * mutated — treat it as a programming error and discard the world.
 */
export class ComponentMeta {
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

  /** @internal Framework policy applied when this component is attached. */
  public _onPolicyAdd: HookSlot<HookHandler> = undefined;
  /** @internal Framework policy applied when this component is removed. */
  public _onPolicyRemove: HookSlot<HookHandler> = undefined;

  /** @internal Component instances created by ensure operations but not yet attached. */
  public _pendingEnsures: WeakMap<Entity, ComponentInstance> | undefined;

  /** @internal Handlers fired when a component of this type is added. */
  public _onAdd: HookSlot<HookHandler> = undefined;
  /** @internal Handlers fired when a component of this type is removed. */
  public _onRemove: HookSlot<HookHandler> = undefined;
  /** @internal Handlers fired after a relationship edge is added. */
  public _onTargetAdd: HookSlot<TargetHandler> = undefined;
  /** @internal Handlers fired after a relationship edge is removed. */
  public _onTargetRemove: HookSlot<TargetHandler> = undefined;
  /** @internal Framework policy handlers fired after a relationship edge is added. */
  public _onTargetPolicyAdd: HookSlot<TargetHandler> = undefined;
  /** @internal Framework policy handlers fired after a relationship edge is removed. */
  public _onTargetPolicyRemove: HookSlot<TargetHandler> = undefined;
  /** @internal Handlers fired when a component's data is set or modified. */
  public _onSet: HookSlot<HookHandler> = undefined;

  /**
   * @internal Reverse index of entities currently carrying this component eid.
   *
   * Lazily allocated on first attach and never reset to `undefined` afterward,
   * so a component eid that churns between 0 and 1 carriers does not thrash
   * the `DenseSet` allocation. `usageCount` reads `_carriers.size` directly.
   */
  public _carriers: DenseSet<Entity> | undefined;

  constructor(Class: ComponentType, ceid: EID) {
    this.Class = Class;
    this.eid = ceid;
    this.bitPtr = new BitPtr(ceid);
    this.isRelationship = Class.prototype instanceof Relationship;
  }

  /** Number of entities currently carrying this component eid. */
  public get usageCount(): number {
    return this._carriers?.size ?? 0;
  }

  /** @internal Record `entity` as a carrier of this component eid. */
  public _attachCarrier(entity: Entity): void {
    (this._carriers ??= new DenseSet<Entity>()).add(entity);
  }

  /** @internal Stop tracking `entity` as a carrier of this component eid. */
  public _detachCarrier(entity: Entity): void {
    this._carriers?.delete(entity);
  }

  /**
   * Register a handler for a hook event.
   *
   * Multiple handlers may be registered for the same event; they fire in
   * registration order. Pass `insert: true` to prepend the handler ahead of
   * any already-registered handlers. Removing a handler is via {@link off} with
   * the same reference.
   *
   * The `targetAdd`, `targetRemove`, `targetPolicyAdd`, and `targetPolicyRemove`
   * events require this meta to be a relationship; registering one on a
   * non-relationship meta throws at registration time.
   *
   * @param event - One of `add`, `remove`, `set`, `targetAdd`, `targetRemove`,
   *   `policyAdd`, `policyRemove`, `targetPolicyAdd`, `targetPolicyRemove`.
   * @param handler - Handler whose signature is constrained by `event`.
   * @param insert - When `true`, prepend the handler; when `false` (default), append.
   * @returns This meta, for chaining.
   */
  public on<E extends HookEvent>(event: E, handler: HookEventMap[E], insert = false): this {
    switch (event) {
      case "add":
        this._onAdd = _installHook(this._onAdd, handler as HookHandler, insert);
        break;
      case "remove":
        this._onRemove = _installHook(this._onRemove, handler as HookHandler, insert);
        break;
      case "set":
        this._onSet = _installHook(this._onSet, handler as HookHandler, insert);
        break;
      case "targetAdd":
        this._requireRelationship(event);
        this._onTargetAdd = _installHook(this._onTargetAdd, handler as TargetHandler, insert);
        break;
      case "targetRemove":
        this._requireRelationship(event);
        this._onTargetRemove = _installHook(this._onTargetRemove, handler as TargetHandler, insert);
        break;
      case "policyAdd":
        this._onPolicyAdd = _installHook(this._onPolicyAdd, handler as HookHandler, insert);
        break;
      case "policyRemove":
        this._onPolicyRemove = _installHook(this._onPolicyRemove, handler as HookHandler, insert);
        break;
      case "targetPolicyAdd":
        this._requireRelationship(event);
        this._onTargetPolicyAdd = _installHook(
          this._onTargetPolicyAdd,
          handler as TargetHandler,
          insert
        );
        break;
      case "targetPolicyRemove":
        this._requireRelationship(event);
        this._onTargetPolicyRemove = _installHook(
          this._onTargetPolicyRemove,
          handler as TargetHandler,
          insert
        );
        break;
      default: {
        const _exhaustive: never = event;
        throw new Error(`Unknown hook event: ${String(_exhaustive)}`);
      }
    }
    return this;
  }

  /**
   * Remove a previously-registered handler by reference. Idempotent: removing
   * an unregistered handler is a no-op.
   *
   * @param event - The event the handler was registered for.
   * @param handler - The exact handler reference passed to {@link on}.
   * @returns This meta, for chaining.
   */
  public off<E extends HookEvent>(event: E, handler: HookEventMap[E]): this {
    switch (event) {
      case "add":
        this._onAdd = _removeHook(this._onAdd, handler as HookHandler);
        break;
      case "remove":
        this._onRemove = _removeHook(this._onRemove, handler as HookHandler);
        break;
      case "set":
        this._onSet = _removeHook(this._onSet, handler as HookHandler);
        break;
      case "targetAdd":
        this._requireRelationship(event);
        this._onTargetAdd = _removeHook(this._onTargetAdd, handler as TargetHandler);
        break;
      case "targetRemove":
        this._requireRelationship(event);
        this._onTargetRemove = _removeHook(this._onTargetRemove, handler as TargetHandler);
        break;
      case "policyAdd":
        this._onPolicyAdd = _removeHook(this._onPolicyAdd, handler as HookHandler);
        break;
      case "policyRemove":
        this._onPolicyRemove = _removeHook(this._onPolicyRemove, handler as HookHandler);
        break;
      case "targetPolicyAdd":
        this._requireRelationship(event);
        this._onTargetPolicyAdd = _removeHook(this._onTargetPolicyAdd, handler as TargetHandler);
        break;
      case "targetPolicyRemove":
        this._requireRelationship(event);
        this._onTargetPolicyRemove = _removeHook(
          this._onTargetPolicyRemove,
          handler as TargetHandler
        );
        break;
      default: {
        const _exhaustive: never = event;
        throw new Error(`Unknown hook event: ${String(_exhaustive)}`);
      }
    }
    return this;
  }

  private _requireRelationship(event: HookEvent): void {
    if (!this.isRelationship) {
      throw new Error(`"${event}" hooks can only be registered on a Relationship component`);
    }
  }
}

/**
 * An array of component classes or numeric type ids, used by query helpers.
 *
 * @internal
 */
export type ComponentRefArray = ComponentRef[];
