import { describe, it, expect, vi } from "vitest";
import { ChildOf, Relationship, World, TermEventKind } from "../../src/index.js";
import type { Entity, Term, TermConsumer } from "../../src/index.js";

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

/**
 * Subscribe to a term's single ordered event stream and expose enter/exit spies.
 * The consumer receives discrete `(kind, entity)` params — no per-event object —
 * matching the canonical `TermConsumer` protocol. Returns the `unsubscribe` fn
 * so lifetime tests can drop the consumer.
 */
function listen(term: Term) {
  const enter = vi.fn<[Entity], void>();
  const exit = vi.fn<[Entity], void>();
  const consumer: TermConsumer = {
    onTermEvent(kind: TermEventKind, entity: Entity) {
      (kind === TermEventKind.Enter ? enter : exit)(entity);
    },
  };
  const unsubscribe = term.subscribe(consumer);
  return { enter, exit, consumer, unsubscribe };
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
    // Component-definition entities are first-class members of the world, so
    // measure deltas against whatever baseline `setup()` registered.
    const base = term.count;
    const e1 = w.entity();
    expect(term.count).toBe(base + 1);
    const e2 = w.entity();
    expect(term.count).toBe(base + 2);
    e1.destroy();
    expect(term.count).toBe(base + 1);
  });

  it("includes component-definition entities, including late registration (reflection)", () => {
    const w = new World();
    w.component(Position);
    const term = w.getTerm(true);
    // A component registered before the query exists is found by the initial scan.
    expect(term.has(w.component(Position))).toBe(true);
    // A component registered while the query is live enters reactively.
    const before = term.count;
    w.component(Velocity);
    expect(term.count).toBe(before + 1);
    expect(term.has(w.component(Velocity))).toBe(true);
  });

  it("emits an enter event when an entity is created", () => {
    const w = setup();
    const term = w.getTerm(true);
    const { enter } = listen(term);
    const e = w.entity();
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("emits an exit event when an entity is destroyed", () => {
    const w = setup();
    const term = w.getTerm(true);
    const { enter, exit } = listen(term);
    const e = w.entity();
    enter.mockClear();
    expect(exit).not.toHaveBeenCalled();
    e.destroy();
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("is a world-owned leaf — persists after consumers unsubscribe", () => {
    const w = setup();
    const term = w.getTerm(true);
    listen(term).unsubscribe();
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

  it("emits enter on add(Component)", () => {
    const w = setup();
    const term = w.getTerm(Position);
    const { enter } = listen(term);
    const e = w.entity();
    e.add(Position);
    expect(term.has(e)).toBe(true);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("emits exit on remove(Component)", () => {
    const w = setup();
    const term = w.getTerm(Position);
    const { exit } = listen(term);
    const e = w.entity();
    e.add(Position);
    e.remove(Position);
    expect(term.has(e)).toBe(false);
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("emits exit on destroy()", () => {
    const w = setup();
    const term = w.getTerm(Position);
    const { exit } = listen(term);
    const e = w.entity();
    e.add(Position);
    e.destroy();
    expect(term.has(e)).toBe(false);
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("sharing: same component resolves to same term", () => {
    const w = setup();
    expect(w.getTerm(Position)).toBe(w.getTerm(Position));
  });

  it("different components resolve to different terms", () => {
    const w = setup();
    expect(w.getTerm(Position)).not.toBe(w.getTerm(Velocity));
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

  it("is a world-owned leaf — persists after consumers unsubscribe", () => {
    const w = setup();
    const term = w.getTerm(Position);
    listen(term).unsubscribe();
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

  it("never emits events", () => {
    const w = setup();
    const term = w.getTerm(false);
    const { enter, exit } = listen(term);
    w.entity().add(Position);
    expect(enter).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("Term — propagation through composites", () => {
  it("adding a component propagates through AllTerm", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, Velocity] });
    const { enter } = listen(term);
    const e = w.entity();
    e.add(Position);
    expect(enter).not.toHaveBeenCalled();
    e.add(Velocity);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("removing a component propagates through NotTerm", () => {
    const w = setup();
    const term = w.getTerm({ not: Velocity });
    const { enter } = listen(term);
    const e = w.entity();
    e.add(Velocity);
    enter.mockClear();
    e.remove(Velocity);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("composite enter and exit fire in order for all([P, not(V)])", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, { not: Velocity }] });
    const { enter, exit } = listen(term);

    const e = w.entity();
    e.add(Position);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(0);
    e.add(Velocity);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    e.remove(Velocity);
    expect(enter).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("destroy propagates exit through composite terms", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, Velocity] });
    const { exit } = listen(term);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    e.destroy();
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("nested all/any/not propagates membership changes correctly", () => {
    const w = setup();
    const term = w.getTerm({
      all: [Position, { any: [Velocity, Sprite] }, { not: Container }],
    });
    const { enter, exit } = listen(term);
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
    const term = w.getTerm({ all: [Position, Velocity] });
    const { enter, exit } = listen(term);
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
  it("Position === [Position]", () => {
    const w = setup();
    expect(w.getTerm(Position)).toBe(w.getTerm([Position]));
  });

  it("all([A, B]) === [A, B]", () => {
    const w = setup();
    expect(w.getTerm([Position, Velocity])).toBe(w.getTerm({ all: [Position, Velocity] }));
  });

  it("any([A, B]) === any([B, A])", () => {
    const w = setup();
    expect(w.getTerm({ any: [Position, Velocity] })).toBe(w.getTerm({ any: [Velocity, Position] }));
  });

  it("repeated not(A) dedups", () => {
    const w = setup();
    expect(w.getTerm({ not: Position })).toBe(w.getTerm({ not: Position }));
  });

  it("shared subexpressions reuse the same child term node", () => {
    const w = setup();
    const posTerm = w.getTerm(Position);
    const allTerm = w.getTerm({ all: [Position, Velocity] });
    expect(allTerm.children()).toContain(posTerm);
  });

  it("cross-query sharing: two queries with same DSL share the root term", () => {
    const w = setup();
    const dsl = { all: [Position, Velocity] };
    expect(w.getTerm(dsl)).toBe(w.getTerm(dsl));
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
    const term = w.getTerm({ all: [Position, Velocity] });
    const { exit } = listen(term);
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
    const term = w.getTerm({ any: [Position, Velocity] });
    const { enter } = listen(term);
    const e = w.entity();
    e.add(Position);
    expect(enter).toHaveBeenCalledTimes(1);
    e.add(Velocity);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("exits only when entity loses all matching components", () => {
    const w = setup();
    const term = w.getTerm({ any: [Position, Velocity] });
    const { exit } = listen(term);
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

  it("is driven by its component leaves alone (no lifecycle dependency)", () => {
    const w = setup();
    const any = w.getTerm({ any: [Position, Velocity] });
    const { enter } = listen(any);
    // A bare entity (lifecycle-only event) must not enter an any-of-components term.
    w.entity();
    expect(enter).not.toHaveBeenCalled();
  });
});

describe("Term — NotTerm", () => {
  it("contains live entities that are NOT in the child term", () => {
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
    const term = w.getTerm({ not: Position });
    const { exit } = listen(term);
    const e = w.entity();
    e.add(Position);
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("re-enters when entity loses the excluded component", () => {
    const w = setup();
    const term = w.getTerm({ not: Position });
    const { enter, exit } = listen(term);
    const e = w.entity();
    enter.mockClear();
    e.add(Position);
    expect(exit).toHaveBeenCalledWith(e);
    exit.mockClear();
    e.remove(Position);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("reacts to entity lifecycle (depends on WorldTerm)", () => {
    const w = setup();
    const term = w.getTerm({ not: Position });
    const { enter } = listen(term);
    // A freshly created entity with no components belongs to not(Position).
    const e = w.entity();
    expect(enter).toHaveBeenCalledWith(e);
  });
});

describe("Term — OnlyTerm (exact component set)", () => {
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
    const term = w.getTerm({ only: [Position] });
    const { enter } = listen(term);
    const e = w.entity();
    e.add(Position);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("exits when entity gains an extra component", () => {
    const w = setup();
    const term = w.getTerm({ only: [Position] });
    const { exit } = listen(term);
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    expect(exit).toHaveBeenCalledWith(e);
  });
});

describe("Term — PredicateTerm (test + watch)", () => {
  it("matches entities for which the predicate holds, re-evaluating on watched component changes", () => {
    const w = setup();
    const predicate = (e: Entity) => e.get(Position) !== undefined && e.get(Velocity) !== undefined;
    const term = w.getTerm({ test: predicate, watch: [Position, Velocity] });
    const e = w.entity();
    e.add(Position);
    expect(term.has(e)).toBe(false);
    e.add(Velocity);
    expect(term.has(e)).toBe(true);
    e.remove(Velocity);
    expect(term.has(e)).toBe(false);
  });

  it("ignores component changes outside the watchlist (watchlist gates re-evaluation)", () => {
    const w = setup();
    // The predicate depends on Velocity, but the watchlist deliberately omits it.
    const term = w.getTerm({
      test: (e: Entity) => e.get(Velocity) !== undefined,
      watch: [Position],
    });
    const e = w.entity();
    e.add(Position); // watched: re-evaluate -> Velocity absent -> not a member
    expect(term.has(e)).toBe(false);
    e.add(Velocity); // unwatched: no re-evaluation -> membership stays stale
    expect(term.has(e)).toBe(false);
  });

  it("re-evaluates newly created entities via WorldTerm lifecycle", () => {
    const w = setup();
    const term = w.getTerm({ test: () => true, watch: [] });
    const { enter } = listen(term);
    const e = w.entity();
    expect(enter).toHaveBeenCalledWith(e);
  });
});

describe("Term — MergedPredicateTerm (diamond breaking)", () => {
  it("all(A, not(A)) collapses to a merged term", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, { not: Position }] });
    expect(term.kind).toBe("merged");
  });

  it("collapsing all(A, not(A)) does not leave orphan composite subscriptions", () => {
    const w = setup();
    w.getTerm({ all: [Position, { not: Position }] });

    const cache = [...(w as any)._termCache.values()].map((term: Term) => term.kind);
    expect(cache).toEqual(expect.arrayContaining(["merged", "component", "world"]));
    expect(cache).not.toContain("all");
    expect(cache).not.toContain("not");
  });

  it("all(A, not(A)) always evaluates to false (contradiction)", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, { not: Position }] });
    const e = w.entity();
    e.add(Position);
    expect(term.has(e)).toBe(false);
    expect(term.count).toBe(0);
  });

  it("any(Position, all(Position, Velocity)) collapses to a merged term", () => {
    const w = setup();
    const term = w.getTerm({ any: [Position, { all: [Position, Velocity] }] });
    expect(term.kind).toBe("merged");
  });

  it("merged term emits exactly one enter/exit per real transition (no spurious pairs)", () => {
    const w = setup();
    const term = w.getTerm({ any: [Position, { all: [Position, Velocity] }] });
    const { enter, exit } = listen(term);

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

  it("any(not(A), A) collapses to a merged term and is always true (tautology)", () => {
    const w = setup();
    const term = w.getTerm({ any: [{ not: Position }, Position] });
    expect(term.kind).toBe("merged");
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
    const phase = w.addPhase("sys");
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

  it("Filter picks up a term cached after construction", () => {
    const w = setup();
    const f = w.filter(Position);
    expect(f.rootTerm).toBeUndefined();
    const q = w.query("test").requires(Position).build();
    expect(f.rootTerm).toBe(q.rootTerm);
  });

  it("Filter falls back to scanning after a cached composite term is destroyed", () => {
    const w = setup();
    const e = w.entity().add(Position).add(Velocity);
    const q = w.query("test").requires(Position, Velocity).build();
    const f = w.filter([Position, Velocity]);
    expect(f.rootTerm).toBe(q.rootTerm);

    q.destroy();
    expect(f.rootTerm).toBeUndefined();
    const seen: Entity[] = [];
    f.forEach((ent) => seen.push(ent));
    expect(seen).toEqual([e]);
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
  it("unsorted queries read membership from the root term without a parallel entity set", () => {
    const w = setup();
    const q = w.query("q").requires(Position).build();
    expect((q as any)._entities).toBeUndefined();

    const e = w.entity().add(Position);
    expect(q.has(e)).toBe(true);
    expect(q.count).toBe(1);
    expect([...q]).toEqual([e]);
  });

  it("entity._queries holds only the slim update set, not every matching query", () => {
    const w = setup();
    w.query("q1").requires(Position).build();
    w.query("q2").requires(Position).build();
    w.query("q3").requires(Position).build();
    const e = w.entity();
    e.add(Position);
    // No update callbacks registered, so the slim per-entity set is empty.
    expect((e as any)._queries.size).toBe(0);
  });
});

describe("Term — structural routing only touches dependent terms", () => {
  it("a Position change does not emit events on a Velocity-only term", () => {
    const w = setup();
    const velTerm = w.getTerm(Velocity);
    const { enter, exit } = listen(velTerm);
    const e = w.entity();
    e.add(Position);
    expect(enter).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("an unrelated component change does not flip all([P, not(V)])", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, { not: Velocity }] });
    const { enter, exit } = listen(term);
    const e = w.entity();
    e.add(Position);
    enter.mockClear();
    e.add(Sprite);
    expect(enter).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("world shape refresh is subscribed only by exact-shape terms", () => {
    const w = setup();
    const worldTerm = w.getTerm(true);
    w.getTerm({ not: Position });
    expect((worldTerm as any)._shapeConsumers.size).toBe(0);

    w.getTerm({ only: [Position] });
    expect((worldTerm as any)._shapeConsumers.size).toBe(1);
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
    const term = w.getTerm(Position);
    const { enter } = listen(term);
    enter.mockClear();

    const updateCb = vi.fn();
    w.query("test").requires(Position).update(Position, updateCb).build();
    w.start();

    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    tick();
    updateCb.mockClear();
    enter.mockClear();
    e.modified(Position);
    tick();
    expect(updateCb).toHaveBeenCalledWith(e, pos);
    expect(enter).not.toHaveBeenCalled();
  });

  // Ported from query-A-kimi: a belongs() re-evaluation triggered by an
  // unrelated component must not leak into the targeted update channel.
  it("a tree re-evaluation from an unrelated component does not reach update(C)", () => {
    const { w, tick } = setupWithFlush();
    class Unrelated {}
    w.component(Unrelated);
    const cb = vi.fn();
    w.query("not-vel")
      .query({ all: [Position, { not: Velocity }] })
      .update(Position, cb)
      .build();
    w.start();

    const e = w.entity();
    e.add(Position);
    tick();
    cb.mockClear();

    e.add(Unrelated);
    e.modified(Unrelated);
    tick();
    expect(cb).not.toHaveBeenCalled();
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
    const term = w.getTerm({ target: [FriendOf, Position] });
    const { enter, exit } = listen(term);

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
// Phase 5: Consumer-count lifetime
// ---------------------------------------------------------------------------

describe("Term — consumer-count lifetime", () => {
  it("a composite term is destroyed when its last consumer unsubscribes", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, Velocity] });
    const { unsubscribe } = listen(term);
    unsubscribe();
    expect(w.getTerm({ all: [Position, Velocity] })).not.toBe(term);
  });

  it("world-owned leaves persist after their last consumer unsubscribes", () => {
    const w = setup();
    const pos = w.getTerm(Position);
    listen(pos).unsubscribe();
    expect(w.getTerm(Position)).toBe(pos);
  });

  it("destroying a composite cascades unsubscription to unreferenced children", () => {
    const w = setup();
    const inner = w.getTerm({ any: [Velocity, Sprite] });
    const innerHandle = listen(inner);
    const outer = w.getTerm({ all: [Position, { any: [Velocity, Sprite] }] });
    const outerHandle = listen(outer);

    innerHandle.unsubscribe(); // drop our direct handle on the inner composite
    outerHandle.unsubscribe(); // drop outer -> inner now has no consumers

    // World-owned leaf survives; the unreferenced inner composite is rebuilt fresh.
    expect(w.getTerm(Position)).toBe(w.getTerm(Position));
    expect(w.getTerm({ any: [Velocity, Sprite] })).not.toBe(inner);
  });

  it("a second consumer keeps a composite alive after the first unsubscribes", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, Velocity] });
    const a = listen(term);
    const b = listen(term);
    a.unsubscribe();
    expect(w.getTerm({ all: [Position, Velocity] })).toBe(term);
    b.unsubscribe();
  });

  it("destroyed composite term stops receiving propagation", () => {
    const w = setup();
    const term = w.getTerm({ all: [Position, Velocity] });
    const { enter, unsubscribe } = listen(term);
    unsubscribe();

    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    expect(enter).not.toHaveBeenCalled();
  });

  it("a Query retains its composite root; destroying the Query frees it", () => {
    const w = setup();
    const q = w.query("test").requires(Position, Velocity).build();
    const root = q.rootTerm!;
    expect(root).toBeDefined();
    q.destroy();
    expect(w.getTerm({ all: [Position, Velocity] })).not.toBe(root);
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
});

// ---------------------------------------------------------------------------
// Exit snapshots — captured at the query/system layer (positional tuple),
// not on the term event stream.
// ---------------------------------------------------------------------------

describe("Term — exit snapshots are a query/system-layer concern", () => {
  it("Query exit callback receives removed component data as a positional tuple", () => {
    const { w, tick } = setupWithFlush();
    const exit = vi.fn();
    w.query("test").requires(Position).exit([Position], exit).build();
    w.start();

    const e = w.entity();
    const pos = e.set(Position, { x: 42 }).get(Position)!;
    tick();
    e.remove(Position);
    tick();
    expect(exit).toHaveBeenCalledWith(e, [pos]);
  });

  it("Query exit on destroy captures the snapshot before storage deletion", () => {
    const { w, tick } = setupWithFlush();
    const exit = vi.fn();
    w.query("test").requires(Position, Velocity).exit([Position, Velocity], exit).build();
    w.start();

    const e = w.entity();
    const pos = e.set(Position, { x: 1 }).get(Position)!;
    const vel = e.set(Velocity, { vx: 2 }).get(Velocity)!;
    tick();
    e.destroy();
    tick();
    expect(exit).toHaveBeenCalledWith(e, [pos, vel]);
  });

  // Ported from query-A-kimi: the System inbox is the path that genuinely needs
  // a captured snapshot, since exits are replayed after storage is deleted.
  it("System exit callback receives removed component data via the inbox", () => {
    const { w } = setupWithFlush();
    const phase = w.addPhase("exitsys");
    const exit = vi.fn();
    w.system("exitsys-test").phase(phase).requires(Position).exit([Position], exit);
    w.start();

    const e = w.entity();
    const pos = e.set(Position, { x: 7 }).get(Position)!;
    w.progress(0, 0); // enter
    e.remove(Position);
    w.progress(0, 0); // exit replayed from inbox after storage deletion
    expect(exit).toHaveBeenCalledWith(e, [pos]);
  });
});
