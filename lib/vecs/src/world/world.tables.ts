import type { Entity } from "../entity/index.js";
import { ArrayMap } from "../util/array_map.js";
import { Bitset } from "../util/bitset.js";
import { Table } from "./table.js";
import { Storage } from "./world.storage.js";
import type { World } from "./world.js";

/**
 * Archetype-table storage for the world.
 *
 * Maintains the global archetype index: a `key -> Table` map that owns every
 * table, plus a component-eid -> tables index used to find which tables may
 * contain a given component. Entities are placed into the empty table on
 * creation and move between tables as their component set changes (see
 * {@link Entity}).
 */
export class Tables extends Storage {
  /** @internal Canonical archetype key -> table. Owns every table. */
  protected _tables = new Map<string, Table>();
  /** @internal Component eid -> tables whose archetype contains that component. */
  protected _tablesByComponent = new ArrayMap<Set<Table>>();
  /** @internal Callbacks notified when a new table is created. */
  protected _onTableCreated = new Set<(t: Table) => void>();
  /** @internal The table holding entities with no components attached. */
  public _emptyTable: Table = this._findOrCreateTable(new Bitset());

  /**
   * @internal Find the table for `archetype`, creating and indexing it on a
   * miss. The passed bitset is taken to be owned by the new table; callers must
   * not mutate it afterwards.
   */
  public _findOrCreateTable(archetype: Bitset): Table {
    const componentEids = archetype.indices();
    const key = componentEids.join(",");
    const existing = this._tables.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const table = new Table(this as unknown as World, key, archetype, componentEids);
    this._tables.set(key, table);
    componentEids.forEach((eid) => {
      let tables = this._tablesByComponent.get(eid);
      if (tables === undefined) {
        tables = new Set<Table>();
        this._tablesByComponent.set(eid, tables);
      }
      tables.add(table);
    });
    this._onTableCreated.forEach((callback) => callback(table));
    return table;
  }

  /** @internal Visit every table currently registered with the world. */
  public _forEachTable(callback: (t: Table) => void): void {
    this._tables.forEach(callback);
  }

  /** @internal Visit every table whose archetype contains component `eid`. */
  public _forEachTableForComponent(eid: number, callback: (t: Table) => void): void {
    this._tablesByComponent.get(eid)?.forEach(callback);
  }

  /**
   * @internal Register `callback`, invoked when any new table is created.
   * Returns a disposer that unregisters it.
   */
  public _observeTableCreated(callback: (t: Table) => void): () => void {
    this._onTableCreated.add(callback);
    return () => {
      this._onTableCreated.delete(callback);
    };
  }

  /** @internal Add a freshly created entity to its initial (empty) table. */
  public _placeNewEntity(e: Entity): void {
    e._table._addInitialEntity(e);
  }
}
