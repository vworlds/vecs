import { describe, it, expect, vi, beforeEach } from "vitest";
import { Relationship, World } from "../../src/index.js";

class Position {
  x = 0;
  y = 0;
}
class Velocity {
  vx = 0;
  vy = 0;
}
class Sprite {}
class Container {}
class Tag {}
class Body {}
class FriendOf extends Relationship {}
class ChildOf extends Relationship {}

function setup() {
  const w = new World();
  w.component(Position);
  w.component(Velocity);
  w.component(Sprite);
  w.component(Container);
  w.component(Tag);
  w.component(Body);
  w.component(FriendOf);
  w.component(ChildOf);
  return w;
}

function setupWithFlush() {
  const w = setup();
  const phase = w.addPhase("p");
  w.system("__flush__")
    .phase(phase)
    .run(() => {});
  return { w, tick: () => w.progress(0, 0) };
}

// ---------------------------------------------------------------------------
// Phase 1: Term base + leaves + recursive propagation
// ---------------------------------------------------------------------------

describe("Term — WorldTerm (all live entities)", () => {
  it("contains all created entities", () => {
    const w = setup();
    const e1 = w.entity();
    const e2 = w.entity();
    const term = w.getTerm(true);
    expect(term.has(e1)).toBe(true);
    expect(term.has(e2)).toBe(true);
  });

  it("removes destroyed entities", () => {
    const w = setup();
    const e = w.entity();
    const term = w.getTerm(true);
    expect(term.has(e)).toBe(true);
    e.destroy();
    expect(term.has(e)).toBe(false);
  });

  it("tracks entity count", () => {
    const w = setup();
    const term = w.getTerm(true);
    expect(term.count).toBe(0);
    const e1 = w.entity();
    expect(term.count).toBe(1);
    const e2 = w.entity();
    expect(term.count).toBe(2);
    e1.destroy();
    expect(term.count).toBe(1);
  });

  it("propagates enter to consumers when an entity is created", () => {
    const w = setup();
    const consumer = vi.fn();
    const term = w.getTerm(true);
    term.onEnter(consumer);
    const e = w.entity();
    expect(consumer).toHaveBeenCalledWith(e);
  });

  it("propagates exit to consumers when an entity is destroyed", () => {
    const w = setup();
    const enter = vi.fn();
    const exit = vi.fn();
    const term = w.getTerm(true);
    term.onEnter(enter);
    term.onExit(exit);
    const e = w.entity();
    enter.mockClear();
    expect(exit).not.toHaveBeenCalled();
    e.destroy();
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("is a world-owned leaf — persists after all consumers release it", () => {
    const w = setup();
    const term = w.getTerm(true);
    term.release();
    expect(w.getTerm(true)).toBe(term);
  });
});

describe("Term — ComponentTerm (entities with a component)", () => {
  it("contains entities that have the component", () => {
    const w = setup();
    const term = w.getTerm(Position);
    const e = w.entity();
    e.add(Position);
    expect(term.has(e)).toBe(true);
  });

  it("does not contain entities without the component", () => {
    const w = setup();
    const term = w.getTerm(Position);
    const e = w.entity();
    expect(term.has(e)).toBe(false);
  });

  it("adds entity on add(Component)", () => {
    const w = setup();
    const enter = vi.fn();
    const term = w.getTerm(Position);
    term.onEnter(enter);
    const e = w.entity();
    e.add(Position);
    expect(term.has(e)).toBe(true);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("removes entity on remove(Component)", () => {
    const w = setup();
    const exit = vi.fn();
    const term = w.getTerm(Position);
    term.onExit(exit);
    const e = w.entity();
    e.add(Position);
    e.remove(Position);
    expect(term.has(e)).toBe(false);
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("removes entity on destroy()", () => {
    const w = setup();
    const exit = vi.fn();
    const term = w.getTerm(Position);
    term.onExit(exit);
    const e = w.entity();
    e.add(Position);
    e.destroy();
    expect(term.has(e)).toBe(false);
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("sharing: same component resolves to same term", () => {
    const w = setup();
    const t1 = w.getTerm(Position);
    const t2 = w.getTerm(Position);
    expect(t1).toBe(t2);
  });

  it("different components resolve to different terms", () => {
    const w = setup();
    const t1 = w.getTerm(Position);
    const t2 = w.getTerm(Velocity);
    expect(t1).not.toBe(t2);
  });

  it("exit snapshot captures component data before physical removal", () => {
    const w = setup();
    const exit = vi.fn();
    const term = w.getTerm(Position);
    term.onExit(exit);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    e.remove(Position);
    expect(exit).toHaveBeenCalledWith(e, expect.any(Map));
    const snapshot = exit.mock.calls[0][1] as Map<number, unknown>;
    expect(snapshot.get(w.entity(Position).eid)).toBe(pos);
  });

  it("tracks count accurately", () => {
    const w = setup();
    const term = w.getTerm(Position);
    expect(term.count).toBe(0);
    const e1 = w.entity();
    e1.add(Position);
    expect(term.count).toBe(1);
    const e2 = w.entity();
    e2.add(Position);
    expect(term.count).toBe(2);
    e1.remove(Position);
    expect(term.count).toBe(1);
  });

  it("is a world-owned leaf — persists after consumer release", () => {
    const w = setup();
    const term = w.getTerm(Position);
    term.release();
    expect(w.getTerm(Position)).toBe(term);
  });
});

describe("Term — EmptyTerm", () => {
  it("is always empty", () => {
    const w = setup();
    const term = w.getTerm(false);
    const e = w.entity();
    e.add(Position);
    expect(term.has(e)).toBe(false);
    expect(term.count).toBe(0);
  });

  it("never fires consumer callbacks", () => {
    const w = setup();
    const enter = vi.fn();
    const term = w.getTerm(false);
    term.onEnter(enter);
    w.entity().add(Position);
    expect(enter).not.toHaveBeenCalled();
  });
});

describe("Term — propagation through composites", () => {
  it("adding a component propagates through AllTerm", () => {
    const w = setup();
    const enter = vi.fn();
    const term = w.getTerm({ all: [Position, Velocity] });
    term.onEnter(enter);
    const e = w.entity();
    e.add(Position);
    expect(enter).not.toHaveBeenCalled();
    e.add(Velocity);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("removing a component propagates through NotTerm", () => {
    const w = setup();
    const enter = vi.fn();
    const term = w.getTerm({ not: Velocity });
    term.onEnter(enter);
    const e = w.entity();
    e.add(Velocity);
    enter.mockClear();
    e.remove(Velocity);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("composite enter and exit fire correctly for all([P, not(V)])", () => {
    const w = setup();
    const events: string[] = [];
    const term = w.getTerm({ all: [Position, { not: Velocity }] });
    term.onEnter(() => events.push("enter"));
    term.onExit(() => events.push("exit"));

    const e = w.entity();
    e.add(Position);
    expect(events).toEqual(["enter"]);
    e.add(Velocity);
    expect(events).toEqual(["enter", "exit"]);
    e.remove(Velocity);
    expect(events).toEqual(["enter", "exit", "enter"]);
  });

  it("destroy propagates exit through composite terms", () => {
    const w = setup();
    const exit = vi.fn();
    const term = w.getTerm({ all: [Position, Velocity] });
    term.onExit(exit);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    e.destroy();
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("nested all/any/not propagates membership changes correctly", () => {
    const w = setup();
    const enter = vi.fn();
    const exit = vi.fn();
    const term = w.getTerm({
      all: [Position, { any: [Velocity, Sprite] }, { not: Container }],
    });
    term.onEnter(enter);
    term.onExit(exit);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    expect(enter).toHaveBeenCalledWith(e);
    enter.mockClear();

    e.add(Container);
    expect(exit).toHaveBeenCalledWith(e);
    exit.mockClear();

    e.remove(Container);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("re-enter after exit fires exactly one enter", () => {
    const w = setup();
    const enter = vi.fn();
    const exit = vi.fn();
    const term = w.getTerm({ all: [Position, Velocity] });
    term.onEnter(enter);
    term.onExit(exit);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    expect(enter).toHaveBeenCalledTimes(1);

    e.remove(Position);
    expect(exit).toHaveBeenCalledTimes(1);

    e.add(Position);
    expect(enter).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Composites + getTerm/cache/dedup + diamond detection/collapse
// ---------------------------------------------------------------------------

describe("Term — canonical-key deduplication via getTerm", () => {
  it("getTerm returns identical term for equivalent DSL Position === [Position]", () => {
    const w = setup();
    const t1 = w.getTerm(Position);
    const t2 = w.getTerm([Position]);
    expect(t1).toBe(t2);
  });

  it("getTerm returns identical term for all([A, B]) vs [A, B]", () => {
    const w = setup();
    const t1 = w.getTerm([Position, Velocity]);
    const t2 = w.getTerm({ all: [Position, Velocity] });
    expect(t1).toBe(t2);
  });

  it("getTerm returns identical term for any([A, B]) vs any([B, A])", () => {
    const w = setup();
    const t1 = w.getTerm({ any: [Position, Velocity] });
    const t2 = w.getTerm({ any: [Velocity, Position] });
    expect(t1).toBe(t2);
  });

  it("getTerm returns identical term for repeated not(A)", () => {
    const w = setup();
    const t1 = w.getTerm({ not: Position });
    const t2 = w.getTerm({ not: Position });
    expect(t1).toBe(t2);
  });

  it("shared subexpressions reuse the same term node", () => {
    const w = setup();
    const posTerm = w.getTerm(Position);
    const allTerm = w.getTerm({ all: [Position, Velocity] });
    expect(allTerm.children()).toContain(posTerm);
  });

  it("cross-query sharing: two queries with same DSL share the root term", () => {
    const w = setup();
    const dsl = { all: [Position, Velocity] };
    const t1 = w.getTerm(dsl);
    const t2 = w.getTerm(dsl);
    expect(t1).toBe(t2);
  });
});

describe("Term — AllTerm", () => {
  it("contains entity only when all children contain it", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, Velocity] });
    const e = w.entity();
    e.add(Position);
    expect(term.has(e)).toBe(false);
    e.add(Velocity);
    expect(term.has(e)).toBe(true);
  });

  it("exits when entity loses any required component", () => {
    const w = setup();
    const exit = vi.fn();
    const term = w.getTerm({ all: [Position, Velocity] });
    term.onExit(exit);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    e.remove(Position);
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("three-way all matches only entities with all three components", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, Velocity, Sprite] });
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    expect(term.has(e)).toBe(false);
    e.add(Sprite);
    expect(term.has(e)).toBe(true);

    const e2 = w.entity();
    e2.add(Position);
    e2.add(Sprite);
    expect(term.has(e2)).toBe(false);
  });
});

describe("Term — AnyTerm", () => {
  it("contains entity when any child contains it", () => {
    const w = setup();
    const term = w.getTerm({ any: [Position, Velocity] });
    const e1 = w.entity();
    e1.add(Position);
    expect(term.has(e1)).toBe(true);
    const e2 = w.entity();
    e2.add(Velocity);
    expect(term.has(e2)).toBe(true);
    const e3 = w.entity();
    expect(term.has(e3)).toBe(false);
  });

  it("does not re-enter when entity gains additional matching component", () => {
    const w = setup();
    const enter = vi.fn();
    const term = w.getTerm({ any: [Position, Velocity] });
    term.onEnter(enter);
    const e = w.entity();
    e.add(Position);
    expect(enter).toHaveBeenCalledTimes(1);
    e.add(Velocity);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("exits only when entity loses all matching components", () => {
    const w = setup();
    const exit = vi.fn();
    const term = w.getTerm({ any: [Position, Velocity] });
    term.onExit(exit);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    e.remove(Position);
    expect(term.has(e)).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    e.remove(Velocity);
    expect(term.has(e)).toBe(false);
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("is unindexed (requires WorldTerm)", () => {
    const w = setup();
    const term = w.getTerm({ any: [Position, Velocity] });
    expect(term.isUnindexed()).toBe(true);
  });
});

describe("Term — NotTerm", () => {
  it("contains entities in WorldTerm that are NOT in the child term", () => {
    const w = setup();
    const term = w.getTerm({ not: Position });
    const e1 = w.entity();
    e1.add(Position);
    expect(term.has(e1)).toBe(false);
    const e2 = w.entity();
    expect(term.has(e2)).toBe(true);
  });

  it("exits when entity gains the excluded component", () => {
    const w = setup();
    const exit = vi.fn();
    const term = w.getTerm({ not: Position });
    term.onExit(exit);
    const e = w.entity();
    e.add(Position);
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("re-enters when entity loses the excluded component", () => {
    const w = setup();
    const enter = vi.fn();
    const exit = vi.fn();
    const term = w.getTerm({ not: Position });
    term.onEnter(enter);
    term.onExit(exit);
    const e = w.entity();
    enter.mockClear();
    e.add(Position);
    expect(exit).toHaveBeenCalledWith(e);
    exit.mockClear();
    e.remove(Position);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("plain not query: entity enters when the excluded component is removed", () => {
    const w = setup();
    const enter = vi.fn();
    w.getTerm({ not: Velocity }).onEnter(enter);
    const e = w.entity();
    e.add(Velocity);
    enter.mockClear();
    e.remove(Velocity);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("is unindexed (requires WorldTerm)", () => {
    const w = setup();
    const term = w.getTerm({ not: Position });
    expect(term.isUnindexed()).toBe(true);
  });
});

describe("Term — OnlyTerm", () => {
  it("matches entities with exactly that component set", () => {
    const w = setup();
    const term = w.getTerm({ only: [Position] });
    const e1 = w.entity();
    e1.add(Position);
    expect(term.has(e1)).toBe(true);
    const e2 = w.entity();
    e2.add(Position);
    e2.add(Velocity);
    expect(term.has(e2)).toBe(false);
  });

  it("enters when entity gains exactly the required components", () => {
    const w = setup();
    const enter = vi.fn();
    const term = w.getTerm({ only: [Position] });
    term.onEnter(enter);
    const e = w.entity();
    e.add(Position);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("exits when entity gains an extra component", () => {
    const w = setup();
    const exit = vi.fn();
    const term = w.getTerm({ only: [Position] });
    term.onExit(exit);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("is unindexed (exact set cannot be routed by single component)", () => {
    const w = setup();
    const term = w.getTerm({ only: [Position] });
    expect(term.isUnindexed()).toBe(true);
  });
});

describe("Term — PredicateTerm (test)", () => {
  it("matches entities where the predicate returns true", () => {
    const w = setup();
    const predicate = (e: any) => e.eid === 7;
    const term = w.getTerm({ test: predicate });
    const e = w.getOrCreateEntity(7);
    e.add(Position);
    expect(term.has(e)).toBe(true);
    const other = w.entity();
    other.add(Position);
    expect(term.has(other)).toBe(false);
  });

  it("is unindexed (predicates cannot be statically routed)", () => {
    const w = setup();
    const term = w.getTerm({ test: () => true });
    expect(term.isUnindexed()).toBe(true);
  });
});

describe("Term — MergedPredicateTerm (diamond breaking)", () => {
  it("all(A, not(A)) collapses to a MergedPredicateTerm", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, { not: Position }] });
    expect(term.kind).toBe("merged");
  });

  it("all(A, not(A)) always evaluates to false (contradiction)", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, { not: Position }] });
    const e = w.entity();
    e.add(Position);
    expect(term.has(e)).toBe(false);
    expect(term.count).toBe(0);
  });

  it("any(Position, all(Position, Velocity)) collapses to MergedPredicateTerm", () => {
    const w = setup();
    const term = w.getTerm({ any: [Position, { all: [Position, Velocity] }] });
    expect(term.kind).toBe("merged");
  });

  it("merged term emits exactly one enter/exit per real transition (no spurious pairs)", () => {
    const w = setup();
    const enter = vi.fn();
    const exit = vi.fn();
    const term = w.getTerm({ any: [Position, { all: [Position, Velocity] }] });
    term.onEnter(enter);
    term.onExit(exit);

    const e = w.entity();
    e.add(Position);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    e.add(Velocity);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    e.remove(Velocity);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    e.remove(Position);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("any(not(A), A) collapses to MergedPredicateTerm", () => {
    const w = setup();
    const term = w.getTerm({ any: [{ not: Position }, Position] });
    expect(term.kind).toBe("merged");
  });

  it("any(not(A), A) is always true (tautology)", () => {
    const w = setup();
    const term = w.getTerm({ any: [{ not: Position }, Position] });
    const e = w.entity();
    expect(term.has(e)).toBe(true);
    e.add(Position);
    expect(term.has(e)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Query/System/Filter repointed onto root terms + slim update channel
// ---------------------------------------------------------------------------

describe("Term — integration with existing Query public API", () => {
  it("Query delegates membership to root term", () => {
    const { w, tick } = setupWithFlush();
    const q = w.query("test").requires(Position).build();
    w.start();
    const e = w.entity();
    e.add(Position);
    tick();
    expect(q.has(e)).toBe(true);
    expect(q.count).toBe(1);

    e.remove(Position);
    tick();
    expect(q.count).toBe(0);
  });

  it("Query uses root term for belongs()", () => {
    const w = setup();
    const q = w.query("test").requires(Position, Velocity).build();
    const e = w.entity();
    e.add(Position);
    expect(q.belongs(e)).toBe(false);
    e.add(Velocity);
    expect(q.belongs(e)).toBe(true);
  });

  it("Query enter/exit callbacks fire via term propagation", () => {
    const { w, tick } = setupWithFlush();
    const enter = vi.fn();
    const exit = vi.fn();
    w.query("test").requires(Position).enter(enter).exit(exit);
    w.start();

    const e = w.entity();
    e.add(Position);
    tick();
    expect(enter).toHaveBeenCalledWith(e);
    e.remove(Position);
    tick();
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("Query update callbacks fire via slim update channel", () => {
    const { w, tick } = setupWithFlush();
    const update = vi.fn();
    w.query("test").requires(Position).update(Position, update);
    w.start();

    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    tick();
    update.mockClear();
    e.modified(Position);
    tick();
    expect(update).toHaveBeenCalledWith(e, pos);
  });

  it("System receives enter events via term propagation", () => {
    const { w, tick } = setupWithFlush();
    const enter = vi.fn();
    const phase = w.addPhase("p");
    w.system("test").phase(phase).requires(Position).enter(enter);
    w.start();

    const e = w.entity();
    e.add(Position);
    tick();
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("System update fires on modified()", () => {
    const { w } = setupWithFlush();
    const phase = w.addPhase("p2");
    const update = vi.fn();
    w.system("test").phase(phase).requires(Position).update(Position, update);
    w.start();

    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    w.progress(0, 0);
    update.mockClear();
    e.modified(Position);
    w.progress(0, 0);
    expect(update).toHaveBeenCalledWith(e, pos);
  });

  it("Filter reuses a cached term if one exists", () => {
    const w = setup();
    const q = w.query("test").requires(Position).build();
    const term = q.rootTerm!;
    const f = w.filter(Position);
    expect(f.rootTerm).toBe(term);
  });

  it("Filter falls back to compile-and-scan when no term is cached", () => {
    const w = setup();
    const f = w.filter(Position);
    expect(f.rootTerm).toBeUndefined();
    const e = w.entity();
    e.add(Position);
    const seen: unknown[] = [];
    f.forEach((ent) => seen.push(ent));
    expect(seen).toContain(e);
  });
});

describe("Term — entity no longer carries full query membership set", () => {
  it("entity._queries does not grow with every matching query (slim update set only)", () => {
    const w = setup();
    const q1 = w.query("q1").requires(Position).build();
    const q2 = w.query("q2").requires(Position).build();
    const q3 = w.query("q3").requires(Position).build();
    const e = w.entity();
    e.add(Position);
    expect(e._queries.size).toBeLessThan(3);
  });
});

describe("Term — structural routing eliminates unindexed bucket for component-indexed terms", () => {
  it("a Position change does not cause a Velocity-only term to re-evaluate", () => {
    const w = setup();
    const velTerm = w.getTerm(Velocity);
    const belongsSpy = vi.spyOn(velTerm, "belongs");
    const e = w.entity();
    e.add(Position);
    expect(belongsSpy).not.toHaveBeenCalled();
  });

  it("an unrelated component change does not trigger NotTerm(V) recheck", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, { not: Velocity }] });
    const enter = vi.fn();
    const exit = vi.fn();
    term.onEnter(enter);
    term.onExit(exit);
    const e = w.entity();
    e.add(Position);
    enter.mockClear();
    e.add(Sprite);
    expect(enter).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("Term — update channel bypasses the tree", () => {
  it("modified(C) fires update callback only on consumers watching C", () => {
    const { w, tick } = setupWithFlush();
    const updatePos = vi.fn();
    const updateVel = vi.fn();
    w.query("test")
      .requires(Position)
      .update(Position, updatePos)
      .update(Velocity, updateVel)
      .build();
    w.start();

    const e = w.entity();
    e.add(Position);
    tick();
    updatePos.mockClear();
    updateVel.mockClear();

    e.modified(Position);
    tick();
    expect(updatePos).toHaveBeenCalledWith(e, e.get(Position));
    expect(updateVel).not.toHaveBeenCalled();
  });

  it("modified(C) does not fire for components not on the watchlist", () => {
    const { w, tick } = setupWithFlush();
    const updateVel = vi.fn();
    w.query("test").requires(Position).update(Velocity, updateVel).build();
    w.start();

    const e = w.entity();
    e.add(Position);
    tick();
    e.modified(Position);
    tick();
    expect(updateVel).not.toHaveBeenCalled();
  });

  it("update callback does not trigger enter/exit propagation", () => {
    const { w, tick } = setupWithFlush();
    const enter = vi.fn();
    const term = w.getTerm(Position);
    term.onEnter(enter);
    enter.mockClear();

    const updateCb = vi.fn();
    w.query("test").requires(Position).update(Position, updateCb).build();
    w.start();

    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    tick();
    updateCb.mockClear();
    e.modified(Position);
    tick();
    expect(updateCb).toHaveBeenCalledWith(e, pos);
    expect(enter).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 4: TargetTerm
// ---------------------------------------------------------------------------

describe("Term — TargetTerm", () => {
  it("matches entities whose relationship target matches the inner DSL", () => {
    const w = setup();
    const target = w.entity().add(Position);
    const candidate = w.entity().set(FriendOf, { target });
    const miss = w.entity().set(FriendOf, { target: w.entity() });

    const term = w.getTerm({ target: [FriendOf, Position] });
    expect(term.has(candidate)).toBe(true);
    expect(term.has(miss)).toBe(false);
  });

  it("reacts when target gains and loses inner components", () => {
    const w = setup();
    const target = w.entity();
    const candidate = w.entity().set(FriendOf, { target });
    const term = w.getTerm({ target: [FriendOf, Position] });
    expect(term.has(candidate)).toBe(false);
    target.add(Position);
    expect(term.has(candidate)).toBe(true);
    target.remove(Position);
    expect(term.has(candidate)).toBe(false);
  });

  it("reacts to relationship retargeting", () => {
    const w = setup();
    const first = w.entity().add(Position);
    const second = w.entity();
    const candidate = w.entity().set(FriendOf, { target: first });

    const term = w.getTerm({ target: [FriendOf, Position] });
    expect(term.has(candidate)).toBe(true);

    candidate.set(FriendOf, { target: second });
    expect(term.has(candidate)).toBe(false);

    second.add(Position);
    expect(term.has(candidate)).toBe(true);
  });

  it("reacts to relationship removal", () => {
    const w = setup();
    const target = w.entity().add(Position);
    const candidate = w.entity().set(FriendOf, { target });
    const term = w.getTerm({ target: [FriendOf, Position] });
    expect(term.has(candidate)).toBe(true);
    candidate.remove(FriendOf);
    expect(term.has(candidate)).toBe(false);
  });

  it("nested target propagates changes through chained terms", () => {
    const w = setup();
    const grandparent = w.entity();
    const parent = w.entity().set(FriendOf, { target: grandparent });
    const child = w.entity().set(FriendOf, { target: parent });

    const term = w.getTerm({ target: [FriendOf, { target: [FriendOf, Tag] }] });
    expect(term.has(child)).toBe(false);
    grandparent.add(Tag);
    expect(term.has(child)).toBe(true);
    grandparent.remove(Tag);
    expect(term.has(child)).toBe(false);
  });

  it("combines target with candidate-side component term", () => {
    const w = setup();
    const target = w.entity().add(Position);
    const candidate = w.entity().set(FriendOf, { target });
    const term = w.getTerm({ all: [Body, { target: [FriendOf, Position] }] });
    expect(term.has(candidate)).toBe(false);
    candidate.add(Body);
    expect(term.has(candidate)).toBe(true);
  });

  it("target term enters/exits reactively", () => {
    const w = setup();
    const enter = vi.fn();
    const exit = vi.fn();
    const term = w.getTerm({ target: [FriendOf, Position] });
    term.onEnter(enter);
    term.onExit(exit);

    const target = w.entity().add(Position);
    const candidate = w.entity().set(FriendOf, { target });
    expect(enter).toHaveBeenCalledWith(candidate);

    target.remove(Position);
    expect(exit).toHaveBeenCalledWith(candidate);
  });

  it("parent is sugar over target(ChildOf, inner)", () => {
    const w = setup();
    const child = w.entity();
    const parent = w.entity().set(ChildOf, { target: child });

    const term = w.getTerm({ parent: Position });
    expect(term.has(parent)).toBe(false);
    child.add(Position);
    expect(term.has(parent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 5: Ref-counted lifetime
// ---------------------------------------------------------------------------

describe("Term — ref-counted lifetime", () => {
  it("composite term is destroyed when all consumers release it", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, Velocity] });
    const key = term.key;
    term.release();
    const term2 = w.getTerm({ all: [Position, Velocity] });
    expect(term2).not.toBe(term);
  });

  it("world-owned leaf terms persist even after all consumers release them", () => {
    const w = setup();
    const posTerm = w.getTerm(Position);
    const key = posTerm.key;
    posTerm.release();
    expect(w.getTerm(key)).toBe(posTerm);
    expect(w.getTerm(Position)).toBe(posTerm);
  });

  it("releasing a composite term cascades release to child terms no longer referenced", () => {
    const w = setup();
    const allTerm = w.getTerm({ all: [Position, Velocity] });
    const posTerm = w.getTerm(Position);
    const velTerm = w.getTerm(Velocity);
    allTerm.release();
    expect(w.getTerm(Position)).toBe(posTerm);
    expect(w.getTerm(Velocity)).toBe(velTerm);
  });

  it("retain() prevents destruction by a single release()", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, Velocity] });
    term.retain();
    term.release();
    const term2 = w.getTerm({ all: [Position, Velocity] });
    expect(term2).toBe(term);
    term.release();
  });

  it("destroyed composite term stops receiving propagation", () => {
    const w = setup();
    const enter = vi.fn();
    const term = w.getTerm({ all: [Position, Velocity] });
    term.onEnter(enter);
    term.release();

    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    expect(enter).not.toHaveBeenCalled();
  });

  it("Query retains its root term; releasing the query releases the term", () => {
    const w = setup();
    const q = w.query("test").requires(Position).build();
    const rootTerm = q.rootTerm;
    expect(rootTerm).toBeDefined();
    q.destroy();
    const freshTerm = w.getTerm(Position);
    expect(freshTerm).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Targeted-update regression
// ---------------------------------------------------------------------------

describe("Term — targeted-update regression", () => {
  it("modified(C) fires update(C) only on consumers watching C, walking only the slim per-entity set", () => {
    const { w, tick } = setupWithFlush();
    const posOnlyUpdate = vi.fn();
    const velOnlyUpdate = vi.fn();

    w.query("posOnly").requires(Position).update(Position, posOnlyUpdate).build();
    w.query("velOnly").requires(Velocity).update(Velocity, velOnlyUpdate).build();
    w.start();

    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    tick();
    posOnlyUpdate.mockClear();
    velOnlyUpdate.mockClear();

    e.modified(Position);
    tick();
    expect(posOnlyUpdate).toHaveBeenCalledWith(e, e.get(Position));
    expect(velOnlyUpdate).not.toHaveBeenCalled();

    e.modified(Velocity);
    tick();
    expect(velOnlyUpdate).toHaveBeenCalledWith(e, e.get(Velocity));
  });

  it("update event does not traverse the term tree", () => {
    const w = setup();
    const posEnter = vi.fn();
    const posTerm = w.getTerm(Position);
    posTerm.onEnter(posEnter);
    posEnter.mockClear();

    const updateCb = vi.fn();
    w.query("test").requires(Position).update(Position, updateCb).build();
    w.start();

    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    updateCb.mockClear();

    e.modified(Position);
    w.progress(0, 0);
    expect(updateCb).toHaveBeenCalled();
    expect(posEnter).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Exit snapshots
// ---------------------------------------------------------------------------

describe("Term — exit snapshots preserve component data", () => {
  it("exit callback receives snapshot with removed component data", () => {
    const w = setup();
    const exit = vi.fn();
    const term = w.getTerm(Position);
    term.onExit(exit);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    e.remove(Position);
    expect(exit).toHaveBeenCalledWith(e, expect.any(Map));
    const snapshot = exit.mock.calls[0][1] as Map<number, unknown>;
    expect(snapshot.get(w.entity(Position).eid)).toBe(pos);
  });

  it("exit snapshot on destroy captures all components", () => {
    const w = setup();
    const exit = vi.fn();
    const term = w.getTerm({ all: [Position, Velocity] });
    term.onExit(exit);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    const vel = e.add(Velocity).get(Velocity)!;
    e.destroy();
    expect(exit).toHaveBeenCalledWith(e, expect.any(Map));
    const snapshot = exit.mock.calls[0][1] as Map<number, unknown>;
    expect(snapshot.get(w.entity(Position).eid)).toBe(pos);
    expect(snapshot.get(w.entity(Velocity).eid)).toBe(vel);
  });
});
