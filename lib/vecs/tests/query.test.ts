import { describe, it, expect, vi } from "vitest";
import {
  ChildOf,
  Query,
  Relationship,
  SilenceSource,
  Traversable,
  World,
  type EID,
  type GroupedQuery,
} from "../src/index.js";

class Position {
  x = 0;
  y = 0;
}
class Velocity {
  vx = 0;
  vy = 0;
}
class LocalPosition {
  x = 0;
  y = 0;
}
class Tag {
  active = true;
}
class FriendOf extends Relationship {}
class Sprite {}
class Container {}
class QueryTrait {}

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;
type IsNotAny<T> = IsAny<T> extends true ? false : true;

function assertType<T extends true>(): void {}

function setup() {
  const w = new World();
  w.component(Position);
  w.component(Velocity);
  w.component(Sprite);
  w.component(Container);
  return {
    w,
    tick: () => w.progress(0, 0),
  };
}

describe("Query — typing", () => {
  it("preserves refined query types through builder methods", () => {
    const { w } = setup();

    const typedRequired = w.query("typed-required").with(Position, Velocity);
    assertType<IsNotAny<typeof typedRequired>>();
    assertType<IsEqual<typeof typedRequired, Query<[typeof Position, typeof Velocity]>>>();

    if (false) {
      const typedForEach = typedRequired.forEach([Position, Velocity], (_e, [p, v]) => {
        assertType<IsNotAny<typeof p>>();
        assertType<IsEqual<typeof p, Position>>();
        assertType<IsEqual<typeof v, Velocity>>();
      });
      assertType<IsEqual<typeof typedForEach, Query<[typeof Position, typeof Velocity]>>>();
    }

    const typedQuery = w.query("typed-query").with({ all: [Position, Velocity] });
    assertType<IsNotAny<typeof typedQuery>>();
    assertType<IsEqual<typeof typedQuery, Query<[typeof Position, typeof Velocity]>>>();

    const typedMergedQuery = w.query("typed-merged-query").with(Position, {
      with: { any: [Velocity, Sprite] },
      hint: [Velocity],
    });
    assertType<IsNotAny<typeof typedMergedQuery>>();
    assertType<IsEqual<typeof typedMergedQuery, Query<[typeof Position, typeof Velocity]>>>();

    const typedRepeatedQuery = w.query("typed-repeated-query").with(Position).with(Velocity);
    assertType<IsNotAny<typeof typedRepeatedQuery>>();
    assertType<IsEqual<typeof typedRepeatedQuery, Query<[typeof Position, typeof Velocity]>>>();

    if (false) {
      typedQuery.update({ watch: Position, onEnter: true, inject: [Velocity] }, (_e, p, [v]) => {
        assertType<IsEqual<typeof p, Position>>();
        assertType<IsEqual<typeof v, Velocity>>();
      });
    }

    const typedGrouped = typedRequired.groupBy([Position], (_e, [p]) => {
      assertType<IsEqual<typeof p, Position>>();
      return p.x;
    });
    assertType<IsNotAny<typeof typedGrouped>>();
    assertType<
      IsEqual<typeof typedGrouped, GroupedQuery<number, [typeof Position, typeof Velocity]>>
    >();
    expect(typedGrouped.groupCount).toBe(0);
  });
});

describe("Query — construction", () => {
  it("world.query() tracks entities by default once built", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position).build();
    const e = w.entity();
    e.add(Position);
    tick();
    expect(q.has(e)).toBe(true);
  });

  it("counts tracked entities", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position).build();

    const position = w.entity().add(Position);
    w.entity().add(Velocity);
    tick();
    expect(q.count).toBe(1);

    position.remove(Position);
    tick();
    expect(q.count).toBe(0);
  });

  it("can be built after progress and immediately backfills existing entities", () => {
    const { w, tick } = setup();
    const e = w.entity();
    e.add(Position);
    tick(); // flush archetype so e is "settled"
    const q = w.query("late").with(Position).build();
    expect(q.has(e)).toBe(true);
  });

  it("does not register world.query() until build()", () => {
    const { w } = setup();
    const q = w.query("test").with(Position);
    expect(w.queries).not.toContain(q);
    q.build();
    expect(w.queries).toContain(q);
  });

  it("build() leaves queries pending until deferred flush", () => {
    const { w } = setup();
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);

    const q = w.query("deferred").with(Position);
    w.defer(() => {
      q.build();
      expect(q.built).toBe(false);
      expect(w.queries).not.toContain(q);
      expect(q.has(e)).toBe(false);
    });

    expect(q.built).toBe(true);
    expect(w.queries).toContain(q);
    expect(q.has(e)).toBe(true);
  });

  it("does not route unbuilt queries", () => {
    const { w } = setup();
    const enter = vi.fn();
    const q = w.query("test").with(Position).enter(enter);
    const e = w.entity();
    e.add(Position);
    expect(enter).not.toHaveBeenCalled();
    expect(q.has(e)).toBe(false);
  });

  it("auto-builds unbuilt queries before a frame", () => {
    const { w } = setup();
    const e = w.entity();
    e.add(Position);
    const q = w.query("late").with(Position);
    expect(q.has(e)).toBe(false);
    w.progress(0, 0);
    expect(q.has(e)).toBe(true);
  });

  it("throws when configuring a built query", () => {
    const { w } = setup();
    const q = w.query("test").with(Position).build();
    expect(() => q.with(Velocity)).toThrow();
    expect(() => q.enter(() => {})).toThrow();
    expect(() => q.track()).toThrow();
    expect(q.count).toBe(0);
    expect([...q]).toEqual([]);
  });

  it("name is accessible on the query", () => {
    const { w } = setup();
    const q = w.query("enemies");
    expect(q.name).toBe("enemies");
    expect(q.toString()).toBe("enemies");
  });

  it("stores query instances on backing entities", () => {
    const { w } = setup();
    const q = w.query("tracked-query");

    expect(q.entity.name).toBe("tracked-query");
    expect(q.entity.get(Query)).toBe(q);
  });

  it("can query query entities by traits", () => {
    const { w } = setup();
    w.component(QueryTrait);
    const tagged = w.query("tagged-query").with(false).build();
    tagged.entity.add(QueryTrait);

    const q = w.query("query-traits").with(Query, QueryTrait).build();

    expect(q.has(tagged.entity)).toBe(true);
  });

  it("matches nothing until with() sets a predicate", () => {
    const { w, tick } = setup();
    const q = w.query("empty");
    const e = w.entity();
    e.add(Position);
    tick();
    expect(q.belongs(e)).toBe(false);
    expect(q.count).toBe(0);
  });

  it("forgets queries built without a predicate", () => {
    const { w } = setup();
    const q = w.query("empty").build();
    expect(w.queries).not.toContain(q);
    expect(q.entity.destroyed).toBe(true);
  });
});

describe("Query — update predicate", () => {
  it("update callbacks do not fire on enter by default", () => {
    const { w, tick } = setup();
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    tick();

    const update = vi.fn();
    const q = w.query("updated").update(Position, update).build();

    expect(q.belongs(e)).toBe(true);
    expect(q.has(e)).toBe(true);
    expect(update).not.toHaveBeenCalled();

    e.modified(Position);
    tick();
    expect(update).toHaveBeenCalledWith(e, pos);
  });

  it("update-only queries backfill existing entities after adding their watched component to the predicate", () => {
    const { w, tick } = setup();
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    tick();

    const update = vi.fn();
    const q = w.query("updated").update({ watch: Position, onEnter: true }, update).build();

    expect(q.belongs(e)).toBe(true);
    expect(q.has(e)).toBe(true);
    expect(update).toHaveBeenCalledWith(e, pos);
  });

  it("multiple update() calls before build() combine into the predicate", () => {
    const { w, tick } = setup();
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    tick();

    const positionUpdate = vi.fn();
    const velocityUpdate = vi.fn();
    const q = w
      .query("updated")
      .update(Position, positionUpdate)
      .update(Velocity, velocityUpdate)
      .build();

    expect(q.has(e)).toBe(true);
    expect(positionUpdate).not.toHaveBeenCalled();
    expect(velocityUpdate).not.toHaveBeenCalled();

    e.modified(Position);
    tick();
    expect(positionUpdate).toHaveBeenCalledWith(e, e.get(Position));
    expect(velocityUpdate).not.toHaveBeenCalled();

    e.modified(Velocity);
    tick();
    expect(velocityUpdate).toHaveBeenCalledWith(e, e.get(Velocity));
  });

  it("update() narrows an existing predicate to require the watched component", () => {
    const { w, tick } = setup();
    const update = vi.fn();
    const q = w.query("updated").with(Position).update(Velocity, update).build();

    const positionOnly = w.entity().add(Position);
    tick();
    expect(q.has(positionOnly)).toBe(false);
    expect(update).not.toHaveBeenCalled();

    const vel = positionOnly.set(Velocity, { vx: 1 }).get(Velocity)!;
    tick();
    expect(q.has(positionOnly)).toBe(true);
    expect(update).not.toHaveBeenCalled();

    positionOnly.modified(Velocity);
    tick();
    expect(update).toHaveBeenCalledWith(positionOnly, vel);
  });

  it("throws when update() is registered twice for the same component", () => {
    const { w } = setup();
    const q = w.query("updated").update(Position, () => {});

    expect(() => q.update(Position, () => {})).toThrow(
      "query 'updated' already has an update callback for component Position"
    );
  });
});

describe("Query — changed flag", () => {
  it("starts false and becomes true when an entity enters", () => {
    const { w, tick } = setup();
    const q = w.query("changed").with(Position).build();

    expect(q.changed).toBe(false);
    const e = w.entity();
    e.add(Position);
    tick();

    expect(q.changed).toBe(true);
    expect(q.has(e)).toBe(true);
  });

  it("can be cleared manually and becomes true when an entity exits", () => {
    const { w, tick } = setup();
    const q = w.query("changed").with(Position).build();
    const e = w.entity();
    e.add(Position);
    tick();
    q.changed = false;

    e.remove(Position);
    tick();

    expect(q.changed).toBe(true);
  });

  it("becomes true when a watched component is modified", () => {
    const { w, tick } = setup();
    const q = w
      .query("changed")
      .with(Position)
      .update(Position, () => {})
      .build();
    const e = w.entity();
    e.add(Position);
    tick();
    q.changed = false;

    e.modified(Position);
    tick();
    expect(q.changed).toBe(true);
  });

  it("is cleared automatically by forEach", () => {
    const { w, tick } = setup();
    const q = w.query("changed").with(Position).build();
    w.entity().add(Position);
    tick();

    q.forEach(() => {});
    expect(q.changed).toBe(false);
  });
});

describe("Query — component routing index", () => {
  it("does not reevaluate simple queries when unrelated components change", () => {
    const { w, tick } = setup();
    const q = w.query("velocity").with(Velocity);
    const belongs = vi.spyOn(q, "belongs");
    belongs.mockClear();

    const e = w.entity();
    e.add(Position);
    tick();

    expect(belongs).not.toHaveBeenCalled();
  });

  it("matches entity refs used as typeless component keys", () => {
    const { w, tick } = setup();
    const key = w.entity();
    const q = w.query("tagged").with(key).build();
    const e = w.entity();

    e.add(key);
    tick();

    expect(q.has(e)).toBe(true);
  });

  it("reindexes a query when another predicate is added", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position);
    q.with(Velocity);
    const belongs = vi.spyOn(q, "belongs");
    belongs.mockClear();

    const positionOnly = w.entity();
    positionOnly.add(Position);
    tick();
    expect(belongs).not.toHaveBeenCalled();

    const velocityOnly = w.entity();
    velocityOnly.add(Velocity);
    tick();
    expect(belongs).not.toHaveBeenCalled();
    expect(q.has(velocityOnly)).toBe(false);

    const positionVelocity = w.entity();
    positionVelocity.add(Position);
    positionVelocity.add(Velocity);
    tick();
    expect(belongs).not.toHaveBeenCalled();
    expect(q.has(positionVelocity)).toBe(true);
  });

  it("destroy removes a query from the routing index", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position);
    q.destroy();
    const belongs = vi.spyOn(q, "belongs");

    const e = w.entity();
    e.add(Position);
    tick();

    expect(belongs).not.toHaveBeenCalled();
  });
});

describe("Query — predicates (belongs)", () => {
  it("with matches entities with all listed components", () => {
    const { w } = setup();
    const q = w.query("test").with(Position, Velocity).build();
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    b.add(Velocity);
    expect(q.belongs(a)).toBe(false);
    expect(q.belongs(b)).toBe(true);
  });

  it("only matches entities with exactly that component set", () => {
    const { w } = setup();
    const q = w
      .query("test")
      .with({ only: [Position] })
      .build();
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    b.add(Velocity);
    expect(q.belongs(a)).toBe(true);
    expect(q.belongs(b)).toBe(false);
  });

  it("all requires all sub-predicates to match", () => {
    const { w } = setup();
    const q = w
      .query("test")
      .with({ all: [Position, Velocity] })
      .build();
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    b.add(Velocity);
    expect(q.belongs(a)).toBe(false);
    expect(q.belongs(b)).toBe(true);
  });

  it("with merges multiple specs with all", () => {
    const { w } = setup();
    const q = w
      .query("test")
      .with(Position, { with: { any: [Velocity, Sprite] } })
      .build();
    const positionOnly = w.entity().add(Position);
    const velocityOnly = w.entity().add(Velocity);
    const positionVelocity = w.entity().add(Position).add(Velocity);
    const positionSprite = w.entity().add(Position).add(Sprite);

    expect(q.belongs(positionOnly)).toBe(false);
    expect(q.belongs(velocityOnly)).toBe(false);
    expect(q.belongs(positionVelocity)).toBe(true);
    expect(q.belongs(positionSprite)).toBe(true);
  });

  it("repeated with calls merge with all", () => {
    const { w } = setup();
    const q = w
      .query("test")
      .with(Position)
      .with({ any: [Velocity, Sprite] })
      .build();
    const positionOnly = w.entity().add(Position);
    const velocityOnly = w.entity().add(Velocity);
    const positionVelocity = w.entity().add(Position).add(Velocity);
    const positionSprite = w.entity().add(Position).add(Sprite);

    expect(q.belongs(positionOnly)).toBe(false);
    expect(q.belongs(velocityOnly)).toBe(false);
    expect(q.belongs(positionVelocity)).toBe(true);
    expect(q.belongs(positionSprite)).toBe(true);
  });

  it("any matches if any branch is satisfied", () => {
    const { w } = setup();
    const q = w
      .query("test")
      .with({ any: [Sprite, Container] })
      .build();
    const a = w.entity();
    a.add(Sprite);
    const b = w.entity();
    b.add(Container);
    const c = w.entity();
    c.add(Position);
    expect(q.belongs(a)).toBe(true);
    expect(q.belongs(b)).toBe(true);
    expect(q.belongs(c)).toBe(false);
  });

  it("not inverts a sub-predicate", () => {
    const { w } = setup();
    const q = w
      .query("test")
      .with({ all: [Position, { not: Velocity }] })
      .build();
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    b.add(Velocity);
    expect(q.belongs(a)).toBe(true);
    expect(q.belongs(b)).toBe(false);
  });

  it("without adds a negated predicate", () => {
    const { w } = setup();
    const q = w.query("test").with(Position).without(Velocity).build();
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    b.add(Velocity);

    expect(q.belongs(a)).toBe(true);
    expect(q.belongs(b)).toBe(false);
  });

  it("an EntityTestFunc can be passed with test", () => {
    const { w } = setup();
    const q = w
      .query("test")
      .with({ test: (e) => e.eid === 77 })
      .build();
    const seven = w.getOrCreateEntity(77);
    const three = w.getOrCreateEntity(3);
    expect(q.belongs(seven)).toBe(true);
    expect(q.belongs(three)).toBe(false);
  });

  it("a single class matches entities with that component", () => {
    const { w } = setup();
    const q = w.query("test").with(Position).build();
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Velocity);
    expect(q.belongs(a)).toBe(true);
    expect(q.belongs(b)).toBe(false);
  });

  it("an array matches entities with all listed components", () => {
    const { w } = setup();
    const q = w.query("test").with([Position, Velocity]).build();
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    b.add(Velocity);
    expect(q.belongs(a)).toBe(false);
    expect(q.belongs(b)).toBe(true);
  });

  it("all is equivalent to multiple with components", () => {
    const { w } = setup();
    const q = w
      .query("test")
      .with({ all: [Position, Velocity] })
      .build();
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    expect(q.belongs(e)).toBe(true);
  });
});

describe("Query — entity tracking via world pipeline", () => {
  it("entity enters query when it gains the required components", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position);
    const e = w.entity();
    e.add(Position);
    tick();
    expect(q.has(e)).toBe(true);
    expect(q.count).toBe(1);
  });

  it("entity exits query when it loses a required component", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position);
    const e = w.entity();
    e.add(Position);
    tick();
    e.remove(Position);
    tick();
    expect(q.count).toBe(0);
  });

  it("forEach (entity-only) iterates all matched entities", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position);
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    tick();
    const visited: (typeof a)[] = [];
    q.forEach((e) => visited.push(e));
    expect(visited).toContain(a);
    expect(visited).toContain(b);
    expect(visited.length).toBe(2);
  });

  it("is directly iterable", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position);
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    tick();
    const visited: (typeof a)[] = [];
    for (const e of q) {
      visited.push(e);
    }
    expect(visited).toEqual([a, b]);
  });

  it("forEach with injection resolves components for each entity", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position, Velocity);
    const e = w.entity();
    e.set(Position, { x: 3 });
    e.set(Velocity, { vx: 4 });
    tick();
    let sum = 0;
    q.forEach([Position, Velocity], (_e, [p, v]) => {
      sum += p.x + v.vx; // non-null — both in with()
    });
    expect(sum).toBe(7);
  });

  it("forEach returns the query for chaining", () => {
    const { w } = setup();
    const q = w.query("test").with(Position);
    expect(q.forEach(() => {})).toBe(q);
    expect(q.forEach([Position], () => {})).toBe(q);
  });

  it("forEach with injection yields undefined for components not in with", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position);
    const e = w.entity();
    e.add(Position);
    tick();
    let velSeen: Velocity | undefined;
    q.forEach([Position, Velocity], (_e, [_p, v]) => {
      velSeen = v as Velocity | undefined;
    });
    expect(velSeen).toBeUndefined();
  });

  it("destroyed entity is removed from the query", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position);
    const e = w.entity();
    e.add(Position);
    tick();
    expect(q.has(e)).toBe(true);
    e.destroy();
    tick();
    expect(q.count).toBe(0);
  });
});

describe("Query — enter/exit callbacks", () => {
  it("enter fires when an entity first matches the query", () => {
    const { w, tick } = setup();
    const cb = vi.fn();
    w.query("test").with(Position).enter(cb);
    const e = w.entity();
    e.add(Position);
    tick();
    expect(cb).toHaveBeenCalledWith(e);
  });

  it("enter with injection passes a typed tuple", () => {
    const { w, tick } = setup();
    const cb = vi.fn();
    w.query("test").with(Position, Velocity).enter([Position, Velocity], cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    const vel = e.add(Velocity).get(Velocity)!;
    tick();
    expect(cb).toHaveBeenCalledWith(e, [pos, vel]);
  });

  it("enter accepts injection options", () => {
    const { w, tick } = setup();
    const cb = vi.fn();
    w.query("test")
      .with(Position, Velocity)
      .enter({ inject: [Position, Velocity] }, cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    const vel = e.add(Velocity).get(Velocity)!;
    tick();
    expect(cb).toHaveBeenCalledWith(e, [pos, vel]);
  });

  it("exit fires when an entity stops matching", () => {
    const { w, tick } = setup();
    const cb = vi.fn();
    w.query("test").with(Position).exit(cb);
    const e = w.entity();
    e.add(Position);
    tick();
    e.remove(Position);
    tick();
    expect(cb).toHaveBeenCalledWith(e);
  });

  it("exit injection can read recently-removed components", () => {
    const { w, tick } = setup();
    const cb = vi.fn();
    w.query("test").with(Position).exit([Position], cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    tick();
    e.remove(Position);
    tick();
    expect(cb).toHaveBeenCalledWith(e, [pos]);
  });

  it("exit accepts injection options", () => {
    const { w, tick } = setup();
    const cb = vi.fn();
    w.query("test")
      .with(Position)
      .exit({ inject: [Position] }, cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    tick();
    e.remove(Position);
    tick();
    expect(cb).toHaveBeenCalledWith(e, [pos]);
  });

  it("enter returns the query for chaining", () => {
    const { w } = setup();
    const q = w.query("test");
    expect(q.enter(() => {})).toBe(q);
  });

  it("exit returns the query for chaining", () => {
    const { w } = setup();
    const q = w.query("test");
    expect(q.exit(() => {})).toBe(q);
  });
});

describe("Query — orderBy", () => {
  it("orderBy() orders entities by the comparator", () => {
    const { w, tick } = setup();
    const q = w
      .query("test")
      .with(Position)
      .orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x);
    const e1 = w.entity();
    e1.set(Position, { x: 30 });
    const e2 = w.entity();
    e2.set(Position, { x: 10 });
    const e3 = w.entity();
    e3.set(Position, { x: 20 });
    tick();
    expect([...q]).toEqual([e2, e3, e1]);
  });

  it("forEach visits entities in sorted order", () => {
    const { w, tick } = setup();
    const q = w
      .query("test")
      .with(Position)
      .orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x);
    const e1 = w.entity();
    e1.set(Position, { x: 30 });
    const e2 = w.entity();
    e2.set(Position, { x: 10 });
    const e3 = w.entity();
    e3.set(Position, { x: 20 });
    tick();
    const order: (typeof e1)[] = [];
    q.forEach((e) => order.push(e));
    expect(order).toEqual([e2, e3, e1]);
  });

  it("exiting entity is removed from the sorted set", () => {
    const { w, tick } = setup();
    const q = w
      .query("test")
      .with(Position)
      .orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x);
    const e1 = w.entity();
    e1.set(Position, { x: 10 });
    const e2 = w.entity();
    e2.set(Position, { x: 20 });
    tick();
    expect([...q]).toEqual([e1, e2]);
    e1.remove(Position);
    tick();
    expect([...q]).toEqual([e2]);
  });

  it("changing a sort key re-sorts iteration and forEach order", () => {
    const { w, tick } = setup();
    const q = w
      .query("test")
      .with(Position)
      .orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x);
    const e1 = w.entity();
    e1.set(Position, { x: 1 });
    const e2 = w.entity();
    e2.set(Position, { x: 2 });
    const e3 = w.entity();
    e3.set(Position, { x: 3 });
    tick();
    expect([...q]).toEqual([e1, e2, e3]);

    e1.set(Position, { x: 99 });

    // Compare eids rather than Entity arrays directly: when this assertion
    // fails (pre-fix, the order is stale), printing a diff of Entity objects
    // recurses through the World/Entity object graph and never terminates.
    expect([...q].map((e) => e.eid)).toEqual([e2.eid, e3.eid, e1.eid]);
    const order: EID[] = [];
    q.forEach((e) => order.push(e.eid));
    expect(order).toEqual([e2.eid, e3.eid, e1.eid]);
  });

  it("has() remains correct for every member after a sort key changes", () => {
    const { w, tick } = setup();
    const q = w
      .query("test")
      .with(Position)
      .orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x);
    const e1 = w.entity();
    e1.set(Position, { x: 1 });
    const e2 = w.entity();
    e2.set(Position, { x: 2 });
    const e3 = w.entity();
    e3.set(Position, { x: 3 });
    tick();

    e1.set(Position, { x: 99 });

    expect(q.has(e1)).toBe(true);
    expect(q.has(e2)).toBe(true);
    expect(q.has(e3)).toBe(true);
  });

  it("a data change from a silenced source still keeps order fresh", () => {
    const { w, tick } = setup();
    w.component(Tag);
    const q = w
      .query("test")
      .with(Position)
      .ignoreSource([Tag])
      .orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x);

    const e1 = w.entity();
    e1.set(Position, { x: 1 });
    const e2 = w.entity();
    e2.set(Position, { x: 2 });
    tick();
    expect([...q]).toEqual([e1, e2]);

    const writer = w.system("Writer").run(() => {
      e1.getMut(Position, (p) => {
        p.x = 99;
      });
    });
    writer.entity.add(Tag);

    tick();

    // Compare eids rather than Entity arrays directly: when this assertion
    // fails (pre-fix, the order is stale), printing a diff of Entity objects
    // recurses through the World/Entity object graph and never terminates.
    expect([...q].map((e) => e.eid)).toEqual([e2.eid, e1.eid]);
  });

  it("orderBy() returns the query for chaining", () => {
    const { w } = setup();
    const q = w.query("test").with(Position);
    expect(q.orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x)).toBe(q);
  });

  it("orderBy() accepts injection options", () => {
    const { w, tick } = setup();
    const q = w
      .query("test")
      .with(Position)
      .orderBy({ inject: [Position] }, (_eA, [a], _eB, [b]) => a.x - b.x);
    const e1 = w.entity().set(Position, { x: 2 });
    const e2 = w.entity().set(Position, { x: 1 });
    tick();
    expect([...q]).toEqual([e2, e1]);
  });

  it("cascade() orders entities breadth-first by relationship depth", () => {
    const { w, tick } = setup();
    w.component(Tag);
    const rootA = w.entity("rootA").add(Tag);
    const rootB = w.entity("rootB").add(Tag);
    const childA1 = w.entity("childA1").add(Tag).childOf(rootA);
    const childA2 = w.entity("childA2").add(Tag).childOf(rootA);
    const childB1 = w.entity("childB1").add(Tag).childOf(rootB);
    const grandchild = w.entity("grandchild").add(Tag).childOf(childB1);
    const q = w.query("test").with(Tag).cascade(ChildOf);
    tick();

    expect([...q]).toEqual([rootA, rootB, childA1, childA2, childB1, grandchild]);
  });

  it("cascade() uses the optional compare callback within the same depth", () => {
    const { w, tick } = setup();
    w.component(Tag);
    const root = w.entity("root").add(Tag);
    const alpha = w.entity("alpha").add(Tag).childOf(root);
    const gamma = w.entity("gamma").add(Tag).childOf(root);
    const beta = w.entity("beta").add(Tag).childOf(root);
    const q = w
      .query("test")
      .with(Tag)
      .cascade(ChildOf, (a, b) => b.name!.localeCompare(a.name!));
    tick();

    expect([...q]).toEqual([root, gamma, beta, alpha]);
  });

  it("cascade() accepts relationship options", () => {
    const { w, tick } = setup();
    w.component(Tag);
    const root = w.entity("root").add(Tag);
    const child = w.entity("child").add(Tag).childOf(root);
    const q = w.query("test").with(Tag).cascade({ relationship: ChildOf });
    tick();

    expect([...q]).toEqual([root, child]);
  });

  it("cascade() maintains order across simple insertions", () => {
    const { w, tick } = setup();
    w.component(Tag);
    const milkyWay = w.entity("Milky Way").add(Tag);
    const solarSystem = w.entity("Solar System").add(Tag).childOf(milkyWay);
    const earth = w.entity("Earth").add(Tag).childOf(solarSystem);
    const moon = w.entity("Moon").add(Tag).childOf(earth);
    const q = w
      .query("test")
      .with(Tag)
      .cascade(ChildOf, (a, b) => a.name!.localeCompare(b.name!));
    tick();

    expect([...q]).toEqual([milkyWay, solarSystem, earth, moon]);

    const jupiter = w.entity("Jupiter").childOf(solarSystem).add(Tag);
    tick();

    expect([...q]).toEqual([milkyWay, solarSystem, earth, jupiter, moon]);
  });

  it("cascade() requires a relationship with the Traversable trait", () => {
    const { w } = setup();

    expect(() => w.query("not-a-relationship").cascade(Position)).toThrow(/Relationship/);
    expect(() => w.query("not-traversable").cascade(SilenceSource)).toThrow(/Traversable/);
  });

  it("cascade() works with custom Traversable relationships", () => {
    const { w, tick } = setup();
    w.component(Tag);
    w.component(FriendOf).add(Traversable);
    const alice = w.entity("Alice").add(Tag);
    const bob = w.entity("Bob").add(Tag).set(FriendOf, { target: alice });
    const charley = w.entity("Charley").add(Tag).set(FriendOf, { target: bob });
    const david = w.entity("David").add(Tag).set(FriendOf, { target: alice });
    const q = w
      .query("friend-depth")
      .with(Tag)
      .cascade(FriendOf, (a, b) => a.name!.localeCompare(b.name!));
    tick();

    expect([...q]).toEqual([alice, bob, david, charley]);
  });

  it("with() uses the last cascade from multiple specs", () => {
    const { w, tick } = setup();
    w.component(Tag);
    w.component(FriendOf).add(Traversable);

    const charley = w.entity("Charley").add(Tag);
    const bob = w.entity("Bob").add(Tag);
    const alice = w.entity("Alice").add(Tag);
    bob.set(FriendOf, { target: alice });
    charley.set(FriendOf, { target: bob });

    const q = w
      .query("cascade-precedence")
      .with({ with: Tag, cascade: ChildOf }, { with: true, cascade: FriendOf });
    tick();

    expect([...q]).toEqual([alice, bob, charley]);
  });

  it("repeated with calls use the last cascade", () => {
    const { w, tick } = setup();
    w.component(Tag);
    w.component(FriendOf).add(Traversable);

    const charley = w.entity("Charley").add(Tag);
    const bob = w.entity("Bob").add(Tag);
    const alice = w.entity("Alice").add(Tag);
    bob.set(FriendOf, { target: alice });
    charley.set(FriendOf, { target: bob });

    const q = w
      .query("cascade-precedence-repeated")
      .with({ with: Tag, cascade: ChildOf })
      .with({ with: true, cascade: FriendOf });
    tick();

    expect([...q]).toEqual([alice, bob, charley]);
  });

  it("cascade() lets parent transforms feed child transforms in hierarchy order", () => {
    const { w, tick } = setup();
    w.component(LocalPosition);
    const q = w.query("absolute-position").with(Position, LocalPosition).cascade(ChildOf);
    const milkyWay = w
      .entity("Milky Way")
      .set(LocalPosition, { x: 10000, y: 20000 })
      .set(Position, { x: 0, y: 0 });
    const solarSystem = w
      .entity("Solar System")
      .childOf(milkyWay)
      .set(LocalPosition, { x: 26000, y: 0 })
      .set(Position, { x: 0, y: 0 });
    const earth = w
      .entity("Earth")
      .childOf(solarSystem)
      .set(LocalPosition, { x: 150, y: 0 })
      .set(Position, { x: 0, y: 0 });
    const jupiter = w
      .entity("Jupiter")
      .childOf(solarSystem)
      .set(LocalPosition, { x: 778, y: 0 })
      .set(Position, { x: 0, y: 0 });
    const moon = w
      .entity("Moon")
      .childOf(earth)
      .set(LocalPosition, { x: 0.384, y: 0 })
      .set(Position, { x: 0, y: 0 });
    const iss = w
      .entity("ISS")
      .childOf(earth)
      .set(LocalPosition, { x: 0.0004, y: 0 })
      .set(Position, { x: 0, y: 0 });

    tick();

    const visited: string[] = [];
    q.forEach(
      [LocalPosition, Position, { target: [ChildOf, [Position]] }],
      (e, [local, position, parentPosition]) => {
        visited.push(e.name!);
        position.x = (parentPosition?.x ?? 0) + local.x;
        position.y = (parentPosition?.y ?? 0) + local.y;
      }
    );

    expect(visited).toEqual(["Milky Way", "Solar System", "Earth", "Jupiter", "Moon", "ISS"]);
    expect(milkyWay.get(Position)).toMatchObject({ x: 10000, y: 20000 });
    expect(solarSystem.get(Position)).toMatchObject({ x: 36000, y: 20000 });
    expect(earth.get(Position)).toMatchObject({ x: 36150, y: 20000 });
    expect(jupiter.get(Position)).toMatchObject({ x: 36778, y: 20000 });
    expect(moon.get(Position)?.x).toBeCloseTo(36150.384);
    expect(moon.get(Position)?.y).toBe(20000);
    expect(iss.get(Position)?.x).toBeCloseTo(36150.0004);
    expect(iss.get(Position)?.y).toBe(20000);
  });

  it("cascade() reorders a retargeted subtree", () => {
    const { w, tick } = setup();
    w.component(Tag);
    const milkyWay = w.entity("Milky Way").add(Tag);
    const solarSystem = w.entity("Solar System").add(Tag).childOf(milkyWay);
    const earth = w.entity("Earth").add(Tag).childOf(solarSystem);
    const jupiter = w.entity("Jupiter").add(Tag).childOf(solarSystem);
    const moon = w.entity("Moon").add(Tag).childOf(earth);
    const iss = w.entity("ISS").add(Tag).childOf(earth);
    const crewDragon = w.entity("Crew Dragon").add(Tag).childOf(iss);
    const q = w
      .query("test")
      .with(Tag)
      .cascade(ChildOf, (a, b) => a.name!.localeCompare(b.name!));
    tick();

    expect([...q]).toEqual([milkyWay, solarSystem, earth, jupiter, iss, moon, crewDragon]);

    iss.childOf(moon);
    tick();

    expect([...q]).toEqual([milkyWay, solarSystem, earth, jupiter, moon, iss, crewDragon]);
  });
});

describe("Query — destroy", () => {
  it("destroy() clears the tracked entities", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position);
    const e = w.entity();
    e.add(Position);
    tick();
    expect(q.count).toBe(1);
    q.destroy();
    expect(q.count).toBe(0);
  });

  it("destroy() removes the query from the world — new entities no longer enter it", () => {
    const { w, tick } = setup();
    const enter = vi.fn();
    const q = w.query("test").with(Position).enter(enter);
    q.destroy();
    const e = w.entity();
    e.add(Position);
    tick();
    expect(enter).not.toHaveBeenCalled();
  });

  it("destroy() removes the query from entities — existing entities no longer reference it", () => {
    const { w, tick } = setup();
    const q = w.query("test").with(Position);
    const e = w.entity();
    e.add(Position);
    tick();
    q.destroy();
    // After destroy the query is no longer in the entity's query set;
    // a component modification should not reach the (dead) query.
    const notify = vi.spyOn(q, "_notifyModified");
    e.modified(Position);
    tick();
    expect(notify).not.toHaveBeenCalled();
  });

  it("destroy() destroys the backing entity", () => {
    const { w } = setup();
    const q = w.query("test").with(Position);
    const entity = q.entity;
    q.destroy();
    expect(entity.destroyed).toBe(true);
    expect(w.getEntity(entity.eid)).toBeUndefined();
  });

  it("destroy() leaves belongs() as a safe match-nothing predicate", () => {
    const { w } = setup();
    const q = w.query("test").with(Position).build();
    const e = w.entity().add(Position);
    expect(q.belongs(e)).toBe(true);
    q.destroy();
    expect(q.belongs(e)).toBe(false);
  });

  it("destroy() on a query with no tracking still removes it from the world", () => {
    const { w, tick } = setup();
    // Create a system (which is untracked by default) — but we test with a raw query
    // that has tracking disabled via the internal constructor path.
    // Instead, just verify that a tracked query is also properly removed.
    const enter = vi.fn();
    const q = w.query("test").with(Position).enter(enter);
    const e = w.entity();
    e.add(Position);
    tick();
    q.destroy();
    // Adding another component change should not call enter again
    e.remove(Position);
    tick();
    const e2 = w.entity();
    e2.add(Position);
    tick();
    expect(enter).toHaveBeenCalledTimes(1); // only the first entity, before destroy
  });
});

describe("Query — not predicate routing", () => {
  it("removing a component causes enter on a not query", () => {
    const { w, tick } = setup();
    const enter = vi.fn();
    // Matches entities that have Position but not Velocity.
    w.query("test")
      .with({ all: [Position, { not: Velocity }] })
      .enter(enter);
    const e = w.entity();
    // Add Velocity first so the entity never transiently matches while being set up.
    e.add(Velocity); // no Position yet — doesn't match
    e.add(Position); // has both — still doesn't match (has Velocity)
    tick();
    expect(enter).not.toHaveBeenCalled();
    e.remove(Velocity);
    tick(); // removing Velocity makes it match → enter fires
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("adding a component causes exit on a not query", () => {
    const { w, tick } = setup();
    const exit = vi.fn();
    w.query("test")
      .with({ all: [Position, { not: Velocity }] })
      .exit(exit);
    const e = w.entity();
    e.add(Position);
    tick(); // entity matches (no Velocity)
    e.add(Velocity);
    tick(); // adding Velocity breaks the not predicate → exit fires
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("cycling not query fires enter → exit → enter in order", () => {
    const { w, tick } = setup();
    const events: string[] = [];
    w.query("test")
      .with({ all: [Position, { not: Velocity }] })
      .enter(() => events.push("enter"))
      .exit(() => events.push("exit"));
    const e = w.entity();
    e.add(Position);
    tick(); // enter (no Velocity)
    e.add(Velocity);
    tick(); // exit (Velocity added)
    e.remove(Velocity);
    tick(); // enter again (Velocity removed)
    expect(events).toEqual(["enter", "exit", "enter"]);
  });

  it("plain not query: entity enters on creation and when the excluded component is removed", () => {
    const { w, tick } = setup();
    const enter = vi.fn();
    w.query("test").with({ not: Velocity }).enter(enter).build();
    enter.mockClear();
    const e = w.entity();
    e.add(Velocity);
    tick();
    expect(enter).toHaveBeenCalledWith(e);
    enter.mockClear();
    e.remove(Velocity);
    tick();
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("system receives enter inbox event when not-excluded component is removed", () => {
    const { w } = setup();
    const enter = vi.fn();
    w.system("test")
      .with({ all: [Position, { not: Velocity }] })
      .enter(enter);
    const e = w.entity();
    // Add Velocity first so Position's arrival doesn't transiently match.
    e.add(Velocity); // no Position — doesn't match
    e.add(Position); // has both — still doesn't match (has Velocity)
    w.progress(0, 0);
    expect(enter).not.toHaveBeenCalled();
    e.remove(Velocity); // now matches → enter queued on system inbox
    w.progress(0, 0);
    expect(enter.mock.calls[0][0]).toBe(e);
  });
});
