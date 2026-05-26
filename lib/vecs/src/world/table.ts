import type { ComponentMeta } from "../component_meta.js";
import type { Entity } from "../entity/index.js";
import { ArrayMap } from "../util/array_map.js";
import { Bitset } from "../util/bitset.js";
import type { World } from "./world.js";

/**
 * A set of entities that all share the **exact same archetype** — the same set
 * of attached component eids, captured as an immutable {@link Bitset}.
 *
 * Every entity belongs to exactly one table at a time. When an entity's
 * archetype changes (a component is added or removed) it leaves its current
 * table and joins the table for the new archetype; a table's own archetype
 * never changes.
 *
 * Tables are reached from one another through lazily-cached neighbor edges:
 * {@link _tableAfterAdd} and {@link _tableAfterRemove} resolve the table one
 * component-bit away, so a warmed-up transition costs two pointer hops rather
 * than re-keying a bitmask. The world owns every table and indexes them by
 * component eid (see {@link World._findOrCreateTable}).
 *
 * @internal Implementation detail of archetype storage; not part of the public
 * API.
 */
export class Table {
  /** World that owns this table. */
  public readonly world: World;
  /** Canonical archetype key: the sorted component eids joined with `","`. */
  public readonly key: string;
  /**
   * Immutable archetype shared by every entity in this table. Never mutated
   * after construction; entities move between tables instead.
   */
  public readonly archetype: Bitset;
  /**
   * Entities whose component set exactly matches {@link archetype}, kept in a
   * dense array. Membership is maintained by swap-remove (see
   * {@link _removeEntity}), so iteration order is not stable across removals;
   * callers needing ordering use {@link Query.sort}. Each entity caches its
   * index here in `entity._row`, making add and remove O(1) without hashing.
   */
  public readonly entities: Entity[] = [];
  /** @internal Sorted component eids contained in this archetype. */
  public readonly _componentEids: number[];

  /** @internal Component eid -> table reached by adding that component. */
  private readonly _addEdges = new ArrayMap<Table>();
  /** @internal Component eid -> table reached by removing that component. */
  private readonly _removeEdges = new ArrayMap<Table>();
  /** @internal Callbacks notified when an entity joins, leaves, or is re-evaluated here. */
  private readonly _membershipObservers = new Set<(e: Entity) => void>();

  constructor(world: World, key: string, archetype: Bitset, componentEids: number[]) {
    this.world = world;
    this.key = key;
    this.archetype = archetype;
    this._componentEids = componentEids;
  }

  /** Returns `"Table[<key>]"`. */
  public toString(): string {
    return `Table[${this.key}]`;
  }

  /** `true` when `e` currently belongs to this table. */
  public has(e: Entity): boolean {
    return this.entities[e._row] === e;
  }

  /** @internal Record that `e` now belongs to this table and notify observers. */
  public _addEntity(e: Entity): void {
    e._row = this.entities.push(e) - 1;
    this._notifyMembership(e);
  }

  /**
   * @internal Record initial membership for a freshly created entity *without*
   * notifying observers. Entity creation does not route to queries; queries
   * pick the entity up on its first archetype change or via backfill.
   */
  public _addInitialEntity(e: Entity): void {
    e._row = this.entities.push(e) - 1;
  }

  /** @internal Notify observers that `e` no longer belongs to this table. */
  public _removeEntity(e: Entity): void {
    this._notifyMembership(e);
    this._removeRow(e);
  }

  /**
   * @internal Re-run every membership observer for `e` without changing
   * membership. Used when an entity's data (e.g. a relationship target)
   * changes in a way that can flip a query predicate without an archetype move.
   */
  public _notifyMembership(e: Entity): void {
    const observers = this._membershipObservers;
    if (observers.size === 0) {
      return;
    }
    observers.forEach((observer) => observer(e));
  }

  /**
   * @internal Remove `e` from the dense list by swapping the last entity into
   * its slot. Idempotent: a no-op when `e` is no longer present (which can
   * happen if a re-entrant observer already removed it).
   */
  private _removeRow(e: Entity): void {
    const entities = this.entities;
    const row = e._row;
    if (entities[row] !== e) {
      return;
    }
    const last = entities.pop()!;
    if (last !== e) {
      entities[row] = last;
      last._row = row;
    }
  }

  /**
   * @internal Register `observer`, invoked whenever an entity joins, leaves, or
   * is re-evaluated against this table. Returns a disposer that unregisters it.
   */
  public _observeMembership(observer: (e: Entity) => void): () => void {
    this._membershipObservers.add(observer);
    return () => {
      this._membershipObservers.delete(observer);
    };
  }

  /**
   * @internal Resolve the table reached by adding `meta` to this archetype,
   * caching the edge (and its reverse) on first use.
   */
  public _tableAfterAdd(meta: ComponentMeta): Table {
    let next = this._addEdges.get(meta.eid);
    if (next === undefined) {
      const archetype = this.archetype.clone();
      archetype.addBit(meta.bitPtr);
      next = this.world._findOrCreateTable(archetype);
      this._addEdges.set(meta.eid, next);
      next._removeEdges.set(meta.eid, this);
    }
    return next;
  }

  /**
   * @internal Resolve the table reached by removing `meta` from this archetype,
   * caching the edge (and its reverse) on first use.
   */
  public _tableAfterRemove(meta: ComponentMeta): Table {
    let next = this._removeEdges.get(meta.eid);
    if (next === undefined) {
      const archetype = this.archetype.clone();
      archetype.deleteBit(meta.bitPtr);
      next = this.world._findOrCreateTable(archetype);
      this._removeEdges.set(meta.eid, next);
      next._addEdges.set(meta.eid, this);
    }
    return next;
  }
}
