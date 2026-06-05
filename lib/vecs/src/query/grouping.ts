import { Entity } from "../entity/index.js";
import { type World } from "../world/index.js";
import { Group } from "./group.js";

export class Grouping {
  public readonly groups = new Map<unknown, Group>();
  private readonly _entityKeys = new Map<Entity, unknown>();
  private readonly _keyOf: (e: Entity) => unknown;
  private readonly _watchEids: Set<number>;
  private readonly _world: World;
  private _onGroupEnter: ((group: Group) => void) | undefined;
  private _onGroupExit: ((key: unknown, group: Group) => void) | undefined;

  public constructor(world: World, keyOf: (e: Entity) => unknown, watchEids: Iterable<number>) {
    this._world = world;
    this._keyOf = keyOf;
    this._watchEids = new Set(watchEids);
  }

  public clear(): void {
    this.groups.clear();
    this._entityKeys.clear();
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

  public get(key: unknown): Group | undefined {
    return this.groups.get(key);
  }

  public keys(): IterableIterator<unknown> {
    return this.groups.keys();
  }

  public refresh(e: Entity, ceid: number): void {
    if (!this._watchEids.has(ceid)) {
      return;
    }
    this._assign(e, this._keyOf(e));
  }

  public setOnGroupEnter(callback: (group: Group) => void): void {
    this._onGroupEnter = callback;
  }

  public setOnGroupExit(callback: (key: unknown, group: Group) => void): void {
    this._onGroupExit = callback;
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
