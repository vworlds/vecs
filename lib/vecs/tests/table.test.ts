import { describe, expect, it } from "vitest";
import { Bitset, World } from "../src/index.js";

class A {}
class B {}

describe("Table - archetype membership", () => {
  it("places new entities in the empty table", () => {
    const w = new World();
    const e = w.entity();
    expect(e._table).toBe(w._emptyTable);
    expect(w._emptyTable.entities.has(e)).toBe(true);
    expect(e._table.archetype.indices()).toEqual([]);
  });

  it("moves an entity to the matching archetype table when a component is added", () => {
    const w = new World();
    w.component(A);
    const aEid = w.entity(A).eid;
    const e = w.entity();

    e.add(A);

    expect(e._table).not.toBe(w._emptyTable);
    expect(e._table.archetype.has(aEid)).toBe(true);
    expect(e._table.entities.has(e)).toBe(true);
    expect(w._emptyTable.entities.has(e)).toBe(false);
  });

  it("returns an entity to its previous table when a component is removed", () => {
    const w = new World();
    w.component(A);
    const e = w.entity();

    e.add(A);
    const tableWithA = e._table;
    e.remove(A);

    expect(e._table).toBe(w._emptyTable);
    expect(tableWithA.entities.has(e)).toBe(false);
    expect(w._emptyTable.entities.has(e)).toBe(true);
  });

  it("shares a single table between entities with the same archetype", () => {
    const w = new World();
    w.component(A);
    const e1 = w.entity().add(A);
    const e2 = w.entity().add(A);

    expect(e1._table).toBe(e2._table);
    expect(e1._table.entities.has(e1)).toBe(true);
    expect(e1._table.entities.has(e2)).toBe(true);
  });

  it("treats archetypes as order-independent", () => {
    const w = new World();
    w.component(A);
    w.component(B);
    const e1 = w.entity().add(A).add(B);
    const e2 = w.entity().add(B).add(A);

    expect(e1._table).toBe(e2._table);
  });

  it("returns the same table instance for an equal archetype", () => {
    const w = new World();
    w.component(A);
    const aEid = w.entity(A).eid;
    const e = w.entity().add(A);

    const probe = new Bitset();
    probe.add(aEid);

    expect(w._findOrCreateTable(probe)).toBe(e._table);
  });

  it("indexes tables by component eid", () => {
    const w = new World();
    w.component(A);
    const aEid = w.entity(A).eid;
    const e = w.entity().add(A);

    const tables: unknown[] = [];
    w._forEachTableForComponent(aEid, (t) => tables.push(t));

    expect(tables).toContain(e._table);
    expect(tables).not.toContain(w._emptyTable);
  });

  it("removes a destroyed entity from its table", () => {
    const w = new World();
    w.component(A);
    const e = w.entity().add(A);
    const tableWithA = e._table;

    e.destroy();

    expect(tableWithA.entities.has(e)).toBe(false);
  });

  it("places deferred-created entities in the empty table on flush", () => {
    const w = new World();
    let e!: ReturnType<World["entity"]>;
    w.defer(() => {
      e = w.entity();
      // Not yet registered while the create command is queued.
      expect(w._emptyTable.entities.has(e)).toBe(false);
    });
    expect(e._table).toBe(w._emptyTable);
    expect(w._emptyTable.entities.has(e)).toBe(true);
  });
});
