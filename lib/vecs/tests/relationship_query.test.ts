import { describe, expect, it, vi } from "vitest";
import { ChildOf, Iter, Relationship, World } from "../src/index.js";

class Body {}
class Position {
  x = 0;
}
class Velocity {
  vx = 0;
}
class Tag {}
class FriendOf extends Relationship {}

function setup() {
  const w = new World();
  w.component(Body);
  w.component(Position);
  w.component(Velocity);
  w.component(Tag);
  w.component(FriendOf);
  w.component(ChildOf);
  return { w, phase: w.addPhase("p") };
}

describe("Relationship queries", () => {
  it("belongs and filter match candidates whose relationship target matches the inner DSL", () => {
    const { w } = setup();
    const target = w.entity().add(Position);
    const candidate = w.entity().set(FriendOf, { target });
    const miss = w.entity().set(FriendOf, { target: w.entity() });
    const q = w
      .query("friends")
      .where({ target: [FriendOf, Position] })
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
    const candidate = w.entity().set(FriendOf, { target });
    const q = w
      .query("friends")
      .where({ target: [FriendOf, Position] })
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
    const candidate = w.entity().set(FriendOf, { target: first });
    const q = w
      .query("friends")
      .where({ target: [FriendOf, Position] })
      .build();

    expect(q.has(candidate)).toBe(true);
    candidate.set(FriendOf, { target: second });
    expect(q.has(candidate)).toBe(false);
    second.add(Position);
    expect(q.has(candidate)).toBe(true);
    candidate.remove(FriendOf);
    expect(q.has(candidate)).toBe(false);
    candidate.set(FriendOf, { target: second });
    expect(q.has(candidate)).toBe(true);
    second.destroy();
    expect(q.has(candidate)).toBe(false);
  });

  it("nested target propagates changes through chained subqueries", () => {
    const { w } = setup();
    const grandparent = w.entity();
    const parent = w.entity().set(FriendOf, { target: grandparent });
    const child = w.entity().set(FriendOf, { target: parent });
    const q = w
      .query("nested")
      .where({ target: [FriendOf, { target: [FriendOf, Tag] }] })
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
    const candidate = w.entity().set(FriendOf, { target });
    const q = w
      .query("body-friends")
      .where({ all: [Body, { target: [FriendOf, Position] }] })
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
    const child = w.entity().set(FriendOf, { target: parent }).add(Position);
    const otherChild = w.entity().set(FriendOf, { target: otherParent }).add(Velocity);

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
        .where({ source: [FriendOf, Position] })
        .build();
    }).toThrow("source/children is not supported in a tracked query; use world.filter(...)");

    expect(() => {
      const { w } = setup();
      w.query("nested-down")
        .where({ target: [FriendOf, { source: [FriendOf, Position] }] })
        .build();
    }).toThrow("source/children is not supported in a tracked query; use world.filter(...)");

    expect(() => {
      const { w, phase } = setup();
      w.system("system-down")
        .phase(phase)
        .where({ source: [FriendOf, Position] });
      w.start();
    }).toThrow("source/children is not supported in a tracked query; use world.filter(...)");

    expect(() => {
      const { w, phase } = setup();
      w.system("system-each-down")
        .phase(phase)
        .where({ source: [FriendOf, Position] })
        .each([Body], () => {});
      w.start();
    }).toThrow("source/children is not supported in a tracked query; use world.filter(...)");
  });

  it("flattens target injection in query and filter iteration", () => {
    const { w } = setup();
    const target = w.entity().set(Position, { x: 7 });
    const candidate = w.entity().add(Body).set(FriendOf, { target });
    const body = candidate.get(Body)!;
    const pos = target.get(Position)!;
    const q = w.query("inject").requires(Body).build();

    const queryTuples: unknown[][] = [];
    q.forEach([Body, { target: [FriendOf, [Position, Velocity]] }], (_e, tuple) => {
      queryTuples.push([...tuple]);
    });

    const filterTuples: unknown[][] = [];
    w.filter(Body).forEach([Body, { target: [FriendOf, [Position, Velocity]] }], (_e, tuple) => {
      filterTuples.push([...tuple]);
    });

    expect(queryTuples).toEqual([[body, pos, undefined]]);
    expect(filterTuples).toEqual([[body, pos, undefined]]);
  });

  it("fans out down injection in query and filter iteration", () => {
    const { w } = setup();
    const parent = w.entity().add(Body);
    const lonely = w.entity().add(Body);
    const body = parent.get(Body)!;
    const childWithPosition = w.entity().set(FriendOf, { target: parent }).set(Position, { x: 7 });
    const childWithVelocity = w.entity().set(FriendOf, { target: parent }).add(Velocity);
    const pos = childWithPosition.get(Position)!;
    const vel = childWithVelocity.get(Velocity)!;
    const q = w.query("down-inject").requires(Body).build();

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
    childWithVelocity.set(FriendOf, { target: lonely });
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
    const child = w.entity().set(FriendOf, { target: parent }).add(Position);
    const q = w.query("down-iter").requires(Body).build();
    const seen: unknown[][] = [];

    q.forEach(Iter, [Body, { down: [FriendOf, [Position, Velocity]] }], (it, tuple) => {
      seen.push([it.entity, ...it.src, ...tuple]);
    });

    expect(seen).toEqual([
      [parent, parent, child, child, parent.get(Body), child.get(Position), undefined],
    ]);
  });

  it("interleaves up and down injection slots with the correct sources", () => {
    const { w } = setup();
    const target = w.entity().add(Velocity);
    const parent = w.entity().add(Body).set(FriendOf, { target });
    const child = w.entity().set(FriendOf, { target: parent }).add(Position);
    const q = w.query("up-down-iter").requires(Body).build();
    const seen: unknown[][] = [];

    q.forEach(
      Iter,
      [Body, { target: [FriendOf, [Velocity]] }, { down: [FriendOf, [Position]] }],
      (it, tuple) => {
        seen.push([it.entity, ...it.src, ...tuple]);
      }
    );

    expect(seen).toEqual([
      [parent, parent, target, child, parent.get(Body), target.get(Velocity), child.get(Position)],
    ]);
  });

  it("fans out down injection for system each", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("system-down")
      .phase(phase)
      .requires(Body)
      .each([{ down: [FriendOf, [Position, Velocity]] }], cb);
    w.start();
    const parent = w.entity().add(Body);
    const child = w.entity().set(FriendOf, { target: parent }).add(Position);

    w.progress(0, 0);

    expect(cb).toHaveBeenCalledWith(parent, [child.get(Position), undefined]);
  });

  it("rejects multiple down injections for query and filter iteration", () => {
    const { w } = setup();
    const q = w.query("multi-down").requires(Body).build();

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
    const candidate = w.entity().set(FriendOf, { target });
    const enter = vi.fn();
    const exit = vi.fn();
    w.query("events")
      .where({ target: [FriendOf, Position] })
      .enter([{ target: [FriendOf, [Position]] }], enter)
      .exit([{ target: [FriendOf, [Position]] }], exit)
      .build();

    const pos = target.add(Position).get(Position)!;
    expect(enter).toHaveBeenCalledWith(candidate, [pos]);
    target.remove(Position);
    expect(exit).toHaveBeenCalledWith(candidate, [undefined]);
  });

  it("flattens target injection for system each", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("system-up")
      .phase(phase)
      .where({ target: [FriendOf, Position] })
      .each([{ target: [FriendOf, [Position, Velocity]] }], cb);
    w.start();
    const target = w.entity().set(Position, { x: 3 });
    const candidate = w.entity().set(FriendOf, { target });
    const pos = target.get(Position)!;

    w.progress(0, 0);

    expect(cb).toHaveBeenCalledWith(candidate, [pos, undefined]);
  });

  it("target queries do not register hidden subqueries", () => {
    const { w } = setup();
    const plain = w.query("plain").requires(Body).build();
    const publicQueries = w.queries;

    expect(w.queries).toBe(publicQueries);
    plain.destroy();

    const q = w
      .query("outer")
      .where({ target: [FriendOf, Position] })
      .build();

    expect(w.queries).toEqual([q]);
    q.destroy();
    expect(w.queries).toEqual([]);
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
        .where({ source: [ChildOf, Position] })
        .build();
    }).toThrow("source/children is not supported in a tracked query");
  });

  it("source rejected in a tracked system query", () => {
    const { w } = setup();
    expect(() => {
      w.system("bad-sys")
        .where({ source: [ChildOf, Position] })
        .track()
        .build();
    }).toThrow("source/children is not supported in a tracked query");
  });

  it("source nested inside target in a tracked query throws", () => {
    const { w } = setup();
    expect(() => {
      w.query("nested-down")
        .where({ target: [FriendOf, { source: [ChildOf, Position] }] })
        .build();
    }).toThrow("source/children is not supported in a tracked query");
  });

  it("down injection fires once per child with each/forEach/Filter.forEach", () => {
    const { w } = setup();
    const parent = w.entity().add(Body);
    const child1 = w.entity().childOf(parent).set(Position, { x: 1 });
    const child2 = w.entity().childOf(parent).set(Position, { x: 2 });
    const body = parent.get(Body);

    const q = w.query("inject").requires(Body).build();
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
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("sys-down")
      .phase(phase)
      .requires(Body)
      .each([Body, { down: [ChildOf, [Position]] }] as any, cb);
    w.start();
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
      Iter,
      [Body, { down: [ChildOf, [Position]] }] as any,
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
      Iter,
      [{ down: [ChildOf, [Position]] }, Velocity] as any,
      (it: any, _tuple: any) => {
        results.push({ src: [...it.src] });
      }
    );
    expect(results).toHaveLength(1);
    expect(results[0].src[0]).toBe(child);
    expect(results[0].src[1]).toBe(parent);
  });
});
