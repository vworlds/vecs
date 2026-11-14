import type { Entity } from "../entity/index.js";

type Cursor = { next: number };

/**
 * Dense membership for entities with unique live ids. Iteration order is
 * unspecified after removal, but visitation is live like a Set: deleted
 * entries are skipped, additions are visited, and only reinsertions can repeat.
 * Nested traversals retain their own visited prefix.
 * @internal
 */
export class DenseEntitySet implements Iterable<Entity> {
  /** Stable array identity, including across clear. Do not mutate directly. */
  public readonly dense: Entity[] = [];
  private readonly _sparse: number[] = [];
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
    if (!this.has(entity)) {
      const eid = entity.eid;
      // Push every intervening zero: a far indexed write makes V8 use
      // dictionary elements, even though the dense side stays packed.
      while (this._sparse.length <= eid) {
        this._sparse.push(0);
      }
      this.dense.push(entity);
      this._sparse[eid] = this.dense.length;
    }
    return this;
  }

  /** Clear membership; active traversals may still visit subsequent additions. */
  public clear(): void {
    this.dense.length = 0;
    this._sparse.length = 0;
    for (const cursor of this._cursors) {
      cursor.next = 0;
    }
  }

  /** Remove only this object, never a newer entity reusing its id. */
  public delete(entity: Entity): boolean {
    const slot = this._sparse[entity.eid];
    if (!(slot > 0) || this.dense[slot - 1] !== entity) {
      return false;
    }
    let hole = slot - 1;
    // Move one boundary entry per distinct cursor position, in ascending
    // order. Equal-position cursors step back together, without moving twice.
    this._cursors.sort((a, b) => a.next - b.next);
    let boundary = -1;
    for (const cursor of this._cursors) {
      const next = cursor.next;
      if (next > slot - 1) {
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
    this._sparse[entity.eid] = 0;
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
    const slot = this._sparse[entity.eid];
    return slot > 0 && this.dense[slot - 1] === entity;
  }

  private _move(from: number, to: number): void {
    if (from !== to) {
      const entity = this.dense[from]!;
      this.dense[to] = entity;
      this._sparse[entity.eid] = to + 1;
    }
  }

  private _release(cursor: Cursor): void {
    this._cursors.splice(this._cursors.indexOf(cursor), 1);
  }
}
