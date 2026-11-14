import type { Entity } from "../entity/index.js";

type Cursor = { next: number };
const DENSITY = 8;

/**
 * Dense membership for entities with unique live ids. Iteration order is
 * unspecified after removal, but visitation is live like a Set: deleted
 * entries are skipped, additions are visited, and only reinsertions can repeat.
 * Nested traversals retain their own visited prefix.
 * Sparse populations use a hashed position index. When the member count
 * justifies an id-indexed array, insertion promotes the set to direct lookup.
 * The direct index is retained until the set becomes empty.
 * @internal
 */
export class DenseEntitySet implements Iterable<Entity> {
  /** Stable array identity, including across clear. Do not mutate directly. */
  public readonly dense: Entity[] = [];
  private _sparse: number[] | undefined;
  private _hashed: Map<Entity, number> | undefined = new Map();
  /** Highest current member id in hashed mode; undefined means recompute on insertion. */
  private _highest: number | undefined = 0;
  private readonly _cursors: Cursor[] = [];

  public get size(): number {
    return this.dense.length;
  }

  public *[Symbol.iterator](): IterableIterator<Entity> {
    const cursor = { next: 0 };
    this._cursors.push(cursor);
    try {
      while (cursor.next < this.dense.length) {
        yield this.dense[cursor.next++]!;
      }
    } finally {
      this._release(cursor);
    }
  }

  /** Add a live entity; duplicate insertion is a no-op. */
  public add(entity: Entity): this {
    if (this._position(entity) < 0) {
      this.dense.push(entity);
      this._record(entity, this.dense.length - 1);
      if (this._sparse === undefined) {
        if (this._highest === undefined) {
          this._highest = 0;
          for (const member of this.dense) {
            this._highest = Math.max(this._highest, member.eid);
          }
        } else {
          this._highest = Math.max(this._highest, entity.eid);
        }
        if (this.dense.length * DENSITY >= this._highest + 1) {
          this._promote();
        }
      }
    }
    return this;
  }

  /** Clear membership; active traversals may still visit subsequent additions. */
  public clear(): void {
    this.dense.length = 0;
    this._resetIndex();
    for (const cursor of this._cursors) {
      cursor.next = 0;
    }
  }

  /** Remove only this object, never a newer entity reusing its id. */
  public delete(entity: Entity): boolean {
    const index = this._position(entity);
    if (index < 0) {
      return false;
    }
    let hole = index;
    // Move one boundary entry per distinct cursor position, in ascending
    // order. Equal-position cursors step back together, without moving twice.
    this._cursors.sort((a, b) => a.next - b.next);
    let boundary = -1;
    for (const cursor of this._cursors) {
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
    this._move(this.dense.length - 1, hole);
    this.dense.pop();
    this._record(entity, -1);
    if (this.dense.length === 0) {
      this._resetIndex();
    } else if (this._sparse === undefined && entity.eid === this._highest) {
      this._highest = undefined;
    }
    return true;
  }

  /** Callback traversal avoids allocating a generator on hot paths. */
  public forEachLive(callback: (entity: Entity) => void): void {
    if (this.dense.length === 0) {
      return;
    }
    const cursor = { next: 0 };
    this._cursors.push(cursor);
    try {
      while (cursor.next < this.dense.length) {
        callback(this.dense[cursor.next++]!);
      }
    } finally {
      this._release(cursor);
    }
  }

  /** Identity is checked because world entity ids can be recycled. */
  public has(entity: Entity): boolean {
    return this._position(entity) >= 0;
  }

  /** Return this object's dense position, or -1 when absent, including stale ids. */
  public indexOf(entity: Entity): number {
    return this._position(entity);
  }

  private _move(from: number, to: number): void {
    if (from !== to) {
      const entity = this.dense[from]!;
      this.dense[to] = entity;
      this._record(entity, to);
    }
  }

  private _position(entity: Entity): number {
    const sparse = this._sparse;
    if (sparse === undefined) {
      return this._hashed!.get(entity) ?? -1;
    }
    const slot = sparse[entity.eid];
    return slot > 0 && this.dense[slot - 1] === entity ? slot - 1 : -1;
  }

  private _promote(): void {
    const sparse: number[] = [];
    for (let i = 0; i < this.dense.length; i++) {
      const entity = this.dense[i]!;
      while (sparse.length <= entity.eid) {
        sparse.push(0);
      }
      sparse[entity.eid] = i + 1;
    }
    this._sparse = sparse;
    this._hashed = undefined;
  }

  /** Record a dense position, or remove the index entry when position is -1. */
  private _record(entity: Entity, position: number): void {
    const sparse = this._sparse;
    if (sparse === undefined) {
      if (position < 0) {
        this._hashed!.delete(entity);
      } else {
        this._hashed!.set(entity, position);
      }
    } else {
      // Push intervening zeros rather than assigning past the array's length.
      while (sparse.length <= entity.eid) {
        sparse.push(0);
      }
      sparse[entity.eid] = position + 1;
    }
  }

  private _release(cursor: Cursor): void {
    this._cursors.splice(this._cursors.indexOf(cursor), 1);
  }

  private _resetIndex(): void {
    if (this._sparse !== undefined) {
      this._sparse = undefined;
      this._hashed = new Map();
    } else {
      this._hashed!.clear();
    }
    this._highest = 0;
  }
}
