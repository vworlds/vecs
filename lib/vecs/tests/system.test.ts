import { describe, it, expect, vi } from "vitest";
import {
  BUILTIN_PIPELINE_PHASES,
  DependsOn,
  ON_LOAD,
  ON_UPDATE,
  Query,
  System,
  World,
  type QueryDSL,
} from "../src/index.js";
import { makePhase } from "./_helpers.js";

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
class Player {}
class Flag {}

function setup() {
  const w = new World();
  w.component(Position);
  w.component(Velocity);
  w.component(Sprite);
  w.component(Container);
  w.component(Player);
  w.component(Flag);
  return { w };
}

describe("System — enter / exit / update", () => {
  it("enter fires when an entity first matches the query", () => {
    const { w } = setup();
    const enter = vi.fn();
    w.system("test").with(Position).enter(enter);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("enter with injection receives a typed tuple", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position, Velocity).enter([Position, Velocity], cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    const vel = e.add(Velocity).get(Velocity)!;
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e, [pos, vel]);
  });

  it("exit fires when an entity stops matching", () => {
    const { w } = setup();
    const exit = vi.fn();
    w.system("test").with(Position).exit(exit);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    e.remove(Position);
    w.progress(0, 0);
    expect(exit.mock.calls[0][0]).toBe(e);
  });

  it("exit injection includes recently-removed components", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).exit([Position], cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    w.progress(0, 0);
    e.remove(Position);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e, [pos]);
  });

  it("update fires on entity.modified(C)", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).update({ watch: Position, enter: true }, cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    w.progress(0, 0); // entity entered
    cb.mockClear();
    e.modified(Position);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e, pos);
  });

  it("update does not fire on entity enter by default", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).update(Position, cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    w.progress(0, 0); // entity entered without enqueueing update
    w.progress(0, 0); // no queued update to drain
    expect(cb).not.toHaveBeenCalled();

    e.modified(Position);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e, pos);
  });

  it("enter delivers an initial update for components already on the entity", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).update({ watch: Position, enter: true }, cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    w.progress(0, 0); // tick 1 enters the entity & queues pos
    w.progress(0, 0); // tick 2 drains the queue
    expect(cb).toHaveBeenCalledWith(e, pos);
  });

  it("update with injection delivers extra components", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test")
      .with(Position, Velocity)
      .update({ watch: Velocity, enter: true, inject: [Position] }, cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    const vel = e.add(Velocity).get(Velocity)!;
    w.progress(0, 0);
    cb.mockClear();
    e.modified(Velocity);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e, vel, [pos]);
  });

  it("update without an explicit query requires its component", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").update({ watch: Position, enter: true }, cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    w.progress(0, 0); // enter
    w.progress(0, 0); // drain
    expect(cb).toHaveBeenCalledWith(e, pos);

    const f = w.entity();
    f.add(Velocity);
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("run fires every tick regardless of entity state", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").run(cb);
    w.progress(100, 16);
    w.progress(116, 16);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith(116, 16);
  });

  it("run returns the system for chaining", () => {
    const { w } = setup();
    const sys = w.system("test");
    expect(sys.run(() => {})).toBe(sys);
  });

  it("toString returns the system name", () => {
    const { w } = setup();
    const sys = w.system("Move");
    expect(sys.toString()).toBe("Move");
  });

  it("destroyed entity also fires exit", () => {
    const { w } = setup();
    const exit = vi.fn();
    w.system("test").with(Position).exit(exit);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    e.destroy();
    w.progress(0, 0);
    expect(exit.mock.calls[0][0]).toBe(e);
  });

  it("exit injection includes the component instance when the entity is destroyed", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).exit([Position], cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    w.progress(0, 0);
    e.destroy();
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e, [pos]);
  });

  it("sets changed when an entity enters the system", () => {
    const { w } = setup();
    const sys = w.system("test").with(Position).track();

    expect(sys.changed).toBe(false);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);

    expect(sys.changed).toBe(true);
  });

  it("sets changed when a watched component is modified", () => {
    const { w } = setup();
    const sys = w
      .system("test")
      .with(Position)
      .update({ watch: Position, enter: true }, () => {});
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    sys.changed = false;

    e.modified(Position);
    w.progress(0, 0);

    expect(sys.changed).toBe(true);
  });

  it("each does not consume the changed flag", () => {
    const { w } = setup();
    const sys = w
      .system("test")
      .with(Position)
      .each([Position], () => {});

    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);

    // The entity entered this tick. `each` iterated the system on the same
    // tick, but iterating for `each` must not reset `changed` the way a manual
    // `forEach` does.
    expect(sys.changed).toBe(true);
  });
});

describe("System — pipeline", () => {
  it("does not register world.system() until _build()", () => {
    const { w } = setup();
    const sys = w.system("test").run(() => {});
    expect(w.queries).not.toContain(sys);
    sys._build();
    expect(w.queries).toContain(sys);
  });

  it("throws when configuring a built system", () => {
    const { w } = setup();
    const sys = w
      .system("test")
      .run(() => {})
      .with(Position)
      ._build();
    expect(() => sys.run(() => {})).toThrow();
    expect(() => sys.each([Position], () => {})).toThrow();
    expect(() => sys.with(Velocity)).toThrow();
  });

  it("auto-builds systems when progress builds the pipeline", () => {
    const { w } = setup();
    const cb = vi.fn();
    const sys = w.system("test").run(cb);
    expect(w.queries).not.toContain(sys);
    w.progress(0, 0);
    expect(w.queries).toContain(sys);
    expect(cb).toHaveBeenCalled();
  });

  it("inserts systems created after a frame on the next progress", () => {
    const { w } = setup();
    const early = vi.fn();
    const late = vi.fn();

    w.system("early").run(early);
    w.progress(0, 0);
    w.system("late").run(late);

    expect(late).not.toHaveBeenCalled();
    w.progress(1, 0);

    expect(early).toHaveBeenCalledTimes(2);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("rejects query builds while a frame is in progress", () => {
    const { w } = setup();
    w.system("test").run(() => {
      expect(() => w.query("mid-frame").with(Position)._build()).toThrow(
        "queries cannot be built while a frame is in progress"
      );
    });
    w.progress(0, 0);
  });

  it("auto-builds queries created by an earlier system before the next system runs", () => {
    const { w } = setup();
    const e = w.entity();
    e.add(Flag);
    let dynamicQuery: ReturnType<World["query"]> | undefined;

    w.system("create query").run(() => {
      dynamicQuery = w.query("dynamic").with(Flag);
    });
    w.system("read query").run(() => {
      expect(dynamicQuery?.built).toBe(true);
      expect(dynamicQuery?.count).toBe(1);
      expect(dynamicQuery?.has(e)).toBe(true);
    });
    w.progress(0, 0);
  });

  it("build() inside a system defers until before the next system runs", () => {
    const { w } = setup();
    const e = w.entity();
    e.add(Flag);
    let dynamicQuery: ReturnType<World["query"]> | undefined;

    w.system("create query").run(() => {
      dynamicQuery = w.query("dynamic").with(Flag).build();
      expect(dynamicQuery.built).toBe(false);
    });
    w.system("read query").run(() => {
      expect(dynamicQuery?.built).toBe(true);
      expect(dynamicQuery?.count).toBe(1);
      expect(dynamicQuery?.has(e)).toBe(true);
    });
    w.progress(0, 0);
  });

  it("build() inside a system observes commands queued by that system", () => {
    const { w } = setup();
    const e = w.entity();
    const enter = vi.fn();
    let dynamicQuery: ReturnType<World["query"]> | undefined;

    w.system("create query and mutation").run(() => {
      dynamicQuery = w.query("dynamic").with(Flag).enter(enter).build();
      e.add(Flag);
      expect(dynamicQuery.built).toBe(false);
      expect(dynamicQuery.has(e)).toBe(false);
    });
    w.system("read query").run(() => {
      expect(dynamicQuery?.built).toBe(true);
      expect(dynamicQuery?.has(e)).toBe(true);
      expect(enter).toHaveBeenCalledWith(e);
    });
    w.progress(0, 0);
  });

  it("propagates pending query build errors before the next system runs", () => {
    const { w } = setup();
    const nextSystem = vi.fn();

    w.system("create broken query").run(() => {
      w.query("broken").with({ BROKEN: [] } as unknown as QueryDSL);
    });
    w.system("must not run").run(nextSystem);
    expect(() => w.progress(0, 0)).toThrow("Unrecognized query term");
    expect(nextSystem).not.toHaveBeenCalled();
  });

  it("orders systems by phase dependency depth", () => {
    const w = new World();
    const seen: string[] = [];
    const a = makePhase(w, "a");
    const b = makePhase(w, "b", a);
    w.system("sysA")
      .phase(a)
      .run(() => seen.push("A"));
    w.system("sysB")
      .phase(b)
      .run(() => seen.push("B"));
    w.progress(0, 0);
    expect(seen).toEqual(["A", "B"]);
  });

  it("systems default to the built-in OnUpdate phase", () => {
    const w = new World();
    const cb = vi.fn();
    w.system("test").run(cb);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalled();
  });

  it("runs systems across the full built-in phase chain in dependency order", () => {
    const w = new World();
    const seen: string[] = [];
    // Register in shuffled order to prove ordering comes from DependsOn, not creation.
    for (const name of [...BUILTIN_PIPELINE_PHASES].reverse()) {
      w.system(`sys:${name}`)
        .phase(name)
        .run(() => seen.push(name));
    }
    w.progress(0, 0);
    expect(seen).toEqual([...BUILTIN_PIPELINE_PHASES]);
  });

  it("orders systems within the same phase by creation order", () => {
    const w = new World();
    const seen: string[] = [];
    w.system("first").run(() => seen.push("first"));
    w.system("second").run(() => seen.push("second"));
    w.system("third").run(() => seen.push("third"));
    w.progress(0, 0);
    expect(seen).toEqual(["first", "second", "third"]);
  });

  it(".phase() retargets the default OnUpdate dependency rather than adding a second", () => {
    const w = new World();
    const sys = w
      .system("s")
      .phase(ON_LOAD)
      .run(() => {});
    // DependsOn is single-target, so the OnUpdate set by the constructor is replaced.
    expect(sys.entity.target(DependsOn)).toBe(w.entity(ON_LOAD));
    expect(sys.entity.target(DependsOn)).not.toBe(w.entity(ON_UPDATE));
  });
});

describe("System — query interaction with update watchlist", () => {
  it("with() merges with any prior update predicate", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test")
      .update({ watch: Position, enter: true }, () => {})
      .with(Velocity)
      .enter(cb);

    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    expect(cb).not.toHaveBeenCalled();

    e.add(Velocity);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e);
  });
});

describe("System — each", () => {
  it("each fires every tick for a tracked entity", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).each([Position], cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    w.progress(0, 0); // entry happens after run() in updateArchetypes
    w.progress(0, 0); // first each
    expect(cb).toHaveBeenCalledWith(e, [pos]);
  });

  it("each fires across multiple ticks", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).each([Position], cb);
    const e = w.entity();
    e.add(Position);
    // Top-level mutations execute inline, so the entity is already tracked by
    // the system before the first progress(). each fires once per tick from
    // the first progress() onward.
    w.progress(0, 0);
    w.progress(0, 0);
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it("each fires for every matching entity in one tick", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).each([Position], cb);
    const a = w.entity();
    const posA = a.add(Position).get(Position)!;
    const b = w.entity();
    const posB = b.add(Position).get(Position)!;
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(a, [posA]);
    expect(cb).toHaveBeenCalledWith(b, [posB]);
    expect(cb).toHaveBeenCalledTimes(4); // 2 entities × 2 ticks
  });

  it("each is not called for entities that don't match the system query", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).each([Position], cb);
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Velocity);
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledTimes(2); // only a, twice
    expect(cb).toHaveBeenCalledWith(a, [a.get(Position)]);
  });

  it("missing components on a tracked entity are passed as undefined", () => {
    const { w } = setup();
    const cb = vi.fn();
    // Entity matches via Position only, but each also asks for Velocity:
    w.system("test").with(Position).each([Position, Velocity], cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e, [pos, undefined]);
  });

  it("each stops firing after entity component is removed", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).each([Position], cb);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    w.progress(0, 0);
    e.remove(Position);
    // Entity exits during updateArchetypes after run() in the next tick.
    w.progress(0, 0);
    w.progress(0, 0);
    const callsBefore = cb.mock.calls.length;
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledTimes(callsBefore);
  });

  it("each stops firing after entity is destroyed", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).each([Position], cb);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    w.progress(0, 0);
    e.destroy();
    w.progress(0, 0);
    const countAfterDestroy = cb.mock.calls.length;
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledTimes(countAfterDestroy);
  });

  it("each with multiple components delivers the resolved tuple", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position, Velocity).each([Position, Velocity], cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    const vel = e.add(Velocity).get(Velocity)!;
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e, [pos, vel]);
  });

  it("each accepts injection options", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test")
      .with(Position, Velocity)
      .each({ inject: [Position, Velocity] }, cb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    const vel = e.add(Velocity).get(Velocity)!;
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e, [pos, vel]);
  });

  it("each does NOT modify the system query — without with/query no entity matches", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").each([Position], cb);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).not.toHaveBeenCalled();
  });

  it("each with empty component list still fires per entity", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).each([], cb);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e, []);
  });

  it("each returns the system for chaining", () => {
    const { w } = setup();
    const sys = w.system("test");
    expect(sys.each([Position], () => {})).toBe(sys);
  });

  it("each throws if registered twice on the same system", () => {
    const { w } = setup();
    const sys = w.system("test");
    sys.each([Position], () => {});
    expect(() => sys.each([Velocity], () => {})).toThrow();
  });

  it("entities are only tracked when track or each is registered", () => {
    const { w } = setup();
    const sys = w.system("test").with(Position);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    expect(sys.count).toBe(0);
  });

  it("track() populates entities on enter and clears them on exit", () => {
    const { w } = setup();
    const sys = w.system("test").with(Position).track();
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    expect(sys.count).toBe(1);
    expect(sys.has(e)).toBe(true);
    e.remove(Position);
    w.progress(0, 0);
    expect(sys.count).toBe(0);
  });

  it("track() returns the system and is idempotent", () => {
    const { w } = setup();
    const sys = w.system("test").with(Position);
    expect(sys.track()).toBe(sys);
    expect(sys.track().track()).toBe(sys);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    expect(sys.count).toBe(1);
  });

  it("each() implies track() without an explicit track call", () => {
    const { w } = setup();
    const sys = w
      .system("test")
      .with(Position)
      .each([Position], () => {});
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    expect(sys.has(e)).toBe(true);
  });

  it("each and update coexist on the same system", () => {
    const { w } = setup();
    const eachCb = vi.fn();
    const updateCb = vi.fn();
    w.system("test")
      .with(Position)
      .each([Position], eachCb)
      .update({ watch: Position, enter: true }, updateCb);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    w.progress(0, 0); // entry queues pos for update
    w.progress(0, 0); // both fire
    expect(eachCb).toHaveBeenCalledWith(e, [pos]);
    expect(updateCb).toHaveBeenCalledWith(e, pos);
    eachCb.mockClear();
    updateCb.mockClear();

    // Without modified(): each fires, update does not.
    w.progress(0, 0);
    expect(eachCb).toHaveBeenCalled();
    expect(updateCb).not.toHaveBeenCalled();
  });
});

describe("System — orderBy", () => {
  it("orderBy() returns this for chaining", () => {
    const { w } = setup();
    const sys = w.system("test").with(Position);
    expect(sys.orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x)).toBe(sys);
  });

  it("orderBy() implies track()", () => {
    const { w } = setup();
    const sys = w
      .system("test")
      .with(Position)
      .orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x);
    const e = w.entity();
    e.set(Position, { x: 5 });
    w.progress(0, 0);
    expect(sys.has(e)).toBe(true);
  });

  it("entities in a sorted system are iterated in sorted order", () => {
    const { w } = setup();
    const sys = w
      .system("test")
      .with(Position)
      .orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x);

    const e1 = w.entity();
    e1.set(Position, { x: 30 });

    const e2 = w.entity();
    e2.set(Position, { x: 10 });

    const e3 = w.entity();
    e3.set(Position, { x: 20 });

    w.progress(0, 0);

    expect([...sys]).toEqual([e2, e3, e1]);
  });

  it("each() visits entities in sorted order", () => {
    const { w } = setup();
    const visited: number[] = [];
    w.system("test")
      .with(Position)
      .orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x)
      .each([Position], (_e, [pos]) => visited.push(pos.x));

    const e1 = w.entity();
    e1.set(Position, { x: 30 });

    const e2 = w.entity();
    e2.set(Position, { x: 10 });

    const e3 = w.entity();
    e3.set(Position, { x: 20 });

    // Entities are tracked from setup (top-level inline). each fires every
    // tick the system runs.
    w.progress(0, 0);

    expect(visited).toEqual([10, 20, 30]);
  });

  it("a position change from an earlier tick reorders the next each() pass", () => {
    const { w } = setup();
    let visited: number[] = [];
    w.system("test")
      .with(Position)
      .orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x)
      .each([Position], (_e, [pos]) => visited.push(pos.x));

    const e1 = w.entity();
    e1.set(Position, { x: 1 });

    const e2 = w.entity();
    e2.set(Position, { x: 2 });

    const e3 = w.entity();
    e3.set(Position, { x: 3 });

    w.progress(0, 0);
    expect(visited).toEqual([1, 2, 3]);

    // Change e1's sort key after the tick that visited it; the next run
    // must reflect the new order even though no tick ran in between the
    // write and the next progress.
    e1.set(Position, { x: 99 });

    visited = [];
    w.progress(0, 0);

    expect(visited).toEqual([2, 3, 99]);
  });

  it("exiting entity is removed from the sorted set", () => {
    const { w } = setup();
    const sys = w
      .system("test")
      .with(Position)
      .orderBy([Position], (_eA, [a], _eB, [b]) => a.x - b.x);

    const e1 = w.entity();
    e1.set(Position, { x: 10 });

    const e2 = w.entity();
    e2.set(Position, { x: 20 });

    w.progress(0, 0);
    expect([...sys]).toEqual([e1, e2]);

    e1.remove(Position);
    w.progress(0, 0);
    expect([...sys]).toEqual([e2]);
  });

  it("orderBy with multiple components passes tuples to compare", () => {
    const { w } = setup();
    const sys = w
      .system("test")
      .with(Position, Velocity)
      .orderBy(
        [Position, Velocity],
        (_eA, [posA, velA], _eB, [posB, velB]) => posA.x + velA.vx - (posB.x + velB.vx)
      );

    const e1 = w.entity();
    e1.set(Position, { x: 10 });
    e1.set(Velocity, { vx: 5 }); // sum = 15

    const e2 = w.entity();
    e2.set(Position, { x: 1 });
    e2.set(Velocity, { vx: 1 }); // sum = 2

    const e3 = w.entity();
    e3.set(Position, { x: 5 });
    e3.set(Velocity, { vx: 5 }); // sum = 10

    w.progress(0, 0);
    expect([...sys]).toEqual([e2, e3, e1]);
  });
});

describe("System — destroy", () => {
  it("destroy() removes the system and destroys its backing entity", () => {
    const { w } = setup();
    const sys = w.system("test").with(Position);
    const entity = sys.entity;
    sys.destroy();

    expect(w.queries).not.toContain(sys);
    expect(entity._destroyed).toBe(true);
    expect(w.getEntity(entity.eid)).toBeUndefined();
  });

  it("stores systems as both query and system components", () => {
    const { w } = setup();
    const sys = w.system("stored-system");

    expect(sys.entity.get(Query)).toBe(sys);
    expect(sys.entity.get(System)).toBe(sys);
  });

  it("can query system entities", () => {
    const { w } = setup();
    const sys = w.system("queried-system");
    const systems = w.query("systems").with(Query, System).build();

    expect(systems.has(sys.entity)).toBe(true);
  });
});

describe("System — enable / disable", () => {
  it("disable() stops run callback from firing", () => {
    const { w } = setup();
    const cb = vi.fn();
    const sys = w.system("test").run(cb);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledTimes(1);
    sys.disable();
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("enable() resumes the run callback", () => {
    const { w } = setup();
    const cb = vi.fn();
    const sys = w.system("test").run(cb);
    sys.disable();
    w.progress(0, 0);
    expect(cb).not.toHaveBeenCalled();
    sys.enable();
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("disable() stops each callback from firing", () => {
    const { w } = setup();
    const cb = vi.fn();
    const sys = w.system("test").with(Position).each([Position], cb);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).toHaveBeenCalled();
    cb.mockClear();
    sys.disable();
    w.progress(0, 0);
    w.progress(0, 0);
    expect(cb).not.toHaveBeenCalled();
  });

  it("disable() stops enter callback from firing", () => {
    const { w } = setup();
    const enter = vi.fn();
    const sys = w.system("test").with(Position).enter(enter);
    sys.disable();
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    expect(enter).not.toHaveBeenCalled();
  });

  it("disable() stops exit callback from firing", () => {
    const { w } = setup();
    const exit = vi.fn();
    const sys = w.system("test").with(Position).exit(exit);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    sys.disable();
    e.remove(Position);
    w.progress(0, 0);
    expect(exit).not.toHaveBeenCalled();
  });

  it("disable() stops update callback from firing", () => {
    const { w } = setup();
    const cb = vi.fn();
    const sys = w.system("test").with(Position).update({ watch: Position, enter: true }, cb);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    w.progress(0, 0); // drain initial update
    cb.mockClear();
    sys.disable();
    e.modified(Position);
    w.progress(0, 0);
    expect(cb).not.toHaveBeenCalled();
  });

  it("disable() clears any pending inbox events", () => {
    const { w } = setup();
    const enter = vi.fn();
    const sys = w.system("test").with(Position).enter(enter);
    const e = w.entity();
    e.add(Position); // queues enter event before progress()
    sys.disable(); // should clear the inbox
    w.progress(0, 0);
    expect(enter).not.toHaveBeenCalled();
  });

  it("entity membership is maintained while disabled", () => {
    const { w } = setup();
    const sys = w.system("test").with(Position).track();
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    expect(sys.has(e)).toBe(true);
    sys.disable();
    const f = w.entity();
    f.add(Position);
    w.progress(0, 0);
    expect(sys.has(e)).toBe(true);
    expect(sys.has(f)).toBe(true);
  });

  it("entity exits are reflected in the tracked set while disabled", () => {
    const { w } = setup();
    const sys = w.system("test").with(Position).track();
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    sys.disable();
    e.remove(Position);
    w.progress(0, 0);
    expect(sys.has(e)).toBe(false);
  });

  it("enable() and disable() return this for chaining", () => {
    const { w } = setup();
    const sys = w.system("test");
    expect(sys.disable()).toBe(sys);
    expect(sys.enable()).toBe(sys);
  });

  it("disable() is idempotent", () => {
    const { w } = setup();
    const cb = vi.fn();
    const sys = w.system("test").run(cb);
    sys.disable();
    sys.disable();
    w.progress(0, 0);
    expect(cb).not.toHaveBeenCalled();
  });

  it("enable() is idempotent", () => {
    const { w } = setup();
    const cb = vi.fn();
    const sys = w.system("test").run(cb);
    sys.enable();
    sys.enable();
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("each resumes firing after re-enable", () => {
    const { w } = setup();
    const cb = vi.fn();
    const sys = w.system("test").with(Position).each([Position], cb);
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    sys.disable();
    w.progress(0, 0);
    cb.mockClear();
    sys.enable();
    w.progress(0, 0);
    expect(cb).toHaveBeenCalledWith(e, [e.get(Position)]);
  });

  it("events while disabled are not replayed on re-enable", () => {
    const { w } = setup();
    const enter = vi.fn();
    const sys = w.system("test").with(Position).enter(enter);
    sys.disable();
    const e = w.entity();
    e.add(Position);
    w.progress(0, 0);
    sys.enable();
    w.progress(0, 0);
    expect(enter).not.toHaveBeenCalled();
  });
});

describe("System — stale inbox update after same-frame exit", () => {
  // Regression for the phaser.sync.position crash:
  //   world.system("phaser.sync.position")
  //     .with(Position, Transform)
  //     .update({ watch: Position, enter: true, inject: [Transform] }, (_e, p, [obj]) => obj.setPosition(...))
  // A Position update queued in the inbox must not dispatch once the entity has
  // left the query before the inbox drains. The `.with` read (here `Sprite`,
  // standing in for the live Phaser GameObject) is resolved lazily at dispatch
  // and would otherwise come back `undefined`, crashing the callback.

  it("does not dispatch a queued update after the entity is destroyed the same frame", () => {
    const { w } = setup();
    const seen: Array<Sprite | undefined> = [];
    w.system("test")
      .with(Position, Sprite)
      .update({ watch: Position, enter: true, inject: [Sprite] }, (_e, _p, [obj]) =>
        seen.push(obj)
      );

    const e = w.entity().add(Position).add(Sprite);
    w.progress(0, 0); // entry-time update fires cleanly (Sprite present)
    seen.length = 0;

    // Same frame: queue a Position update, then destroy the entity (clears its
    // components and query membership) before the inbox drains.
    e.set(Position, { x: 5, y: 5 });
    e.destroy();
    w.progress(1, 1);

    expect(seen).toEqual([]); // stale update skipped, no `undefined` Sprite
  });

  it("does not dispatch a queued update after the entity loses a .with component the same frame", () => {
    const { w } = setup();
    const seen: Array<Sprite | undefined> = [];
    w.system("test")
      .with(Position, Sprite)
      .update({ watch: Position, enter: true, inject: [Sprite] }, (_e, _p, [obj]) =>
        seen.push(obj)
      );

    const e = w.entity().add(Position).add(Sprite);
    w.progress(0, 0);
    seen.length = 0;

    e.set(Position, { x: 5, y: 5 });
    e.remove(Sprite); // entity stays alive but exits the query
    w.progress(1, 1);

    expect(seen).toEqual([]);
  });

  it("still dispatches when the entity exits and re-enters the same frame (came back)", () => {
    const { w } = setup();
    const seen: Array<Sprite | undefined> = [];
    w.system("test")
      .with(Position, Sprite)
      .update({ watch: Position, enter: true, inject: [Sprite] }, (_e, _p, [obj]) =>
        seen.push(obj)
      );

    const e = w.entity().add(Position).add(Sprite);
    w.progress(0, 0);
    seen.length = 0;

    // Queue an update, exit, then re-enter before the drain. The entity is a
    // member again at dispatch time, so the update must still fire — with the
    // re-added Sprite resolved, never `undefined`.
    e.set(Position, { x: 5, y: 5 });
    e.remove(Sprite);
    e.add(Sprite);
    w.progress(1, 1);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(undefined);
  });
});

describe("System — inbox enter survives same-frame exit", () => {
  // Companion to the exit-snapshot behaviour above. An injected Enter queued on
  // the inbox must still resolve its components if the entity is destroyed (or
  // loses a `.with` component) before the inbox drains — otherwise the lazy
  // `.with` read comes back `undefined` and crashes the callback. Enter snapshots
  // its injected components at routing time, exactly like exit, so enter/exit
  // replay in arrival order and stay balanced.

  it("resolves the snapshotted component when the entity is destroyed before the drain", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).enter([Position], cb);
    w.progress(0, 0); // build the system (no entities yet)

    const e = w.entity();
    const pos = e.add(Position).get(Position)!; // built system → enter queued on the inbox
    e.destroy(); // queues the exit; entity is gone before the inbox drains
    expect(() => w.progress(0, 0)).not.toThrow(); // no "query does not contain component"
    expect(cb).toHaveBeenCalledWith(e, [pos]); // enter still resolves via the snapshot
  });

  it("resolves the snapshotted component when the entity loses a .with component before the drain", () => {
    const { w } = setup();
    const cb = vi.fn();
    w.system("test").with(Position).enter([Position], cb);
    w.progress(0, 0); // build the system

    const e = w.entity();
    const pos = e.add(Position).get(Position)!; // enter queued on the inbox
    e.remove(Position); // exits the query before the drain (entity stays alive)
    expect(() => w.progress(0, 0)).not.toThrow();
    expect(cb).toHaveBeenCalledWith(e, [pos]);
  });

  it("keeps enter/exit balanced for an entity that enters and is destroyed before the drain", () => {
    const { w } = setup();
    let balance = 0;
    w.system("test")
      .with(Position)
      .enter([Position], () => {
        balance += 1;
      })
      .exit([Position], () => {
        balance -= 1;
      });
    w.progress(0, 0); // build the system

    w.entity().add(Position); // survives → enter only (+1)
    w.entity().add(Position).destroy(); // transient → enter (+1) then exit (-1)
    w.progress(0, 0);

    expect(balance).toBe(1);
  });
});
