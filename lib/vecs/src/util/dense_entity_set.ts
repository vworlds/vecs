import type { Entity } from "../entity/index.js";

type Cursor = { next: number };
type Direct = { dense: Entity[]; positions: number[]; cursors: Cursor[] };
const DENSITY = 8;

/**
 * Live entity membership with native Set storage for sparse populations and
 * cursor-safe dense storage for populations that justify direct id lookup.
 * Removal order is unspecified. Deleted entries are skipped, additions are
 * visited, and only reinsertions can repeat, including in nested traversals.
 * Representation changes occur only when no traversal is active.
 * @internal
 */
export class DenseEntitySet implements Iterable<Entity> {
  private _members: Set<Entity> | undefined = new Set();
  /** Allocate arrays and cursor storage only after promotion. */
  private _direct: Direct | undefined;
  /** Highest sparse member id; undefined means recompute on the next insertion. */
  private _highest: number | undefined = 0;
  private _active = 0;

  public get size(): number {
    return this._members !== undefined ? this._members.size : this._direct!.dense.length;
  }

  public *[Symbol.iterator](): IterableIterator<Entity> {
    this._active++;
    try {
      if (this._members !== undefined) {
        yield* this._members;
      } else {
        const direct = this._direct!;
        const cursor = { next: 0 };
        direct.cursors.push(cursor);
        try {
          while (cursor.next < direct.dense.length) {
            yield direct.dense[cursor.next++]!;
          }
        } finally {
          this._release(direct, cursor);
        }
      }
    } finally {
      this._active--;
    }
  }

  /** Add a live entity; promote a sufficiently dense idle population. */
  public add(entity: Entity): this {
    const members = this._members;
    if (members !== undefined) {
      const count = members.size;
      members.add(entity);
      if (members.size !== count) {
        if (this._highest === undefined) {
          this._highest = 0;
          for (const member of members) {
            this._highest = Math.max(this._highest, member.eid);
          }
        } else {
          this._highest = Math.max(this._highest, entity.eid);
        }
        if (this._active === 0 && members.size * DENSITY >= this._highest + 1) {
          this._promote(members);
        }
      }
    } else {
      const direct = this._direct!;
      if (this._position(direct, entity) < 0) {
        direct.dense.push(entity);
        this._record(direct, entity, direct.dense.length - 1);
      }
    }
    return this;
  }

  /** Clear membership; active traversals still visit subsequent additions. */
  public clear(): void {
    if (this._members !== undefined) {
      this._members.clear();
      this._highest = 0;
    } else if (this._active === 0) {
      this._demote();
    } else {
      const direct = this._direct!;
      direct.dense.length = 0;
      direct.positions.length = 0;
      for (const cursor of direct.cursors) {
        cursor.next = 0;
      }
    }
  }

  /** Remove only this object, never a newer entity reusing its id. */
  public delete(entity: Entity): boolean {
    const members = this._members;
    if (members !== undefined) {
      const removed = members.delete(entity);
      if (removed && entity.eid === this._highest) {
        this._highest = members.size === 0 ? 0 : undefined;
      }
      return removed;
    }
    const direct = this._direct!;
    const index = this._position(direct, entity);
    if (index < 0) {
      return false;
    }
    let hole = index;
    // Move one boundary entry per distinct cursor position, in ascending
    // order. Equal-position cursors step back together, without moving twice.
    direct.cursors.sort((a, b) => a.next - b.next);
    let boundary = -1;
    for (const cursor of direct.cursors) {
      const next = cursor.next;
      if (next > index) {
        if (next !== boundary) {
          this._move(direct, next - 1, hole);
          hole = next - 1;
          boundary = next;
        }
        cursor.next--;
      }
    }
    this._move(direct, direct.dense.length - 1, hole);
    direct.dense.pop();
    direct.positions[entity.eid] = 0;
    if (direct.dense.length === 0 && this._active === 0) {
      this._demote();
    }
    return true;
  }

  /** Traverse live membership without a generator, counting nested traversals. */
  public forEachLive(callback: (entity: Entity) => void): void {
    // No callback or suspension is possible on this empty, uncounted path.
    if (this.size === 0) {
      return;
    }
    this._active++;
    try {
      if (this._members !== undefined) {
        for (const entity of this._members) {
          callback(entity);
        }
      } else {
        const direct = this._direct!;
        const cursor = { next: 0 };
        direct.cursors.push(cursor);
        try {
          while (cursor.next < direct.dense.length) {
            callback(direct.dense[cursor.next++]!);
          }
        } finally {
          this._release(direct, cursor);
        }
      }
    } finally {
      this._active--;
    }
  }

  /** Identity is checked in direct mode because entity ids can be recycled. */
  public has(entity: Entity): boolean {
    return this._members !== undefined
      ? this._members.has(entity)
      : this._position(this._direct!, entity) >= 0;
  }

  private _demote(): void {
    this._direct = undefined;
    this._members = new Set();
    this._highest = 0;
  }

  private _move(direct: Direct, from: number, to: number): void {
    if (from !== to) {
      const entity = direct.dense[from]!;
      direct.dense[to] = entity;
      direct.positions[entity.eid] = to + 1;
    }
  }

  private _position(direct: Direct, entity: Entity): number {
    const slot = direct.positions[entity.eid];
    return slot > 0 && direct.dense[slot - 1] === entity ? slot - 1 : -1;
  }

  private _promote(members: Set<Entity>): void {
    const direct: Direct = { dense: [...members], positions: [], cursors: [] };
    for (let i = 0; i < direct.dense.length; i++) {
      this._record(direct, direct.dense[i]!, i);
    }
    this._direct = direct;
    this._members = undefined;
  }

  private _record(direct: Direct, entity: Entity, position: number): void {
    // Push intervening zeros rather than assigning past the array's length.
    while (direct.positions.length <= entity.eid) {
      direct.positions.push(0);
    }
    direct.positions[entity.eid] = position + 1;
  }

  private _release(direct: Direct, cursor: Cursor): void {
    direct.cursors.splice(direct.cursors.indexOf(cursor), 1);
  }
}
