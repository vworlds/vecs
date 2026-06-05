import { type ComponentType, type ComponentRef } from "../component.js";
import { Entity } from "../entity/index.js";
import {
  forEachInjected,
  Iter,
  type FanInjectTuple,
  type MaybeResolvedInjectTuple,
} from "../inject.js";
import { type World } from "../world/index.js";
import { Predicate } from "./query.07.predicate.js";

export class Group<K = unknown, R extends ComponentType[] = []> {
  public readonly key: K;
  private readonly _world: World;
  private readonly _entities = new Set<Entity>();

  public constructor(world: World, key: K) {
    this._world = world;
    this.key = key;
  }

  public get count(): number {
    return this._entities.size;
  }

  public has(e: Entity): boolean {
    return this._entities.has(e);
  }

  public [Symbol.iterator](): IterableIterator<Entity> {
    return this._entities[Symbol.iterator]();
  }

  public forEach(callback: (e: Entity) => void): void;
  public forEach<J extends FanInjectTuple>(
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;
  public forEach<J extends FanInjectTuple>(
    cursor: typeof Entity,
    components: readonly [...J],
    callback: (e: Entity, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;
  public forEach<J extends FanInjectTuple>(
    cursor: typeof Iter,
    components: readonly [...J],
    callback: (it: Iter, resolved: MaybeResolvedInjectTuple<J, R>) => void
  ): void;
  public forEach(arg0: unknown, arg1?: unknown, arg2?: unknown): void {
    forEachInjected(this._world, this._entities, arg0, arg1, arg2);
  }

  /** @internal */
  public _add(e: Entity): void {
    this._entities.add(e);
  }

  /** @internal */
  public _remove(e: Entity): boolean {
    this._entities.delete(e);
    return this._entities.size === 0;
  }
}

export class Grouping {
  public readonly groups = new Map<unknown, Group>();
  private readonly _world: World;
  private readonly _keyOf: (e: Entity) => unknown;
  private readonly _watchEids: Set<number>;
  private readonly _entityKeys = new Map<Entity, unknown>();
  private _onGroupEnter: ((group: Group) => void) | undefined;
  private _onGroupExit: ((key: unknown, group: Group) => void) | undefined;

  public constructor(world: World, keyOf: (e: Entity) => unknown, watchEids: Iterable<number>) {
    this._world = world;
    this._keyOf = keyOf;
    this._watchEids = new Set(watchEids);
  }

  public get(key: unknown): Group | undefined {
    return this.groups.get(key);
  }

  public keys(): IterableIterator<unknown> {
    return this.groups.keys();
  }

  public setOnGroupEnter(callback: (group: Group) => void): void {
    this._onGroupEnter = callback;
  }

  public setOnGroupExit(callback: (key: unknown, group: Group) => void): void {
    this._onGroupExit = callback;
  }

  public enter(e: Entity): void {
    this._assign(e, this._keyOf(e));
  }

  public exit(e: Entity): void {
    const key = this._entityKeys.get(e);
    if (key !== undefined) {
      this._removeFromBucket(e, key);
    }
    this._entityKeys.delete(e);
  }

  public refresh(e: Entity, eid: number): void {
    if (!this._watchEids.has(eid)) {
      return;
    }
    this._assign(e, this._keyOf(e));
  }

  public clear(): void {
    this.groups.clear();
    this._entityKeys.clear();
  }

  private _assign(e: Entity, newKey: unknown): void {
    const oldKey = this._entityKeys.get(e);
    if (oldKey === newKey) {
      return;
    }
    if (oldKey !== undefined) {
      this._removeFromBucket(e, oldKey);
    }
    if (newKey === undefined) {
      this._entityKeys.delete(e);
      return;
    }
    this._addToBucket(e, newKey);
    this._entityKeys.set(e, newKey);
  }

  private _addToBucket(e: Entity, key: unknown): void {
    let group = this.groups.get(key);
    if (group === undefined) {
      group = new Group(this._world, key);
      this.groups.set(key, group);
      group._add(e);
      this._onGroupEnter?.(group);
      return;
    }
    group._add(e);
  }

  private _removeFromBucket(e: Entity, key: unknown): void {
    const group = this.groups.get(key);
    if (group === undefined) {
      return;
    }
    if (group._remove(e)) {
      this.groups.delete(key);
      this._onGroupExit?.(key, group);
    }
  }
}

export class Groups<R extends ComponentType[] = []> extends Predicate<R> {
  // groupBy is inherited from Predicate (delegates to GroupedQuery via prototype swap)
}
