import { describe, it, expect } from "vitest";
import { Relationship, World } from "../src/index.js";

class Position {
  x = 0;
  y = 0;
}
class Team {
  id = 0;
}
class InZone extends Relationship {}

function setup() {
  const w = new World();
  w.component(Position);
  w.component(Team);
  w.component(InZone);
  return { w, tick: () => w.progress(0, 0) };
}

const cellOf = (pos: Position): number => Math.floor(pos.x / 100);

describe("Query.groupBy — value grouping", () => {
  it("partitions matched entities into buckets keyed by the key function", () => {
    const { w, tick } = setup();
    const byCell = w
      .query("byCell")
      .with(Position)
      .groupBy([Position], (_e, [pos]) => cellOf(pos));
    byCell.build();

    const a = w.entity().set(Position, { x: 10 });
    const b = w.entity().set(Position, { x: 40 });
    const c = w.entity().set(Position, { x: 250 });
    tick();

    expect(byCell.groupCount).toBe(2);
    expect(byCell.group(0)?.count).toBe(2);
    expect(byCell.group(2)?.count).toBe(1);
    expect(byCell.group(0)?.has(a)).toBe(true);
    expect(byCell.group(0)?.has(b)).toBe(true);
    expect(byCell.group(2)?.has(c)).toBe(true);
    expect([...byCell.groupKeys()].sort()).toEqual([0, 2]);
  });

  it("re-keys an entity in place when a watched component changes", () => {
    const { w, tick } = setup();
    const byCell = w
      .query("byCell")
      .with(Position)
      .groupBy([Position], (_e, [pos]) => cellOf(pos));
    byCell.build();

    const e = w.entity().set(Position, { x: 10 });
    tick();
    expect(byCell.group(0)?.has(e)).toBe(true);

    e.set(Position, { x: 320 });
    tick();
    expect(byCell.group(0)).toBeUndefined();
    expect(byCell.group(3)?.has(e)).toBe(true);
  });

  it("does not re-key a group when the modifying source is silenced", () => {
    class Marker {}
    const w = new World();
    w.component(Team);
    w.component(Marker);
    const byTeam = w
      .query("byTeam")
      .with(Team)
      .ignoreSource([Marker])
      .groupBy([Team], (_e, [team]) => team.id);
    byTeam.build();

    // Writer is inside the silenced domain and rewrites Team.id every tick.
    const writer = w
      .system("Writer")
      .with(Team)
      .each([Team], (e) => {
        e.getMut(Team, (t) => {
          t.id = 1;
        });
      });
    writer.entity.add(Marker);

    const e = w.entity().set(Team, { id: 0 });
    w.progress(0, 0); // enters group 0; writer's silenced write must not re-key
    w.progress(0, 0);

    expect(byTeam.group(0)?.has(e)).toBe(true);
    expect(byTeam.group(1)).toBeUndefined();

    // An external (unsourced) write still re-keys the entity.
    e.getMut(Team, (t) => {
      t.id = 2;
    });
    w.flush();
    expect(byTeam.group(0)).toBeUndefined();
    expect(byTeam.group(2)?.has(e)).toBe(true);
  });

  it("drops a bucket and removes a member when it leaves the query", () => {
    const { w, tick } = setup();
    const byCell = w
      .query("byCell")
      .with(Position)
      .groupBy([Position], (_e, [pos]) => cellOf(pos));
    byCell.build();

    const e = w.entity().set(Position, { x: 150 });
    tick();
    expect(byCell.group(1)?.has(e)).toBe(true);

    e.remove(Position);
    tick();
    expect(byCell.group(1)).toBeUndefined();
    expect(byCell.groupCount).toBe(0);
  });

  it("fires onGroupEnter when a bucket is created and onGroupExit when it empties", () => {
    const { w, tick } = setup();
    const entered: number[] = [];
    const exited: number[] = [];
    const byCell = w
      .query("byCell")
      .with(Position)
      .groupBy([Position], (_e, [pos]) => cellOf(pos))
      .onGroupEnter((group) => entered.push(group.key))
      .onGroupExit((key) => exited.push(key as number));
    byCell.build();

    const e = w.entity().set(Position, { x: 10 });
    tick();
    expect(entered).toEqual([0]);

    e.set(Position, { x: 210 });
    tick();
    expect(entered).toEqual([0, 2]);
    expect(exited).toEqual([0]);
  });

  it("groups by a derived component value and re-keys on that value", () => {
    const { w, tick } = setup();
    const byTeam = w
      .query("byTeam")
      .with(Team)
      .groupBy([Team], (_e, [team]) => team.id);
    byTeam.build();

    const e = w.entity().set(Team, { id: 7 });
    tick();
    expect(byTeam.group(7)?.has(e)).toBe(true);

    e.set(Team, { id: 9 });
    tick();
    expect(byTeam.group(7)).toBeUndefined();
    expect(byTeam.group(9)?.has(e)).toBe(true);
  });

  it("backfills existing entities when grouping is built after progress", () => {
    const { w, tick } = setup();
    const e = w.entity().set(Position, { x: 130 });
    tick();

    const byCell = w
      .query("late")
      .with(Position)
      .groupBy([Position], (_e, [pos]) => cellOf(pos));
    byCell.build();

    expect(byCell.group(1)?.has(e)).toBe(true);
  });

  it("exposes injected components through Group.forEach", () => {
    const { w, tick } = setup();
    const byCell = w
      .query("byCell")
      .with(Position)
      .groupBy([Position], (_e, [pos]) => cellOf(pos));
    byCell.build();

    w.entity().set(Position, { x: 120 });
    w.entity().set(Position, { x: 180 });
    tick();

    const seen: number[] = [];
    byCell.group(1)?.forEach([Position], (_e, [pos]) => seen.push(pos!.x));
    expect(seen.sort((p, q) => p - q)).toEqual([120, 180]);
  });

  it("Group.forEach accepts injection options", () => {
    const { w, tick } = setup();
    const byCell = w
      .query("byCell")
      .with(Position)
      .groupBy([Position], (_e, [pos]) => cellOf(pos));
    byCell.build();

    w.entity().set(Position, { x: 120 });
    tick();

    const seen: number[] = [];
    byCell.group(1)?.forEach({ inject: [Position] }, (_e, [pos]) => seen.push(pos!.x));
    expect(seen).toEqual([120]);
  });

  it("Group.forEach returns the group for chaining", () => {
    const { w, tick } = setup();
    const byCell = w
      .query("byCell")
      .with(Position)
      .groupBy([Position], (_e, [pos]) => cellOf(pos));
    byCell.build();

    w.entity().set(Position, { x: 120 });
    tick();

    const group = byCell.group(1)!;
    expect(group.forEach(() => {})).toBe(group);
    expect(group.forEach([Position], () => {})).toBe(group);
  });
});

describe("Query.groupBy — relationship grouping", () => {
  it("keys buckets by the relationship target entity", () => {
    const { w, tick } = setup();
    const zoneA = w.entity();
    const zoneB = w.entity();
    const byZone = w.query("byZone").groupBy(InZone);
    byZone.build();

    const a = w.entity().set(InZone, { target: zoneA });
    const b = w.entity().set(InZone, { target: zoneA });
    const c = w.entity().set(InZone, { target: zoneB });
    tick();

    expect(byZone.group(zoneA)?.count).toBe(2);
    expect(byZone.group(zoneB)?.count).toBe(1);
    expect(byZone.group(zoneA)?.has(a)).toBe(true);
    expect(byZone.group(zoneA)?.has(b)).toBe(true);
    expect(byZone.group(zoneB)?.has(c)).toBe(true);
  });

  it("accepts relationship options", () => {
    const { w, tick } = setup();
    const zone = w.entity();
    const byZone = w.query("byZone").groupBy({ relationship: InZone });
    byZone.build();

    const e = w.entity().set(InZone, { target: zone });
    tick();

    expect(byZone.group(zone)?.has(e)).toBe(true);
  });

  it("accepts injection options", () => {
    const { w, tick } = setup();
    const byCell = w
      .query("byCell")
      .with(Position)
      .groupBy({ inject: [Position] }, (_e, [pos]) => cellOf(pos));
    byCell.build();

    const e = w.entity().set(Position, { x: 120 });
    tick();

    expect(byCell.group(1)?.has(e)).toBe(true);
  });

  it("moves an entity to a new bucket when the relationship is retargeted", () => {
    const { w, tick } = setup();
    const zoneA = w.entity();
    const zoneB = w.entity();
    const byZone = w.query("byZone").groupBy(InZone);
    byZone.build();

    const e = w.entity().set(InZone, { target: zoneA });
    tick();
    expect(byZone.group(zoneA)?.has(e)).toBe(true);

    e.set(InZone, { target: zoneB });
    tick();
    expect(byZone.group(zoneA)).toBeUndefined();
    expect(byZone.group(zoneB)?.has(e)).toBe(true);
  });

  it("removes an entity from its bucket when the relationship is removed", () => {
    const { w, tick } = setup();
    const zoneA = w.entity();
    const byZone = w.query("byZone").groupBy(InZone);
    byZone.build();

    const e = w.entity().set(InZone, { target: zoneA });
    tick();
    expect(byZone.group(zoneA)?.has(e)).toBe(true);

    e.remove(InZone);
    tick();
    expect(byZone.group(zoneA)).toBeUndefined();
  });
});

describe("Query.groupBy — non-grouped queries", () => {
  it("groupBy returns a GroupedQuery with group accessors available", () => {
    const { w } = setup();
    const q = w
      .query("gq")
      .with(Position)
      .groupBy([Position], (_e, [pos]) => cellOf(pos));
    q.build();
    expect(typeof q.groupCount).toBe("number");
    expect(q.group(0)).toBeUndefined();
    expect([...q.groups()]).toEqual([]);
    expect([...q.groupKeys()]).toEqual([]);
  });

  it("throws when grouping twice", () => {
    const { w } = setup();
    const q = w.query("twice").with(Position);
    q.groupBy([Position], (_e, [pos]) => cellOf(pos));
    expect(() => q.groupBy([Position], (_e, [pos]) => cellOf(pos))).toThrow();
  });
});
