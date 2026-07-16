import { Entity, type EID } from "../entity/index.js";
import { type World } from "../world/index.js";
import { Group } from "./group.js";

type EntityKeys = undefined | unknown | ReadonlySet<unknown>;

export class Grouping {
  public readonly groups = new Map<unknown, Group>();
  private readonly _entityKeys = new Map<Entity, EntityKeys>();
  private readonly _keysOf: (e: Entity) => Iterable<unknown>;
  private readonly _watchEids: Set<EID>;
  private readonly _world: World;
  private _onGroupEnter: ((group: Group) => void) | undefined;
  private _onGroupExit: ((key: unknown, group: Group) => void) | undefined;

  public constructor(
    world: World,
    keysOf: (e: Entity) => Iterable<unknown>,
    watchEids: Iterable<EID>
  ) {
    this._world = world;
    this._keysOf = keysOf;
    this._watchEids = new Set(watchEids);
  }

  public clear(): void {
    this.groups.clear();
    this._entityKeys.clear();
  }

  public enter(e: Entity): void {
    this._assign(e, this._keysOf(e));
  }

  public exit(e: Entity): void {
    const keys = this._entityKeys.get(e);
    if (keys !== undefined) {
      this._forEachKey(keys, (key) => this._removeFromBucket(e, key));
    }
    this._entityKeys.delete(e);
  }

  public get(key: unknown): Group | undefined {
    return this.groups.get(key);
  }

  public keys(): IterableIterator<unknown> {
    return this.groups.keys();
  }

  public refresh(e: Entity, ceid: EID): void {
    if (!this._watchEids.has(ceid)) {
      return;
    }
    this._assign(e, this._keysOf(e));
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

  private _assign(e: Entity, keys: Iterable<unknown>): void {
    const oldKeys = this._entityKeys.get(e);
    let first: unknown = undefined;
    let second: unknown = undefined;
    let newKeys: Set<unknown> | undefined = undefined;
    let count = 0;
    for (const key of keys) {
      if (key === undefined) {
        continue;
      }
      count++;
      if (count === 1) {
        first = key;
      } else if (count === 2) {
        second = key;
      } else {
        newKeys ??= new Set<unknown>([first!, second!]);
        newKeys.add(key);
      }
    }
    if (newKeys !== undefined) {
      this._diffKeys(e, oldKeys, newKeys);
      this._entityKeys.set(e, newKeys);
      return;
    }
    if (count === 0) {
      if (oldKeys !== undefined) {
        this._forEachKey(oldKeys, (key) => this._removeFromBucket(e, key));
      }
      this._entityKeys.delete(e);
      return;
    }
    if (count === 1) {
      this._assignOne(e, oldKeys, first);
      return;
    }
    this._assignTwo(e, oldKeys, first, second);
  }

  private _assignOne(e: Entity, oldKeys: EntityKeys, newKey: unknown): void {
    if (oldKeys === undefined) {
      this._addToBucket(e, newKey);
      this._entityKeys.set(e, newKey);
      return;
    }
    if (oldKeys instanceof Set) {
      oldKeys.forEach((key) => {
        if (key !== newKey) {
          this._removeFromBucket(e, key);
        }
      });
      if (!oldKeys.has(newKey)) {
        this._addToBucket(e, newKey);
      }
    } else if (oldKeys !== newKey) {
      this._removeFromBucket(e, oldKeys);
      this._addToBucket(e, newKey);
    }
    this._entityKeys.set(e, newKey);
  }

  private _assignTwo(e: Entity, oldKeys: EntityKeys, first: unknown, second: unknown): void {
    const newKeys = new Set<unknown>([first, second]);
    this._diffKeys(e, oldKeys, newKeys);
    this._entityKeys.set(e, newKeys);
  }

  private _diffKeys(e: Entity, oldKeys: EntityKeys, newKeys: ReadonlySet<unknown>): void {
    this._forEachKey(oldKeys, (key) => {
      if (!newKeys.has(key)) {
        this._removeFromBucket(e, key);
      }
    });
    newKeys.forEach((key) => {
      if (!this._hasKey(oldKeys, key)) {
        this._addToBucket(e, key);
      }
    });
  }

  private _forEachKey(keys: EntityKeys, fn: (key: unknown) => void): void {
    if (keys === undefined) {
      return;
    }
    if (keys instanceof Set) {
      keys.forEach(fn);
      return;
    }
    fn(keys);
  }

  private _hasKey(keys: EntityKeys, key: unknown): boolean {
    if (keys === undefined) {
      return false;
    }
    if (keys instanceof Set) {
      return keys.has(key);
    }
    return keys === key;
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
