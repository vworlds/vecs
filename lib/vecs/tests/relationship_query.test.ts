import { describe, expect, it, vi } from "vitest";
import {
  ChildOf,
  CleanupPolicy,
  Entity,
  Exclusive,
  Iter,
  Relationship,
  World,
} from "../src/index.js";

class Body {}
class Position {
  x = 0;
}
class Velocity {
  vx = 0;
}
class Tag {}
class FriendOf extends Relationship {}
class Knows extends Relationship {}

function setup() {
  const w = new World();
  w.component(Body);
  w.component(Position);
  w.component(Velocity);
  w.component(Tag);
  w.component(FriendOf).add(Exclusive);
  w.component(Knows);
  w.component(ChildOf);
  return { w };
}

describe("Relationship queries", () => {
  it.each(["ordinary", "relationship"] as const)(
    "does not reinterpret a cached target after relationship eid reuse by a %s component",
    (replacementKind) => {
      class Ordinary {}
      class OtherRelationship extends Relationship {}
      const world = new World({
        idPools: [
          { name: "component", min: 1, max: 899, reuseWaitFrames: 0 },
          { name: "module", min: 900, max: 999 },
          { name: "entity", min: 1000 },
        ],
      });
      world.component(Position);
      const relationship = world.component(Knows, 700);
      relationship.meta.onDelete = CleanupPolicy.Remove;
      const target = world.entity().add(Position);
      const source = world.entity().add(Knows, target);
      const query = world
        .query("cached target")
        .with({ target: [Knows, Position] })
        .build();
      expect(query.has(source)).toBe(true);

      relationship.destroy();
      if (replacementKind === "ordinary") {
        world.component(Ordinary, 700);
        expect(() => source.add(Ordinary)).not.toThrow();
        expect(query.has(source)).toBe(false);
      } else {
        world.component(OtherRelationship, 700);
        expect(() => source.add(OtherRelationship, target)).not.toThrow();
        const replacementQuery = world
          .query("replacement target")
          .with({ target: [OtherRelationship, Position] })
          .build();
        expect(query.has(source)).toBe(true);
        expect(replacementQuery.has(source)).toBe(true);
      }

      expect(() => target.modified(Position)).not.toThrow();
    }
  );

  it("keeps persistent compiled filters and target injectors safe after ordinary eid reuse", () => {
    class Ordinary {}
    const world = new World({
      idPools: [
        { name: "component", min: 1, max: 899, reuseWaitFrames: 0 },
        { name: "module", min: 900, max: 999 },
        { name: "entity", min: 1000 },
      ],
    });
    world.component(Position);
    world.component(Body);
    const relationship = world.component(Knows, 700);
    const filter = world.filter({ target: [Knows, Position] });
    const injected: unknown[][] = [];
    world
      .query("persistent target injection")
      .with(Body)
      .enter([{ target: [Knows, Entity] }, { targets: [Knows, Entity] }], (_entity, values) =>
        injected.push(values)
      )
      .build();

    relationship.destroy();
    world.component(Ordinary, 700);
    const candidate = world.entity().add(Ordinary).add(Body);
    const filtered: Entity[] = [];

    expect(() => filter.forEach((entity) => filtered.push(entity))).not.toThrow();
    expect(candidate.target(700)).toBeUndefined();
    expect(candidate.targets(700)).toEqual([]);
    expect(candidate.hasTarget(700, candidate)).toBe(false);
    expect(filtered).not.toContain(candidate);
    expect(injected).toEqual([[undefined, []]]);
  });

  it("fans target exits to a stable snapshot when the first source removes its edge", () => {
    const { w } = setup();
    const target = w.entity().add(Position);
    const first = w.entity().add(Knows, target);
    const second = w.entity().add(Knows, target);
    const exits: Entity[] = [];
    const query = w
      .query("reentrant target exits")
      .with({ target: [Knows, Position] })
      .exit((source) => {
        exits.push(source);
        if (source === first) {
          first.remove(Knows, target);
        }
      })
      .build();
    expect(query.has(first)).toBe(true);
    expect(query.has(second)).toBe(true);

    target.remove(Position);

    expect(exits).toEqual([first, second]);
    expect(query.has(first)).toBe(false);
    expect(query.has(second)).toBe(false);
  });

  it("matches when any target satisfies nested target terms", () => {
    const { w } = setup();
    const leaf = w.entity().add(Tag);
    const matchingMiddle = w.entity().add(Knows, leaf);
    const otherMiddle = w.entity();
    const candidate = w.entity().add(Knows, otherMiddle).add(Knows, matchingMiddle);
    const q = w
      .query("nested-many")
      .with({ target: [Knows, { target: [Knows, Tag] }] })
      .build();

    expect(q.has(candidate)).toBe(true);
    candidate.remove(Knows, matchingMiddle);
    expect(q.has(candidate)).toBe(false);
    candidate.add(Knows, matchingMiddle);
    expect(q.has(candidate)).toBe(true);
    leaf.destroy();
    expect(q.has(candidate)).toBe(false);
  });

  it("keeps an existential match while another qualifying target remains", () => {
    const { w } = setup();
    const first = w.entity().add(Position);
    const second = w.entity().add(Position);
    const candidate = w.entity().add(Knows, first).add(Knows, second);
    const q = w
      .query("many")
      .with({ target: [Knows, Position] })
      .build();

    candidate.add(Knows, first);
    expect(candidate.targets(Knows)).toEqual([first, second]);
    expect(q.has(candidate)).toBe(true);
    candidate.remove(Knows, first);
    expect(q.has(candidate)).toBe(true);
    second.destroy();
    expect(q.has(candidate)).toBe(false);
  });

  it("belongs and filter match candidates whose relationship target matches the inner DSL", () => {
    const { w } = setup();
    const target = w.entity().add(Position);
    const candidate = w.entity().add(FriendOf, target);
    const miss = w.entity().add(FriendOf, w.entity());
    const q = w
      .query("friends")
      .with({ target: [FriendOf, Position] })
      .build();

    expect(q.belongs(candidate)).toBe(true);
    expect(q.belongs(miss)).toBe(false);

    const seen: unknown[] = [];
    w.filter({ target: [FriendOf, Position] }).forEach((e) => seen.push(e));
    expect(seen).toContain(candidate);
    expect(seen).not.toContain(miss);
  });

  it("live tracking reacts when the target gains and loses inner components", () => {
    const { w } = setup();
    const target = w.entity();
    const candidate = w.entity().add(FriendOf, target);
    const q = w
      .query("friends")
      .with({ target: [FriendOf, Position] })
      .build();

    expect(q.has(candidate)).toBe(false);
    target.add(Position);
    expect(q.has(candidate)).toBe(true);
    target.remove(Position);
    expect(q.has(candidate)).toBe(false);
  });

  it("live tracking reacts to relationship removal, retargeting, and target destruction", () => {
    const { w } = setup();
    const first = w.entity().add(Position);
    const second = w.entity();
    const candidate = w.entity().add(FriendOf, first);
    const q = w
      .query("friends")
      .with({ target: [FriendOf, Position] })
      .build();

    expect(q.has(candidate)).toBe(true);
    candidate.add(FriendOf, second);
    expect(q.has(candidate)).toBe(false);
    second.add(Position);
    expect(q.has(candidate)).toBe(true);
    candidate.remove(FriendOf);
    expect(q.has(candidate)).toBe(false);
    candidate.add(FriendOf, second);
    expect(q.has(candidate)).toBe(true);
    second.destroy();
    expect(q.has(candidate)).toBe(false);
  });

  it("nested target propagates changes through chained subqueries", () => {
    const { w } = setup();
    const grandparent = w.entity();
    const parent = w.entity().add(FriendOf, grandparent);
    const child = w.entity().add(FriendOf, parent);
    const q = w
      .query("nested")
      .with({ target: [FriendOf, { target: [FriendOf, Tag] }] })
      .build();

    expect(q.has(child)).toBe(false);
    grandparent.add(Tag);
    expect(q.has(child)).toBe(true);
    grandparent.remove(Tag);
    expect(q.has(child)).toBe(false);
  });

  it("combines target with candidate-side component routing", () => {
    const { w } = setup();
    const target = w.entity().add(Position);
    const candidate = w.entity().add(FriendOf, target);
    const q = w
      .query("body-friends")
      .with({ all: [Body, { target: [FriendOf, Position] }] })
      .build();

    expect(q.has(candidate)).toBe(false);
    candidate.add(Body);
    expect(q.has(candidate)).toBe(true);
    candidate.remove(Body);
    expect(q.has(candidate)).toBe(false);
  });

  it("filter source matches parents with at least one qualifying child on each scan", () => {
    const { w } = setup();
    const parent = w.entity();
    const otherParent = w.entity();
    const child = w.entity().add(FriendOf, parent).add(Position);
    const otherChild = w.entity().add(FriendOf, otherParent).add(Velocity);

    const collect = () => {
      const seen: unknown[] = [];
      w.filter({ source: [FriendOf, Position] }).forEach((e) => seen.push(e));
      return seen;
    };

    expect(collect()).toEqual([parent]);
    otherChild.add(Position);
    expect(collect()).toEqual([parent, otherParent]);
    child.remove(Position);
    expect(collect()).toEqual([otherParent]);
  });

  it("rejects source in tracked queries and systems", () => {
    expect(() => {
      const { w } = setup();
      w.query("down")
        .with({ source: [FriendOf, Position] })
        .build();
    }).toThrow("source/children is not supported in a tracked query; use world.filter(...)");

    expect(() => {
      const { w } = setup();
      w.query("nested-down")
        .with({ target: [FriendOf, { source: [FriendOf, Position] }] })
        .build();
    }).toThrow("source/children is not supported in a tracked query; use world.filter(...)");

    expect(() => {
      const { w } = setup();
      w.system("system-down")
        .with({ source: [FriendOf, Position] })
        .build();
    }).toThrow("source/children is not supported in a tracked query; use world.filter(...)");

    expect(() => {
      const { w } = setup();
      w.system("system-each-down")
        .with({ source: [FriendOf, Position] })
        .each([Body], () => {})
        .build();
    }).toThrow("source/children is not supported in a tracked query; use world.filter(...)");
  });

  it("flattens target injection in query and filter iteration", () => {
    const { w } = setup();
    const target = w.entity().set(Position, { x: 7 });
    const candidate = w.entity().add(Body).add(FriendOf, target);
    w.entity().add(Body);
    const body = candidate.get(Body)!;
    const pos = target.get(Position)!;
    const q = w.query("inject").with(Body).build();

    const queryTuples: unknown[][] = [];
    q.forEach(
      [
        Body,
        { target: [FriendOf, Entity] },
        { target: [FriendOf, Position] },
        { target: [FriendOf, [Entity, Position, Velocity]] },
      ],
      (_e, tuple) => {
        queryTuples.push([...tuple]);
      }
    );

    const filterTuples: unknown[][] = [];
    w.filter(Body).forEach(
      [
        Body,
        { target: [FriendOf, Entity] },
        { target: [FriendOf, Position] },
        { target: [FriendOf, [Entity, Position, Velocity]] },
      ],
      (_e, tuple) => {
        filterTuples.push([...tuple]);
      }
    );

    expect(queryTuples).toEqual([
      [body, target, pos, target, pos, undefined],
      [expect.any(Body), undefined, undefined, undefined, undefined, undefined],
    ]);
    expect(filterTuples).toEqual(queryTuples);
  });

  it("fans out down injection in query and filter iteration", () => {
    const { w } = setup();
    const parent = w.entity().add(Body);
    const lonely = w.entity().add(Body);
    const body = parent.get(Body)!;
    const childWithPosition = w.entity().add(FriendOf, parent).set(Position, { x: 7 });
    const childWithVelocity = w.entity().add(FriendOf, parent).add(Velocity);
    const pos = childWithPosition.get(Position)!;
    const vel = childWithVelocity.get(Velocity)!;
    const q = w.query("down-inject").with(Body).build();

    const queryEntities: unknown[] = [];
    const queryTuples: unknown[][] = [];
    q.forEach([Body, { down: [FriendOf, [Position, Velocity]] }], (e, tuple) => {
      queryEntities.push(e);
      queryTuples.push([...tuple]);
    });

    const filterTuples: unknown[][] = [];
    w.filter(Body).forEach([Body, { down: [FriendOf, [Position, Velocity]] }], (_e, tuple) => {
      filterTuples.push([...tuple]);
    });

    expect(queryEntities).toEqual([parent, parent]);
    expect(queryTuples).toEqual([
      [body, pos, undefined],
      [body, undefined, vel],
    ]);
    expect(filterTuples).toEqual(queryTuples);

    const afterRetarget: unknown[][] = [];
    childWithVelocity.add(FriendOf, lonely);
    q.forEach([Body, { down: [FriendOf, [Position, Velocity]] }], (e, tuple) => {
      afterRetarget.push([e, ...tuple]);
    });

    expect(afterRetarget).toEqual([
      [parent, body, pos, undefined],
      [lonely, lonely.get(Body), undefined, vel],
    ]);
  });

  it("sets Iter source to the parent for direct slots and child for down slots", () => {
    const { w } = setup();
    const parent = w.entity().add(Body);
    const child = w.entity().add(FriendOf, parent).add(Position);
    const q = w.query("down-iter").with(Body).build();
    const seen: unknown[][] = [];

    q.forEach(
      { cursor: Iter, inject: [Body, { down: [FriendOf, [Position, Velocity]] }] },
      (it, tuple) => {
        seen.push([it.entity, ...it.src, ...tuple]);
      }
    );

    expect(seen).toEqual([
      [parent, parent, child, child, parent.get(Body), child.get(Position), undefined],
    ]);
  });

  it("interleaves up and down injection slots with the correct sources", () => {
    const { w } = setup();
    const target = w.entity().add(Velocity);
    const parent = w.entity().add(Body).add(FriendOf, target);
    const child = w.entity().add(FriendOf, parent).add(Position);
    const q = w.query("up-down-iter").with(Body).build();
    const seen: unknown[][] = [];

    q.forEach(
      {
        cursor: Iter,
        inject: [
          Body,
          { target: [FriendOf, [Entity, Velocity]] },
          { down: [FriendOf, [Position]] },
        ],
      },
      (it, tuple) => {
        seen.push([it.entity, ...it.src, ...tuple]);
      }
    );

    expect(seen).toEqual([
      [
        parent,
        parent,
        target,
        target,
        child,
        parent.get(Body),
        target,
        target.get(Velocity),
        child.get(Position),
      ],
    ]);

    const bareSeen: unknown[][] = [];
    q.forEach(
      [{ target: [FriendOf, [Entity, Velocity]] }, { down: [FriendOf, [Position]] }],
      (_entity, tuple) => bareSeen.push([...tuple])
    );
    expect(bareSeen).toEqual([[target, target.get(Velocity), child.get(Position)]]);
  });

  it("fans out down injection for system each", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("system-down")
      .with(Body)
      .each([{ down: [FriendOf, [Position, Velocity]] }], cb);
    const parent = w.entity().add(Body);
    const child = w.entity().add(FriendOf, parent).add(Position);

    w.progress(0, 0);

    expect(cb).toHaveBeenCalledWith(parent, [child.get(Position), undefined]);
  });

  it("rejects multiple down injections for query and filter iteration", () => {
    const { w } = setup();
    const q = w.query("multi-down").with(Body).build();

    expect(() => {
      q.forEach([{ down: [FriendOf, [Position]] }, { down: [FriendOf, [Velocity]] }], () => {});
    }).toThrow("Only one down injection is supported per tuple");

    expect(() => {
      w.filter(true).forEach(
        [{ down: [ChildOf, [Position]] }, { down: [ChildOf, [Velocity]] }] as any,
        () => {}
      );
    }).toThrow("Only one down injection is supported per tuple");
  });

  it("flattens target injection for enter and exit callbacks", () => {
    const { w } = setup();
    const target = w.entity();
    const candidate = w.entity().add(FriendOf, target);
    const enter = vi.fn();
    const exit = vi.fn();
    w.query("events")
      .with({ target: [FriendOf, Position] })
      .enter([{ target: [FriendOf, [Entity, Position]] }], enter)
      .exit([{ target: [FriendOf, [Entity, Position]] }], exit)
      .build();

    const pos = target.add(Position).get(Position)!;
    expect(enter).toHaveBeenCalledWith(candidate, [target, pos]);
    target.remove(Position);
    expect(exit).toHaveBeenCalledWith(candidate, [target, undefined]);
  });

  it("injects the target entity through a system enter callback", () => {
    const { w } = setup();
    const enter = vi.fn();
    w.system("target-enter")
      .with(Body, { target: [FriendOf, Position] })
      .enter([{ target: [FriendOf, Entity] }], enter);
    const target = w.entity().add(Position);
    const candidate = w.entity().add(Body).add(FriendOf, target);

    w.progress(0, 0);

    expect(enter).toHaveBeenCalledWith(candidate, [target]);
  });

  it("flattens target injection for system each", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("system-up")
      .with({ target: [FriendOf, Position] })
      .each([{ target: [FriendOf, [Entity, Position, Velocity]] }], cb);
    const target = w.entity().set(Position, { x: 3 });
    const candidate = w.entity().add(FriendOf, target);
    const pos = target.get(Position)!;

    w.progress(0, 0);

    expect(cb).toHaveBeenCalledWith(candidate, [target, pos, undefined]);
  });

  it("target queries do not register hidden subqueries", () => {
    const { w } = setup();
    const plain = w.query("plain").with(Body).build();
    const publicQueries = w.queries;

    expect(w.queries).toBe(publicQueries);
    plain.destroy();

    const q = w
      .query("outer")
      .with({ target: [FriendOf, Position] })
      .build();

    expect(w.queries).toContain(q);
    expect(w.queries.some((query) => query !== q && query.name?.startsWith("outer"))).toBe(false);
    q.destroy();
    expect(w.queries).not.toContain(q);
  });

  it("source filter matches parents with a qualifying child", () => {
    const { w } = setup();
    const parent = w.entity();
    const child1 = w.entity().childOf(parent).add(Position);
    const child2 = w.entity().childOf(parent);

    const seen: unknown[] = [];
    w.filter({ source: [ChildOf, Position] }).forEach((e) => seen.push(e));
    expect(seen).toContain(parent);

    child1.remove(Position);
    const seen2: unknown[] = [];
    w.filter({ source: [ChildOf, Position] }).forEach((e) => seen2.push(e));
    expect(seen2).not.toContain(parent);

    child2.add(Position);
    const seen3: unknown[] = [];
    w.filter({ source: [ChildOf, Position] }).forEach((e) => seen3.push(e));
    expect(seen3).toContain(parent);
  });

  it("source rejected in a tracked query", () => {
    const { w } = setup();
    expect(() => {
      w.query("bad")
        .with({ source: [ChildOf, Position] })
        .build();
    }).toThrow("source/children is not supported in a tracked query");
  });

  it("source rejected in a tracked system query", () => {
    const { w } = setup();
    expect(() => {
      w.system("bad-sys")
        .with({ source: [ChildOf, Position] })
        .track()
        .build();
    }).toThrow("source/children is not supported in a tracked query");
  });

  it("source nested inside target in a tracked query throws", () => {
    const { w } = setup();
    expect(() => {
      w.query("nested-down")
        .with({ target: [FriendOf, { source: [ChildOf, Position] }] })
        .build();
    }).toThrow("source/children is not supported in a tracked query");
  });

  it("down injection fires once per child with each/forEach/Filter.forEach", () => {
    const { w } = setup();
    const parent = w.entity().add(Body);
    const child1 = w.entity().childOf(parent).set(Position, { x: 1 });
    const child2 = w.entity().childOf(parent).set(Position, { x: 2 });
    const body = parent.get(Body);

    const q = w.query("inject").with(Body).build();
    const queryResults: [number | undefined][] = [];
    q.forEach([Body, { down: [ChildOf, [Position]] }] as any, (_e: any, tuple: any) => {
      queryResults.push([tuple[1]?.x]);
    });
    expect(queryResults).toEqual([[1], [2]]);

    const filterResults: [number | undefined][] = [];
    w.filter(Body).forEach(
      [Body, { down: [ChildOf, [Position]] }] as any,
      (_e: any, tuple: any) => {
        filterResults.push([tuple[1]?.x]);
      }
    );
    expect(filterResults).toEqual([[1], [2]]);
  });

  it("down injection with zero children produces zero callbacks", () => {
    const { w } = setup();
    const parent = w.entity().add(Body);
    const cb = vi.fn();
    w.filter(Body).forEach([Body, { down: [ChildOf, [Position]] }] as any, cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("down injection in system each fires per child", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("sys-down")
      .with(Body)
      .each([Body, { down: [ChildOf, [Position]] }] as any, cb);
    const parent = w.entity().add(Body);
    const child = w.entity().childOf(parent).set(Position, { x: 3 });
    const pos = child.get(Position);

    w.progress(0, 0);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(parent, [expect.anything(), pos]);
  });

  it("down injection with Iter sets entity to parent and src to child", () => {
    const { w } = setup();
    const parent = w.entity().add(Body);
    const child = w.entity().childOf(parent).set(Position, { x: 5 });
    const results: { entity: any; src: any }[] = [];
    w.filter(Body).forEach(
      { cursor: Iter, inject: [Body, { down: [ChildOf, [Position]] }] as any },
      (it: any, _tuple: any) => {
        results.push({ entity: it.entity, src: [...it.src] });
      }
    );
    expect(results).toHaveLength(1);
    expect(results[0].entity).toBe(parent);
    expect(results[0].src[1]).toBe(child);
  });

  it("down reflects added/removed children across iterations", () => {
    const { w } = setup();
    const parent = w.entity().add(Body);
    let count = 0;
    w.filter(Body).forEach([Body, { down: [ChildOf, [Position]] }] as any, () => {
      count++;
    });
    expect(count).toBe(0);

    const child = w.entity().childOf(parent).set(Position, { x: 7 });
    count = 0;
    w.filter(Body).forEach([Body, { down: [ChildOf, [Position]] }] as any, () => {
      count++;
    });
    expect(count).toBe(1);

    child.remove(ChildOf);
    count = 0;
    w.filter(Body).forEach([Body, { down: [ChildOf, [Position]] }] as any, () => {
      count++;
    });
    expect(count).toBe(0);
  });

  it("down injection slots correctly when down is not last (middle)", () => {
    const { w } = setup();
    const parent = w.entity().add(Body).set(Velocity, { vx: 10 });
    const child = w.entity().childOf(parent).set(Position, { x: 7 });
    const body = parent.get(Body);
    const vel = parent.get(Velocity);
    const pos = child.get(Position);

    const results: unknown[][] = [];
    w.filter(Body).forEach(
      [{ down: [ChildOf, [Position]] }, Velocity] as any,
      (_e: any, tuple: any) => {
        results.push([...tuple]);
      }
    );
    expect(results).toEqual([[pos, vel]]);
  });

  it("down injection slots correctly when down is first", () => {
    const { w } = setup();
    const parent = w.entity().add(Body).set(Velocity, { vx: 10 });
    const child = w.entity().childOf(parent).set(Position, { x: 7 });
    const body = parent.get(Body);
    const vel = parent.get(Velocity);
    const pos = child.get(Position);

    const results: unknown[][] = [];
    w.filter(Body).forEach(
      [{ down: [ChildOf, [Position]] }, Body, Velocity] as any,
      (_e: any, tuple: any) => {
        results.push([...tuple]);
      }
    );
    expect(results).toEqual([[pos, body, vel]]);
  });

  it("down injection not-last with Iter sets src correctly", () => {
    const { w } = setup();
    const parent = w.entity().add(Body).set(Velocity, { vx: 10 });
    const child = w.entity().childOf(parent).set(Position, { x: 7 });
    const results: { src: any[] }[] = [];
    w.filter(Body).forEach(
      { cursor: Iter, inject: [{ down: [ChildOf, [Position]] }, Velocity] as any },
      (it: any, _tuple: any) => {
        results.push({ src: [...it.src] });
      }
    );
    expect(results).toHaveLength(1);
    expect(results[0].src[0]).toBe(child);
    expect(results[0].src[1]).toBe(parent);
  });
});
