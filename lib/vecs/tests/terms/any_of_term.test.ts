import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  OnDelete,
  Remove,
  Relationship,
  TermEventKind,
  World,
  type Entity,
  type QueryDSL,
  type Term,
} from "../../src/index.js";
import { getDSLCacheKey, simplifyQueryDSL, type ExtractRequired } from "../../src/dsl.js";
import { AnyOfTerm } from "../../src/terms/any_of_term.js";

class Trait {}
class First {
  value = 0;
}
class Second {}
class Ship {}
class Other {}
class Link extends Relationship {}

function setup() {
  const w = new World();
  for (const c of [Trait, First, Second, Ship, Other, Link]) {
    w.component(c);
  }
  return w;
}

function record(term: Term) {
  const events: [TermEventKind, Entity][] = [];
  const unsubscribe = term.subscribe({ onTermEvent: (kind, e) => events.push([kind, e]) });
  return { events, unsubscribe };
}

describe.each([false, true])("anyOf (deferred=%s)", (deferred) => {
  function mutate(w: World, fn: () => void) {
    if (deferred) {
      w.defer(fn);
    } else {
      fn();
    }
  }

  it("enters once on the first key and exits on the last, ignoring unmarked components", () => {
    const w = setup();
    w.component(First).add(Trait);
    w.component(Second).add(Trait);
    const term = w.getTerm({ anyOf: [Trait] });
    const { events } = record(term);
    const e = w.entity();
    mutate(w, () => e.add(Other));
    expect(term.has(e)).toBe(false);
    mutate(w, () => e.add(First).add(Second));
    expect(events).toEqual([[TermEventKind.Enter, e]]);
    mutate(w, () => e.remove(First));
    expect(term.has(e)).toBe(true);
    mutate(w, () => e.remove(Second));
    expect(events).toEqual([
      [TermEventKind.Enter, e],
      [TermEventKind.Exit, e],
    ]);
  });

  it("backfills late marks before/after the first frame, unmarks, and re-subscribes", () => {
    const w = setup();
    const entered = vi.fn();
    const exited = vi.fn();
    const system = w
      .system("late")
      .with({ anyOf: [Trait] })
      .enter(entered)
      .exit(exited);
    const e = w.entity().add(First).add(Second);
    mutate(w, () => w.component(First).add(Trait));
    w.progress(0, 0);
    expect(system.rootTerm!.has(e)).toBe(true);
    expect(entered).toHaveBeenCalledTimes(1);
    mutate(w, () => w.component(Second).add(Trait));
    mutate(w, () => w.component(First).remove(Trait));
    w.progress(1, 1);
    expect(exited).not.toHaveBeenCalled();
    mutate(w, () => w.component(Second).remove(Trait));
    w.progress(2, 1);
    expect(exited).toHaveBeenCalledTimes(1);
    mutate(w, () => w.component(First).add(Trait));
    w.progress(3, 1);
    expect(entered).toHaveBeenCalledTimes(2);
  });

  it("matches a component registered and marked only after the system's first frame", () => {
    const w = setup();
    class Late {}
    const entered = vi.fn();
    w.system("late-registration").with({ anyOf: Trait }).enter(entered);
    w.progress(0, 0);
    const definition = w.component(Late);
    const e = w.entity().add(Late);
    mutate(w, () => definition.add(Trait));
    w.progress(1, 1);
    expect(entered).toHaveBeenCalledExactlyOnceWith(e);
  });

  it("supports arbitrary entity keys and destroyed keys", () => {
    const w = setup();
    const key = w.entity().add(Trait).add(OnDelete, Remove);
    const e = w.entity().add(key);
    const term = w.getTerm({ anyOf: Trait });
    const { events } = record(term);
    expect(term.has(e)).toBe(true);
    mutate(w, () => key.destroy());
    expect(term.has(e)).toBe(false);
    expect(events).toEqual([[TermEventKind.Exit, e]]);
  });

  it("selects keys by relationships and counts held relationship keys", () => {
    const w = setup();
    const registry = w.entity().add(Trait);
    w.component(First).add(Link, registry);
    w.component(Link).add(Trait);
    const e = w.entity().add(First);
    const term = w.getTerm({ anyOf: { target: [Link, Trait] } });
    record(term);
    expect(term.has(e)).toBe(true);
    mutate(w, () => registry.remove(Trait));
    expect(term.has(e)).toBe(false);
    const relationships = w.getTerm({ anyOf: Trait });
    record(relationships);
    mutate(w, () => e.add(Link, registry));
    expect(relationships.has(e)).toBe(true);
    mutate(w, () => e.remove(Link, registry));
    expect(relationships.has(e)).toBe(false);
  });

  it("selects keys with a watched predicate", () => {
    const w = setup();
    const key = w.component(Second).set(First, { value: 0 });
    const term = w.getTerm({
      anyOf: { test: (e) => (e.get(First)?.value ?? 0) > 0, watch: First },
    });
    record(term);
    const e = w.entity().add(Second);
    expect(term.has(e)).toBe(false);
    mutate(w, () => key.set(First, { value: 1 }));
    expect(term.has(e)).toBe(true);
    mutate(w, () => key.set(First, { value: 0 }));
    expect(term.has(e)).toBe(false);
  });

  it("composes with not, target, without and QueryConfig", () => {
    const w = setup();
    w.component(First).add(Trait);
    const target = w.entity().add(First);
    const e = w.entity().add(Ship).add(Link, target);
    const q = w
      .query("target")
      .with({ with: { all: [Ship, { target: [Link, { anyOf: Trait }] }] } })
      .build();
    const excluded = w.query("excluded").with(Ship).without({ anyOf: Trait }).build();
    const not = w.getTerm({ not: { anyOf: Trait } });
    record(not);
    expect(q.has(e)).toBe(true);
    expect(excluded.has(e)).toBe(true);
    mutate(w, () => e.add(First));
    expect(excluded.has(e)).toBe(false);
    expect(not.has(e)).toBe(false);
    mutate(w, () => target.remove(First));
    expect(q.has(e)).toBe(false);
  });

  it("keeps explicit update watches and releases all subscriptions", () => {
    const w = setup();
    w.component(First).add(Trait);
    const source = w.getTerm({ all: [Trait, { not: Other }] });
    const sourceDestroy = vi.spyOn(source, "destroy");
    const term = w.getTerm({ anyOf: { all: [Trait, { not: Other }] } });
    const { unsubscribe } = record(term);
    const updates = vi.fn();
    const q = w.query("updates").with({ anyOf: Trait }).update({ watch: First }, updates).build();
    const e = w.entity().add(First);
    mutate(w, () => e.set(First, { value: 2 }));
    expect(updates).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(sourceDestroy).toHaveBeenCalledTimes(1);
    expect(term.count).toBe(0);
    const sync = vi.spyOn(term as AnyOfTerm, "_matchesLive");
    mutate(w, () => e.remove(First));
    mutate(w, () => w.component(Second).add(Trait));
    expect(sync).not.toHaveBeenCalled();
    expect(w.getTerm({ anyOf: { all: [Trait, { not: Other }] } })).not.toBe(term);
    q.destroy();
  });

  for (const lateMark of [false, true]) {
    it(`is glitch-free in all/not, any and all/Ship (lateMark=${lateMark})`, () => {
      const w = setup();
      if (!lateMark) {
        w.component(First).add(Trait);
      }
      const dynamic = { anyOf: Trait } as const;
      const expressions: QueryDSL[] = [
        { all: [dynamic, { not: First }] },
        { any: [First, dynamic] },
        { all: [[Ship], dynamic] },
      ];
      const records = expressions.map((dsl) => record(w.getTerm(dsl)));
      if (lateMark) {
        // Append the dynamic key consumer AFTER the merged terms' static leaf consumers.
        mutate(w, () => w.component(First).add(Trait));
      }
      const e = w.entity().add(Ship);
      const change = (fn: () => void, expected: number[][]) => {
        records.forEach((r) => (r.events.length = 0));
        mutate(w, fn);
        expect(records.map((r) => r.events.map(([kind]) => kind))).toEqual(expected);
      };
      change(() => e.add(First), [[], [TermEventKind.Enter], [TermEventKind.Enter]]);
      change(() => e.remove(First), [[], [TermEventKind.Exit], [TermEventKind.Exit]]);
      change(() => e.add(First), [[], [TermEventKind.Enter], [TermEventKind.Enter]]);
      // Keep a holder while moving the key subscription to the end of the leaf's consumers.
      change(() => w.component(First).remove(Trait), [[], [], [TermEventKind.Exit]]);
      change(() => w.component(First).add(Trait), [[], [], [TermEventKind.Enter]]);
      change(() => e.remove(First), [[], [TermEventKind.Exit], [TermEventKind.Exit]]);
    });
  }

  it("agrees on emitted has/count/iteration inside hooks and another enter callback", () => {
    const w = setup();
    w.component(First).add(Trait);
    // Register another consumer first so it observes the leaf before anyOf's event.
    const observations: boolean[] = [];
    const other = w
      .query("other")
      .with(First)
      .enter((e) => check(e))
      .build();
    const q = w.query("dynamic").with({ anyOf: Trait }).build();
    const term = q.rootTerm!;
    function check(e: Entity) {
      expect(q.has(e)).toBe(term.has(e));
      expect([...term].includes(e)).toBe(term.has(e));
      expect(term.count).toBe([...term].length);
      observations.push(term.has(e));
    }
    w.component(First).on("add", (e) => check(e));
    const e = w.entity();
    mutate(w, () => e.add(First));
    expect(observations).toEqual([false, false]);
    expect(q.has(e)).toBe(true);
    other.destroy();
  });

  it("does not refresh collapsed membership leaves but still refreshes explicit test watches", () => {
    const w = setup();
    w.component(First).add(Trait);
    const term = w.getTerm({ all: [Ship, { anyOf: Trait }] });
    record(term);
    const dynamic = w.getTerm({ anyOf: Trait }) as AnyOfTerm;
    const live = vi.spyOn(dynamic, "_matchesLive");
    const e = w.entity().add(Ship).add(First);
    live.mockClear();
    mutate(w, () => e.modified(Ship));
    expect(live).not.toHaveBeenCalled();
    const test = vi.fn((entity: Entity) => (entity.get(First)?.value ?? 0) > 0);
    const watched = w.getTerm({ all: [Ship, { anyOf: Trait }, { test, watch: First }] });
    record(watched);
    test.mockClear();
    mutate(w, () => e.set(First, { value: 1 }));
    expect(test).toHaveBeenCalled();
    expect(watched.has(e)).toBe(true);
  });
});

it("canonicalizes nested clauses, rejects true and down terms, and adds no type guarantees", () => {
  const w = setup();
  expect(w.getTerm({ anyOf: [Trait] })).toBe(w.getTerm({ anyOf: { all: [Trait, true] } }));
  expect(getDSLCacheKey({ anyOf: Trait }, w)).toContain("ANYOF");
  expect(simplifyQueryDSL({ anyOf: false }, w)).toBe(false);
  for (const inner of [true, [], { any: [Trait, true] }] as QueryDSL[]) {
    expect(() => w.getTerm({ anyOf: inner })).toThrow(/selective/);
    expect(() => w.filter({ anyOf: inner })).toThrow(/selective/);
  }
  expect(() => w.getTerm({ anyOf: { source: [Link, Trait] } })).toThrow(/filter-only/);
  expect(() => w.getTerm({ source: [Link, { anyOf: Trait }] })).toThrow(/filter-only/);
  expectTypeOf<ExtractRequired<{ anyOf: typeof Trait }>>().toEqualTypeOf<[]>();
});

it("filters evaluate held keys directly, including an inner source, without creating terms", () => {
  const w = setup();
  const key = w.component(First);
  key.add(Trait);
  const marker = w.entity().add(Trait).add(Link, key);
  const e = w.entity().add(First);
  w.flush();
  const before = w._termCache.size;
  const seen: Entity[] = [];
  w.filter({ anyOf: Trait }).forEach((e) => seen.push(e));
  expect(seen).toEqual([e]);
  seen.length = 0;
  const filter = w.filter({ anyOf: { source: [Link, Trait] } });
  filter.forEach((e) => seen.push(e));
  expect(seen).toEqual([e]);
  marker.remove(Link, key);
  seen.length = 0;
  filter.forEach((e) => seen.push(e));
  expect(seen).toEqual([]);
  expect(w._termCache.size).toBe(before);
});

it("backfills a key selected during an add hook exactly once", () => {
  const w = setup();
  const term = w.getTerm({ anyOf: Trait });
  const { events } = record(term);
  w.component(First).on("add", () => w.component(First).add(Trait));
  const e = w.entity().add(First);
  expect(events).toEqual([[TermEventKind.Enter, e]]);
  expect(term.count).toBe(1);
});
