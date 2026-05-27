import { describe, expect, it, vi } from "vitest";
import { Relationship, World } from "../src/index.js";

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
      .query({ UP: [FriendOf, Position] })
      .build();

    expect(q.belongs(candidate)).toBe(true);
    expect(q.belongs(miss)).toBe(false);

    const seen: unknown[] = [];
    w.filter({ UP: [FriendOf, Position] }).forEach((e) => seen.push(e));
    expect(seen).toContain(candidate);
    expect(seen).not.toContain(miss);
  });

  it("live tracking reacts when the target gains and loses inner components", () => {
    const { w } = setup();
    const target = w.entity();
    const candidate = w.entity().set(FriendOf, { target });
    const q = w
      .query("friends")
      .query({ UP: [FriendOf, Position] })
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
      .query({ UP: [FriendOf, Position] })
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

  it("nested UP propagates changes through chained subqueries", () => {
    const { w } = setup();
    const grandparent = w.entity();
    const parent = w.entity().set(FriendOf, { target: grandparent });
    const child = w.entity().set(FriendOf, { target: parent });
    const q = w
      .query("nested")
      .query({ UP: [FriendOf, { UP: [FriendOf, Tag] }] })
      .build();

    expect(q.has(child)).toBe(false);
    grandparent.add(Tag);
    expect(q.has(child)).toBe(true);
    grandparent.remove(Tag);
    expect(q.has(child)).toBe(false);
  });

  it("combines UP with candidate-side component routing", () => {
    const { w } = setup();
    const target = w.entity().add(Position);
    const candidate = w.entity().set(FriendOf, { target });
    const q = w
      .query("body-friends")
      .query({ AND: [Body, { UP: [FriendOf, Position] }] })
      .build();

    expect(q.has(candidate)).toBe(false);
    candidate.add(Body);
    expect(q.has(candidate)).toBe(true);
    candidate.remove(Body);
    expect(q.has(candidate)).toBe(false);
  });

  it("flattens up injection in query and filter iteration", () => {
    const { w } = setup();
    const target = w.entity().set(Position, { x: 7 });
    const candidate = w.entity().add(Body).set(FriendOf, { target });
    const body = candidate.get(Body)!;
    const pos = target.get(Position)!;
    const q = w.query("inject").requires(Body).build();

    const queryTuples: unknown[][] = [];
    q.forEach([Body, { up: [FriendOf, [Position, Velocity]] }], (_e, tuple) => {
      queryTuples.push([...tuple]);
    });

    const filterTuples: unknown[][] = [];
    w.filter(Body).forEach([Body, { up: [FriendOf, [Position, Velocity]] }], (_e, tuple) => {
      filterTuples.push([...tuple]);
    });

    expect(queryTuples).toEqual([[body, pos, undefined]]);
    expect(filterTuples).toEqual([[body, pos, undefined]]);
  });

  it("flattens up injection for enter and exit callbacks", () => {
    const { w } = setup();
    const target = w.entity();
    const candidate = w.entity().set(FriendOf, { target });
    const enter = vi.fn();
    const exit = vi.fn();
    w.query("events")
      .query({ UP: [FriendOf, Position] })
      .enter([{ up: [FriendOf, [Position]] }], enter)
      .exit([{ up: [FriendOf, [Position]] }], exit)
      .build();

    const pos = target.add(Position).get(Position)!;
    expect(enter).toHaveBeenCalledWith(candidate, [pos]);
    target.remove(Position);
    expect(exit).toHaveBeenCalledWith(candidate, [undefined]);
  });

  it("flattens up injection for system each", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("system-up")
      .phase(phase)
      .query({ UP: [FriendOf, Position] })
      .each([{ up: [FriendOf, [Position, Velocity]] }], cb);
    w.start();
    const target = w.entity().set(Position, { x: 3 });
    const candidate = w.entity().set(FriendOf, { target });
    const pos = target.get(Position)!;

    w.progress(0, 0);

    expect(cb).toHaveBeenCalledWith(candidate, [pos, undefined]);
  });

  it("hides internal subqueries and destroys them with the outer query", () => {
    const { w } = setup();
    const plain = w.query("plain").requires(Body).build();
    const publicQueries = w.queries;

    expect(w.queries).toBe(publicQueries);
    plain.destroy();

    const q = w
      .query("outer")
      .query({ UP: [FriendOf, Position] })
      .build();

    expect(w.queries).toEqual([q]);
    q.destroy();
    expect(w.queries).toEqual([]);
    expect((q as unknown as { _subqueries: unknown[] })._subqueries).toEqual([]);
  });
});
