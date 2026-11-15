import type { ComponentInstance } from "../component_meta.js";
import type { Entity } from "../entity/index.js";
import { zeroPositions } from "./zero_positions.js";

type Cursor = { next: number };
const DENSITY = 8;
const SLACK = 1024;
const MIN_DIRECT = 8;

/**
 * Component instances and live carrier membership in one density-adaptive store.
 * Direct-mode cursor mechanics deliberately mirror DenseEntitySet: composition
 * would add a second lookup hop, while inheritance would couple term storage to
 * its container. Sparse stores allocate no id-indexed arrays. Fixed promotion
 * slack makes low-id populations direct without per-mutation page bookkeeping.
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

  /**
   * Insert or replace; promote by absolute-id density plus fixed slack only while idle.
   * Sparse insertion detects new membership by size, without a separate hash probe.
   */
  public set(entity: Entity, instance: ComponentInstance): boolean {
    const members = this._members;
    if (members !== undefined) {
      const size = members.size;
      members.set(entity, instance);
      const added = members.size !== size;
      if (added) {
        this._highest = Math.max(this._highest, entity.eid);
        if (
          this._active === 0 &&
          (members.size * DENSITY >= this._highest + 1 ||
            (members.size >= MIN_DIRECT && members.size * DENSITY + SLACK >= this._highest + 1))
        ) {
          this._promote(members);
        }
      }
      return added;
    }
    const index = this._position(entity);
    if (index >= 0) {
      this._instances![index] = instance;
      return false;
    }
    if (
      this._active === 0 &&
      Math.max(entity.eid + 1, this._positions!.length) >
        2 * ((this._dense!.length + 1) * DENSITY + SLACK)
    ) {
      this._demote(true);
      this._members!.set(entity, instance);
      this._highest = Math.max(this._highest, entity.eid);
      return true;
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
    if (cursors.length === 0) {
      // Ordinary removal needs only an identity check and one tail swap.
      const last = dense.length - 1;
      if (index !== last) {
        const moved = dense[last]!;
        dense[index] = moved;
        this._instances![index] = this._instances![last]!;
        this._positions![moved.eid] = index + 1;
      }
    } else {
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
    }
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

  /** Map or flat identity-checked instance lookup, without a world-registry hop. */
  public get(entity: Entity): ComponentInstance | undefined {
    const members = this._members;
    if (members !== undefined) {
      return members.get(entity);
    }
    const slot = this._positions![entity.eid];
    return slot > 0 && this._dense![slot - 1] === entity ? this._instances![slot - 1] : undefined;
  }

  /** Test membership and identity without loading the component instance. */
  public has(entity: Entity): boolean {
    const members = this._members;
    if (members !== undefined) {
      return members.has(entity);
    }
    const slot = this._positions![entity.eid];
    return slot > 0 && this._dense![slot - 1] === entity;
  }

  private _demote(preserve = false): void {
    const members = new Map<Entity, ComponentInstance>();
    this._highest = 0;
    if (preserve) {
      for (let i = 0; i < this._dense!.length; i++) {
        const entity = this._dense![i]!;
        members.set(entity, this._instances![i]!);
        this._highest = Math.max(this._highest, entity.eid);
      }
    }
    this._dense = undefined;
    this._instances = undefined;
    this._positions = undefined;
    this._cursors = undefined;
    this._members = members;
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
    const dense = [...members.keys()];
    let highest = 0;
    for (let i = 0; i < dense.length; i++) {
      highest = Math.max(highest, dense[i]!.eid);
    }
    // Sized by the carriers' own ids, not the monotone bound, and zeroed in bulk.
    const positions = zeroPositions(highest + 1);
    for (let i = 0; i < dense.length; i++) {
      positions[dense[i]!.eid] = i + 1;
    }
    this._dense = dense;
    this._instances = [...members.values()];
    this._positions = positions;
    this._cursors = [];
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
