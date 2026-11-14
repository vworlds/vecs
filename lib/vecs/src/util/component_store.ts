import type { ComponentInstance } from "../component_meta.js";
import type { Entity } from "../entity/index.js";

type Cursor = { next: number };
const DENSITY = 16;

/**
 * Component instances and live carrier membership in one density-adaptive store.
 * Direct-mode cursor mechanics deliberately mirror DenseEntitySet: composition
 * would add a second lookup hop, while inheritance would couple term storage to
 * its container. Sparse stores allocate no id-indexed arrays.
 * @internal
 */
export class ComponentStore implements Iterable<Entity> {
  private _members: Map<Entity, ComponentInstance> | undefined = new Map();
  private _dense: Entity[] | undefined;
  private _instances: ComponentInstance[] | undefined;
  private _positions: number[] | undefined;
  private _cursors: Cursor[] | undefined;
  private _highest = 0;
  private _active = 0;

  public get size(): number {
    return this._members !== undefined ? this._members.size : this._dense!.length;
  }

  public *[Symbol.iterator](): IterableIterator<Entity> {
    this._active++;
    try {
      if (this._members !== undefined) {
        yield* this._members.keys();
      } else {
        const dense = this._dense!;
        const cursor = { next: 0 };
        this._cursors!.push(cursor);
        try {
          while (cursor.next < dense.length) {
            yield dense[cursor.next++]!;
          }
        } finally {
          this._release(cursor);
        }
      }
    } finally {
      this._active--;
    }
  }

  /** Term's generic insertion must never create membership without an instance. */
  public add(entity: Entity): boolean {
    const instance = this.get(entity);
    if (instance === undefined) {
      throw new Error("Component membership requires a stored instance");
    }
    return false;
  }

  /** Insert or replace without changing carrier order; return whether new. */
  public set(entity: Entity, instance: ComponentInstance): boolean {
    const members = this._members;
    if (members !== undefined) {
      const existed = members.has(entity);
      members.set(entity, instance);
      if (!existed) {
        this._highest = Math.max(this._highest, entity.eid);
        if (this._active === 0 && members.size * DENSITY >= this._highest + 1) {
          this._promote(members);
        }
      }
      return !existed;
    }
    const index = this._position(entity);
    if (index >= 0) {
      this._instances![index] = instance;
      return false;
    }
    this._dense!.push(entity);
    this._instances!.push(instance);
    this._record(entity, this._dense!.length - 1);
    return true;
  }

  /** Empty active traversals still visit subsequent additions. */
  public clear(): void {
    if (this._members !== undefined) {
      this._members.clear();
      this._highest = 0;
    } else if (this._active === 0) {
      this._demote();
    } else {
      this._dense!.length = 0;
      this._instances!.length = 0;
      this._positions!.length = 0;
      this._highest = 0;
      for (const cursor of this._cursors!) {
        cursor.next = 0;
      }
    }
  }

  /** Remove this object only; nested live traversals never skip a moved entry. */
  public delete(entity: Entity): boolean {
    const members = this._members;
    if (members !== undefined) {
      const removed = members.delete(entity);
      if (members.size === 0) {
        this._highest = 0;
      }
      return removed;
    }
    const dense = this._dense!;
    const cursors = this._cursors!;
    const index = this._position(entity);
    if (index < 0) {
      return false;
    }
    let hole = index;
    if (cursors.length > 1) {
      cursors.sort((a, b) => a.next - b.next);
    }
    let boundary = -1;
    for (const cursor of cursors) {
      const next = cursor.next;
      if (next > index) {
        if (next !== boundary) {
          this._move(next - 1, hole);
          hole = next - 1;
          boundary = next;
        }
        cursor.next--;
      }
    }
    this._move(dense.length - 1, hole);
    dense.pop();
    this._instances!.pop();
    this._positions![entity.eid] = 0;
    if (dense.length === 0) {
      this._highest = 0;
      if (this._active === 0) {
        this._demote();
      }
    }
    return true;
  }

  /** Visit additions and skip deletions, including under nested callbacks. */
  public forEachLive(callback: (entity: Entity) => void): void {
    if (this.size === 0) {
      return;
    }
    this._active++;
    try {
      if (this._members !== undefined) {
        for (const entity of this._members.keys()) {
          callback(entity);
        }
      } else {
        const dense = this._dense!;
        const cursor = { next: 0 };
        this._cursors!.push(cursor);
        try {
          while (cursor.next < dense.length) {
            callback(dense[cursor.next++]!);
          }
        } finally {
          this._release(cursor);
        }
      }
    } finally {
      this._active--;
    }
  }

  /** Identity-checked instance lookup, without a world-registry hop. */
  public get(entity: Entity): ComponentInstance | undefined {
    if (this._members !== undefined) {
      return this._members.get(entity);
    }
    const slot = this._positions![entity.eid];
    return slot > 0 && this._dense![slot - 1] === entity ? this._instances![slot - 1] : undefined;
  }

  public has(entity: Entity): boolean {
    return this.get(entity) !== undefined;
  }

  private _demote(): void {
    this._dense = undefined;
    this._instances = undefined;
    this._positions = undefined;
    this._cursors = undefined;
    this._members = new Map();
    this._highest = 0;
  }

  private _move(from: number, to: number): void {
    if (from !== to) {
      const entity = this._dense![from]!;
      this._dense![to] = entity;
      this._instances![to] = this._instances![from]!;
      this._positions![entity.eid] = to + 1;
    }
  }

  private _position(entity: Entity): number {
    const slot = this._positions![entity.eid];
    return slot > 0 && this._dense![slot - 1] === entity ? slot - 1 : -1;
  }

  private _promote(members: Map<Entity, ComponentInstance>): void {
    this._dense = [...members.keys()];
    this._instances = [...members.values()];
    this._positions = [];
    this._cursors = [];
    for (let i = 0; i < this._dense.length; i++) {
      this._record(this._dense[i]!, i);
    }
    this._members = undefined;
  }

  private _record(entity: Entity, position: number): void {
    const positions = this._positions!;
    while (positions.length <= entity.eid) {
      positions.push(0);
    }
    positions[entity.eid] = position + 1;
  }

  private _release(cursor: Cursor): void {
    const cursors = this._cursors!;
    cursors.splice(cursors.indexOf(cursor), 1);
  }
}
