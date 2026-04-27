import { describe, it, expect, vi } from "vitest";
import { World, Component } from "../src/index.js";

class Position extends Component {
  x = 0;
  y = 0;
}
class Velocity extends Component {
  vx = 0;
  vy = 0;
}
class Sprite extends Component {}
class Container extends Component {}
class Player extends Component {}

function setup() {
  const w = new World();
  w.registerComponent(Position);
  w.registerComponent(Velocity);
  w.registerComponent(Sprite);
  w.registerComponent(Container);
  w.registerComponent(Player);
  const phase = w.addPhase("p");
  return { w, phase };
}

describe("System — enter / exit / update", () => {
  it("enter fires when an entity first matches the query", () => {
    const { w, phase } = setup();
    const enter = vi.fn();
    w.system("test").phase(phase).requires(Position).enter(enter);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("enter with injection receives a typed tuple", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test")
      .phase(phase)
      .requires(Position, Velocity)
      .enter([Position, Velocity], cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position);
    const vel = e.add(Velocity);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(e, [pos, vel]);
  });

  it("exit fires when an entity stops matching", () => {
    const { w, phase } = setup();
    const exit = vi.fn();
    w.system("test").phase(phase).requires(Position).exit(exit);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    e.remove(Position);
    w.runPhase(phase, 0, 0);
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("exit injection includes recently-removed components", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).exit([Position], cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position);
    w.runPhase(phase, 0, 0);
    e.remove(Position);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(e, [pos]);
  });

  it("update fires on component.modified()", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).update(Position, cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position, false);
    w.runPhase(phase, 0, 0); // entity entered
    cb.mockClear();
    pos.modified();
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(pos);
  });

  it("enter delivers an initial update for components already on the entity", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).update(Position, cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position);
    w.runPhase(phase, 0, 0); // tick 1 enters the entity & queues pos
    w.runPhase(phase, 0, 0); // tick 2 drains the queue
    expect(cb).toHaveBeenCalledWith(pos);
  });

  it("update with injection delivers extra components", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test")
      .phase(phase)
      .requires(Position, Velocity)
      .update(Velocity, [Position], cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position);
    const vel = e.add(Velocity, false);
    w.runPhase(phase, 0, 0);
    cb.mockClear();
    vel.modified();
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(vel, [pos]);
  });

  it("update without an explicit query implicitly requires its component", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).update(Position, cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position);
    w.runPhase(phase, 0, 0); // enter
    w.runPhase(phase, 0, 0); // drain
    expect(cb).toHaveBeenCalledWith(pos);

    // Entity without Position must not match.
    const f = w.createEntity();
    f.add(Velocity);
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("run fires every tick regardless of entity state", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).run(cb);
    w.start();
    w.runPhase(phase, 100, 16);
    w.runPhase(phase, 116, 16);
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
    const { w, phase } = setup();
    const exit = vi.fn();
    w.system("test").phase(phase).requires(Position).exit(exit);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    e.destroy();
    w.runPhase(phase, 0, 0);
    expect(exit).toHaveBeenCalledWith(e);
  });
});

describe("System — phases", () => {
  it("phase by IPhase reference assigns the system to that phase", () => {
    const w = new World();
    const seen: string[] = [];
    const a = w.addPhase("a");
    const b = w.addPhase("b");
    w.system("sysA").phase(a).run(() => seen.push("A"));
    w.system("sysB").phase(b).run(() => seen.push("B"));
    w.start();
    w.runPhase(b, 0, 0);
    w.runPhase(a, 0, 0);
    expect(seen).toEqual(["B", "A"]);
  });

  it("phase by name resolves at start() time", () => {
    const w = new World();
    const cb = vi.fn();
    w.addPhase("custom");
    w.system("test").phase("custom").run(cb);
    w.start();
    const custom = [...w["pipeline"].values()].find((p) => p.name === "custom")!;
    w.runPhase(custom, 0, 0);
    expect(cb).toHaveBeenCalled();
  });

  it("systems without a phase land in the built-in 'update' phase", () => {
    const w = new World();
    const cb = vi.fn();
    w.system("test").run(cb);
    w.start();
    const update = [...w["pipeline"].values()].find((p) => p.name === "update")!;
    w.runPhase(update, 0, 0);
    expect(cb).toHaveBeenCalled();
  });

  it("phase rejects a Phase from another world", () => {
    const w = new World();
    const other = new World();
    const otherPhase = other.addPhase("x");
    expect(() => w.system("test").phase(otherPhase)).toThrow();
  });

  it("phase rejects a non-Phase object", () => {
    const w = new World();
    expect(() =>
      w.system("test").phase({ name: "fake", world: w } as any)
    ).toThrow();
  });
});


describe("System — query interaction with update watchlist", () => {
  it("query() overrides any prior implicit watchlist query", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    // update would normally add Position to the implicit query;
    // a subsequent query() should fully replace it.
    w.system("test")
      .phase(phase)
      .update(Position, () => {})
      .query(Velocity)
      .enter(cb);
    w.start();

    const e = w.createEntity();
    e.add(Position); // would have matched the implicit query
    w.runPhase(phase, 0, 0);
    expect(cb).not.toHaveBeenCalled();

    e.add(Velocity);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(e);
  });
});

describe("System — each", () => {
  it("each fires every tick for a tracked entity", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).each([Position], cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position);
    w.runPhase(phase, 0, 0); // entry happens after run() in updateArchetypes
    w.runPhase(phase, 0, 0); // first each
    expect(cb).toHaveBeenCalledWith(e, [pos]);
  });

  it("each fires across multiple ticks", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).each([Position], cb);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("each fires for every matching entity in one tick", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).each([Position], cb);
    w.start();
    const a = w.createEntity();
    const posA = a.add(Position);
    const b = w.createEntity();
    const posB = b.add(Position);
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(a, [posA]);
    expect(cb).toHaveBeenCalledWith(b, [posB]);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("each is not called for entities that don't match the system query", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).each([Position], cb);
    w.start();
    const a = w.createEntity();
    a.add(Position);
    const b = w.createEntity();
    b.add(Velocity);
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(a, [a.get(Position)]);
  });

  it("missing components on a tracked entity are passed as undefined", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    // Entity matches via Position only, but each also asks for Velocity:
    w.system("test")
      .phase(phase)
      .requires(Position)
      .each([Position, Velocity], cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position);
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(e, [pos, undefined]);
  });

  it("each stops firing after entity component is removed", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).each([Position], cb);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
    e.remove(Position);
    // Entity exits during updateArchetypes after run() in the next tick.
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
    const callsBefore = cb.mock.calls.length;
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledTimes(callsBefore);
  });

  it("each stops firing after entity is destroyed", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).each([Position], cb);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
    e.destroy();
    w.runPhase(phase, 0, 0);
    const countAfterDestroy = cb.mock.calls.length;
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledTimes(countAfterDestroy);
  });

  it("each with multiple components delivers the resolved tuple", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test")
      .phase(phase)
      .requires(Position, Velocity)
      .each([Position, Velocity], cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position);
    const vel = e.add(Velocity);
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(e, [pos, vel]);
  });

  it("each does NOT modify the system query — without requires/query no entity matches", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).each([Position], cb);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
    expect(cb).not.toHaveBeenCalled();
  });

  it("each with empty component list still fires per entity", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).each([], cb);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    w.runPhase(phase, 0, 0);
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
    const { w, phase } = setup();
    const sys = w.system("test").phase(phase).requires(Position);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    expect(sys.entities.size).toBe(0);
  });

  it("track() populates entities on enter and clears them on exit", () => {
    const { w, phase } = setup();
    const sys = w.system("test").phase(phase).requires(Position).track();
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    expect(sys.entities.size).toBe(1);
    expect(sys.entities.has(e)).toBe(true);
    e.remove(Position);
    w.runPhase(phase, 0, 0);
    expect(sys.entities.size).toBe(0);
  });

  it("track() returns the system and is idempotent", () => {
    const { w, phase } = setup();
    const sys = w.system("test").phase(phase).requires(Position);
    expect(sys.track()).toBe(sys);
    expect(sys.track().track()).toBe(sys);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    expect(sys.entities.size).toBe(1);
  });

  it("each() implies track() — entities is populated without an explicit track call", () => {
    const { w, phase } = setup();
    const sys = w.system("test")
      .phase(phase)
      .requires(Position)
      .each([Position], () => {});
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    expect(sys.entities.has(e)).toBe(true);
  });

  it("system.entities is typed as a ReadonlySet", () => {
    const { w } = setup();
    const sys = w.system("test").requires(Position).track();
    const fakeEntity = {} as any;
    // @ts-expect-error entities is a ReadonlySet — add() is not exposed
    sys.entities.add(fakeEntity);
    // @ts-expect-error entities is a ReadonlySet — delete() is not exposed
    sys.entities.delete(fakeEntity);
  });

  it("each and update coexist on the same system", () => {
    const { w, phase } = setup();
    const eachCb = vi.fn();
    const updateCb = vi.fn();
    w.system("test")
      .phase(phase)
      .requires(Position)
      .each([Position], eachCb)
      .update(Position, updateCb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position, false);
    w.runPhase(phase, 0, 0); // entry queues pos for update
    w.runPhase(phase, 0, 0); // both fire
    expect(eachCb).toHaveBeenCalledWith(e, [pos]);
    expect(updateCb).toHaveBeenCalledWith(pos);
    eachCb.mockClear();
    updateCb.mockClear();

    // Without modified(): each fires, update does not.
    w.runPhase(phase, 0, 0);
    expect(eachCb).toHaveBeenCalled();
    expect(updateCb).not.toHaveBeenCalled();
  });
});

describe("System — sort", () => {
  it("sort() returns this for chaining", () => {
    const { w } = setup();
    const sys = w.system("test").requires(Position);
    expect(sys.sort([Position], ([a], [b]) => a.x - b.x)).toBe(sys);
  });

  it("sort() implies track()", () => {
    const { w, phase } = setup();
    const sys = w
      .system("test")
      .phase(phase)
      .requires(Position)
      .sort([Position], ([a], [b]) => a.x - b.x);
    w.start();
    const e = w.createEntity();
    e.set(Position, { x: 5 });
    w.runPhase(phase, 0, 0);
    expect(sys.entities.has(e)).toBe(true);
  });

  it("entities are iterated in sorted order", () => {
    const { w, phase } = setup();
    const sys = w
      .system("test")
      .phase(phase)
      .requires(Position)
      .sort([Position], ([a], [b]) => a.x - b.x);
    w.start();

    const e1 = w.createEntity();
    const p1 = e1.add(Position, false);
    p1.x = 30;

    const e2 = w.createEntity();
    const p2 = e2.add(Position, false);
    p2.x = 10;

    const e3 = w.createEntity();
    const p3 = e3.add(Position, false);
    p3.x = 20;

    w.runPhase(phase, 0, 0);

    expect([...sys.entities]).toEqual([e2, e3, e1]);
  });

  it("each() visits entities in sorted order", () => {
    const { w, phase } = setup();
    const visited: number[] = [];
    w.system("test")
      .phase(phase)
      .requires(Position)
      .sort([Position], ([a], [b]) => a.x - b.x)
      .each([Position], (_e, [pos]) => visited.push(pos.x));
    w.start();

    const e1 = w.createEntity();
    const p1 = e1.add(Position, false);
    p1.x = 30;

    const e2 = w.createEntity();
    const p2 = e2.add(Position, false);
    p2.x = 10;

    const e3 = w.createEntity();
    const p3 = e3.add(Position, false);
    p3.x = 20;

    w.runPhase(phase, 0, 0); // enter
    w.runPhase(phase, 0, 0); // each fires

    expect(visited).toEqual([10, 20, 30]);
  });

  it("exiting entity is removed from the sorted set", () => {
    const { w, phase } = setup();
    const sys = w
      .system("test")
      .phase(phase)
      .requires(Position)
      .sort([Position], ([a], [b]) => a.x - b.x);
    w.start();

    const e1 = w.createEntity();
    const p1 = e1.add(Position, false);
    p1.x = 10;

    const e2 = w.createEntity();
    const p2 = e2.add(Position, false);
    p2.x = 20;

    w.runPhase(phase, 0, 0);
    expect([...sys.entities]).toEqual([e1, e2]);

    e1.remove(Position);
    w.runPhase(phase, 0, 0);
    expect([...sys.entities]).toEqual([e2]);
  });

  it("sort with multiple components passes tuples to compare", () => {
    const { w, phase } = setup();
    const sys = w
      .system("test")
      .phase(phase)
      .requires(Position, Velocity)
      .sort(
        [Position, Velocity],
        ([posA, velA], [posB, velB]) =>
          posA.x + velA.vx - (posB.x + velB.vx)
      );
    w.start();

    const e1 = w.createEntity();
    const p1 = e1.add(Position, false);
    const v1 = e1.add(Velocity, false);
    p1.x = 10;
    v1.vx = 5; // sum = 15

    const e2 = w.createEntity();
    const p2 = e2.add(Position, false);
    const v2 = e2.add(Velocity, false);
    p2.x = 1;
    v2.vx = 1; // sum = 2

    const e3 = w.createEntity();
    const p3 = e3.add(Position, false);
    const v3 = e3.add(Velocity, false);
    p3.x = 5;
    v3.vx = 5; // sum = 10

    w.runPhase(phase, 0, 0);
    expect([...sys.entities]).toEqual([e2, e3, e1]);
  });
});

describe("System — destroy", () => {
  it("destroy() throws — destroying a system is not supported", () => {
    const { w, phase } = setup();
    const sys = w.system("test").phase(phase).requires(Position);
    w.start();
    expect(() => sys.destroy()).toThrow();
  });
});
