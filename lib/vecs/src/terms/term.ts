import { Component } from "../component.js";
import { _compile, type EntityTestFunc, type QueryDSL } from "../dsl.js";
import type { Entity } from "../entity/index.js";
import { Relationship } from "../relationship.js";
import type { World } from "../world/index.js";

export const enum TermEventKind {
  Enter,
  Exit,
}

export interface TermConsumer {
  onTermEvent(kind: TermEventKind, entity: Entity, term?: Term): void;
  onTermRefresh?(entity: Entity, term: Term): void;
}

export type TermKind =
  | "world"
  | "component"
  | "empty"
  | "all"
  | "any"
  | "not"
  | "only"
  | "predicate"
  | "target"
  | "merged";

export abstract class Term implements TermConsumer {
  /** @internal */
  protected readonly _children: Term[] = [];
  /** @internal */
  protected readonly _consumers = new Set<TermConsumer>();
  /** @internal */
  protected readonly _entities = new Set<Entity>();
  private _destroyed = false;
  private readonly _childUnsubscribes: (() => void)[] = [];

  protected constructor(
    public readonly world: World,
    public readonly key: string,
    public readonly kind: TermKind,
    private readonly _pinned: boolean,
    private readonly _onDestroy: (term: Term) => void
  ) {}

  public get count(): number {
    return this._entities.size;
  }

  public [Symbol.iterator](): IterableIterator<Entity> {
    return this._entities[Symbol.iterator]();
  }

  public children(): readonly Term[] {
    return this._children;
  }

  public has(entity: Entity): boolean {
    return this._entities.has(entity);
  }

  public onTermEvent(_kind: TermEventKind, entity: Entity): void {
    this._sync(entity);
  }

  public onTermRefresh(entity: Entity, _term: Term): void {
    this._sync(entity);
  }

  public subscribe(consumer: TermConsumer): () => void {
    if (this._destroyed) {
      throw new Error(`Cannot subscribe to destroyed ${this.kind} term`);
    }
    this._consumers.add(consumer);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this._consumers.delete(consumer);
      if (!this._pinned && this._consumers.size === 0) {
        this.destroy();
      }
    };
  }

  public destroy(): void {
    if (this._destroyed || this._pinned) {
      return;
    }
    this._destroyed = true;
    this._consumers.clear();
    while (this._childUnsubscribes.length > 0) {
      this._childUnsubscribes.pop()!();
    }
    this._entities.clear();
    this._onDestroy(this);
  }

  /** @internal */
  protected _add(entity: Entity): void {
    if (this._entities.has(entity)) {
      return;
    }
    this._entities.add(entity);
    this._emit(TermEventKind.Enter, entity);
  }

  /** @internal */
  protected _delete(entity: Entity): void {
    if (!this._entities.delete(entity)) {
      return;
    }
    this._emit(TermEventKind.Exit, entity);
  }

  /** @internal */
  protected _emitRefresh(entity: Entity): void {
    this._consumers.forEach((consumer) => consumer.onTermRefresh?.(entity, this));
  }

  /** @internal */
  protected _initializeFromWorld(): void {
    this.world.entities.forEach((entity) => {
      if (this._matches(entity)) {
        this._entities.add(entity);
      }
    });
  }

  /** @internal */
  protected _setChildren(children: readonly Term[]): void {
    this._children.push(...children);
    children.forEach((child) => {
      this._childUnsubscribes.push(child.subscribe(this));
    });
  }

  /** @internal */
  protected abstract _matches(entity: Entity): boolean;

  /** @internal */
  protected _sync(entity: Entity): void {
    if (this._matches(entity)) {
      this._add(entity);
    } else {
      this._delete(entity);
    }
  }

  private _emit(kind: TermEventKind, entity: Entity): void {
    this._consumers.forEach((consumer) => consumer.onTermEvent(kind, entity, this));
  }
}

export class WorldTerm extends Term {
  public constructor(world: World, key: string, onDestroy: (term: Term) => void) {
    super(world, key, "world", true, onDestroy);
    this._initializeFromWorld();
  }

  public entityCreated(entity: Entity): void {
    if (this._matches(entity)) {
      this._add(entity);
    }
  }

  public entityDestroyed(entity: Entity): void {
    this._delete(entity);
  }

  public entityShapeChanged(entity: Entity): void {
    if (this.has(entity)) {
      this._emitRefresh(entity);
    }
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return !entity._destroyed && !(entity instanceof Component);
  }
}

export class ComponentTerm extends Term {
  public constructor(
    world: World,
    key: string,
    public readonly componentEid: number,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "component", true, onDestroy);
    this._initializeFromWorld();
  }

  public componentAdded(entity: Entity): void {
    this._add(entity);
  }

  public componentChanged(entity: Entity): void {
    this._emitRefresh(entity);
  }

  public componentRemoved(entity: Entity): void {
    this._delete(entity);
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return !entity._destroyed && entity._get(this.componentEid) !== undefined;
  }
}

export class EmptyTerm extends Term {
  public constructor(world: World, key: string, onDestroy: (term: Term) => void) {
    super(world, key, "empty", true, onDestroy);
  }

  /** @internal */
  protected _matches(_entity: Entity): boolean {
    return false;
  }
}

export class AllTerm extends Term {
  public constructor(
    world: World,
    key: string,
    children: readonly Term[],
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "all", false, onDestroy);
    this._setChildren(children);
    this._initializeFromWorld();
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return this._children.every((child) => child.has(entity));
  }
}

export class AnyTerm extends Term {
  public constructor(
    world: World,
    key: string,
    children: readonly Term[],
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "any", false, onDestroy);
    this._setChildren(children);
    this._initializeFromWorld();
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return this._children.some((child) => child.has(entity));
  }
}

export class NotTerm extends Term {
  public constructor(
    world: World,
    key: string,
    worldTerm: Term,
    child: Term,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "not", false, onDestroy);
    this._setChildren([worldTerm, child]);
    this._initializeFromWorld();
  }

  public override onTermRefresh(_entity: Entity, _term: Term): void {
    // Shape/data refreshes do not affect a pure negation unless the child emits
    // a real membership event, or the world emits a lifecycle event.
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return this._children[0].has(entity) && !this._children[1].has(entity);
  }
}

export class OnlyTerm extends Term {
  public constructor(
    world: World,
    key: string,
    allTerm: Term,
    worldTerm: Term,
    private readonly _componentEids: readonly number[],
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "only", false, onDestroy);
    this._setChildren([allTerm, worldTerm]);
    this._initializeFromWorld();
  }

  public override onTermRefresh(entity: Entity, term: Term): void {
    if (term.kind === "world") {
      this._sync(entity);
    }
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return (
      this._children[0].has(entity) &&
      this._children[1].has(entity) &&
      entity.components.size === this._componentEids.length
    );
  }
}

export class PredicateTerm extends Term {
  public constructor(
    world: World,
    key: string,
    worldTerm: Term,
    watchedTerms: readonly Term[],
    private readonly _predicate: EntityTestFunc,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "predicate", false, onDestroy);
    this._setChildren([worldTerm, ...watchedTerms]);
    this._initializeFromWorld();
  }

  public override onTermRefresh(entity: Entity, term: Term): void {
    if (term.kind === "component") {
      this._sync(entity);
    }
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return this._children[0].has(entity) && this._predicate(entity);
  }
}

export class MergedPredicateTerm extends Term {
  private readonly _predicate: EntityTestFunc;
  private readonly _worldTerm: Term | undefined;

  public constructor(
    world: World,
    key: string,
    dsl: QueryDSL,
    worldTerm: Term | undefined,
    watchedTerms: readonly Term[],
    private readonly _usesWorldRefresh: boolean,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "merged", false, onDestroy);
    this._predicate = _compile(world, dsl);
    this._worldTerm = worldTerm;
    this._setChildren(worldTerm ? [worldTerm, ...watchedTerms] : watchedTerms);
    this._initializeFromWorld();
  }

  public override onTermRefresh(entity: Entity, term: Term): void {
    if (term.kind === "component" || (this._usesWorldRefresh && term.kind === "world")) {
      this._sync(entity);
    }
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    return !entity._destroyed && (this._worldTerm?.has(entity) ?? true) && this._predicate(entity);
  }
}

export class TargetTerm extends Term {
  public constructor(
    world: World,
    key: string,
    private readonly _relationshipEid: number,
    relationshipTerm: Term,
    private readonly _innerTerm: Term,
    onDestroy: (term: Term) => void
  ) {
    super(world, key, "target", false, onDestroy);
    this._setChildren([relationshipTerm, _innerTerm]);
    this._initializeFromWorld();
  }

  public override onTermEvent(_kind: TermEventKind, entity: Entity, term?: Term): void {
    if (term === this._children[0]) {
      this._sync(entity);
      return;
    }
    entity.children(this._relationshipEid).forEach((source) => this._sync(source));
  }

  public override onTermRefresh(entity: Entity, term: Term): void {
    if (term === this._children[0]) {
      this._sync(entity);
      return;
    }
    entity.children(this._relationshipEid).forEach((source) => this._sync(source));
  }

  /** @internal */
  protected _matches(entity: Entity): boolean {
    if (entity._destroyed) {
      return false;
    }
    const target = (entity._get(this._relationshipEid) as Relationship | undefined)?.target;
    return target !== undefined && this._innerTerm.has(target);
  }
}
