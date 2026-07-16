import { Entity, type EID } from "../entity/index.js";
import { type World } from "../world/index.js";
import { Group } from "./group.js";

export class Grouping {
  public readonly groups = new Map<unknown, Group>();
  private readonly _entityKeys = new Map<Entity, ReadonlySet<unknown>>();
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
    this._entityKeys.get(e)?.forEach((key) => this._removeFromBucket(e, key));
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
    const oldKeys = this._entityKeys.get(e) ?? new Set();
    const newKeys = new Set([...keys].filter((key) => key !== undefined));
    oldKeys.forEach((key) => {
      if (!newKeys.has(key)) {
        this._removeFromBucket(e, key);
      }
    });
    newKeys.forEach((key) => {
      if (!oldKeys.has(key)) {
        this._addToBucket(e, key);
      }
    });
    if (newKeys.size === 0) {
      this._entityKeys.delete(e);
      return;
    }
    this._entityKeys.set(e, newKeys);
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
