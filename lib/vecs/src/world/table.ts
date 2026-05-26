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
  /** Entities whose component set exactly matches {@link archetype}. */
  public readonly entities = new Set<Entity>();
  /** @internal Sorted component eids contained in this archetype. */
  public readonly _componentEids: number[];

  /** @internal Component eid -> table reached by adding that component. */
  private readonly _addEdges = new ArrayMap<Table>();
  /** @internal Component eid -> table reached by removing that component. */
  private readonly _removeEdges = new ArrayMap<Table>();

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

  /** @internal Record that `e` now belongs to this table. */
  public _addEntity(e: Entity): void {
    this.entities.add(e);
  }

  /** @internal Record that `e` no longer belongs to this table. */
  public _removeEntity(e: Entity): void {
    this.entities.delete(e);
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
