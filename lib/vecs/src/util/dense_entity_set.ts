import type { Entity } from "../entity/index.js";

type Cursor = { next: number };
const DENSITY = 8;
const SLACK = 1024;
const MIN_DIRECT = 8;

/**
 * Live entity membership with native Set storage for sparse populations and
 * cursor-safe dense storage for populations that justify direct id lookup.
 * Removal order is unspecified. Deleted entries are skipped, additions are
 * visited, and only reinsertions can repeat, including in nested traversals.
 * Fixed promotion slack makes small low-id populations direct. Sparse membership
 * keeps a monotone highest-id bound until emptying.
 * Representation changes occur only when no traversal is active.
 * @internal
 */
export class DenseEntitySet implements Iterable<Entity> {
  private _members: Set<Entity> | undefined = new Set();
  /** Allocate arrays and cursor storage only after promotion. */
  private _dense: Entity[] | undefined;
  private _positions: number[] | undefined;
  private _cursors: Cursor[] | undefined;
  /** Monotone upper bound on sparse member ids; reset only at empty. */
  private _highest = 0;
  private _active = 0;

  public get size(): number {
    return this._members !== undefined ? this._members.size : this._dense!.length;
  }

  public *[Symbol.iterator](): IterableIterator<Entity> {
    this._active++;
    try {
      if (this._members !== undefined) {
        yield* this._members;
      } else {
        const dense = this._dense!;
        const cursors = this._cursors!;
        const cursor = { next: 0 };
        cursors.push(cursor);
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

  /**
   * Add a live entity; promote by absolute-id density plus fixed slack only while idle.
   * Sparse insertion detects duplicates by size, without a separate hash probe.
   */
  public add(entity: Entity): boolean {
    const members = this._members;
    if (members !== undefined) {
      const size = members.size;
      members.add(entity);
      if (members.size === size) {
        return false;
      }
      this._highest = Math.max(this._highest, entity.eid);
      if (
        this._active === 0 &&
        (members.size * DENSITY >= this._highest + 1 ||
          (members.size >= MIN_DIRECT && members.size * DENSITY + SLACK >= this._highest + 1))
      ) {
        this._promote(members);
      }
    } else {
      const dense = this._dense!;
      if (this._position(entity) >= 0) {
        return false;
      }
      if (
        this._active === 0 &&
        Math.max(entity.eid + 1, this._positions!.length) >
          2 * ((dense.length + 1) * DENSITY + SLACK)
      ) {
        this._demote(true);
        this._members!.add(entity);
        this._highest = Math.max(this._highest, entity.eid);
        return true;
      }
      dense.push(entity);
      this._record(entity, dense.length - 1);
    }
    return true;
  }

  /** Clear membership; active traversals still visit subsequent additions. */
  public clear(): void {
    if (this._members !== undefined) {
      this._members.clear();
      this._highest = 0;
    } else if (this._active === 0) {
      this._demote();
    } else {
      this._dense!.length = 0;
      this._positions!.length = 0;
      for (const cursor of this._cursors!) {
        cursor.next = 0;
      }
    }
  }

  /** Remove only this object, never a newer entity reusing its id. */
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
    if (cursors.length === 0) {
      this._move(dense.length - 1, index);
      dense.pop();
      this._positions![entity.eid] = 0;
      if (dense.length === 0 && this._active === 0) {
        this._demote();
      }
      return true;
    }
    let hole = index;
    // Move one boundary entry per distinct cursor position, in ascending
    // order. Equal-position cursors step back together, without moving twice.
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
    this._positions![entity.eid] = 0;
    if (dense.length === 0 && this._active === 0) {
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
        const dense = this._dense!;
        const cursors = this._cursors!;
        const cursor = { next: 0 };
        cursors.push(cursor);
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

  /** Identity is checked in direct mode because entity ids can be recycled. */
  public has(entity: Entity): boolean {
    return this._members !== undefined ? this._members.has(entity) : this._position(entity) >= 0;
  }

  private _demote(preserve = false): void {
    const members = new Set<Entity>();
    this._highest = 0;
    if (preserve) {
      for (const entity of this._dense!) {
        members.add(entity);
        this._highest = Math.max(this._highest, entity.eid);
      }
    }
    this._dense = undefined;
    this._positions = undefined;
    this._cursors = undefined;
    this._members = members;
  }

  private _move(from: number, to: number): void {
    if (from !== to) {
      const entity = this._dense![from]!;
      this._dense![to] = entity;
      this._positions![entity.eid] = to + 1;
    }
  }

  private _position(entity: Entity): number {
    const slot = this._positions![entity.eid];
    return slot > 0 && this._dense![slot - 1] === entity ? slot - 1 : -1;
  }

  private _promote(members: Set<Entity>): void {
    const dense = [...members];
    this._dense = dense;
    this._positions = [];
    this._cursors = [];
    for (let i = 0; i < dense.length; i++) {
      this._record(dense[i]!, i);
    }
    this._members = undefined;
  }

  private _record(entity: Entity, position: number): void {
    const positions = this._positions!;
    // Push intervening entries rather than assigning past the array's length.
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
