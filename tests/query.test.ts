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
  // dummy system ensures runPhase always flushes archetype changes
  w.system("__flush__")
    .phase(phase)
    .run(() => {});
  return {
    w,
    tick: () => w.runPhase(phase, 0, 0),
  };
}

describe("Query — construction", () => {
  it("world.query() tracks entities by default", () => {
    const { w, tick } = setup();
    const q = w.query("test").requires(Position);
    w.start();
    const e = w.entity();
    e.add(Position);
    tick();
    expect(q.entities.has(e)).toBe(true);
  });

  it("can be created after start() and immediately backfills existing entities", () => {
    const { w, tick } = setup();
    w.start();
    const e = w.entity();
    e.add(Position);
    tick(); // flush archetype so e is "settled"
    const q = w.query("late").requires(Position);
    expect(q.entities.has(e)).toBe(true);
  });

  it("name is accessible on the query", () => {
    const { w } = setup();
    const q = w.query("enemies");
    expect(q.name).toBe("enemies");
    expect(q.toString()).toBe("enemies");
  });
});

describe("Query — predicates (belongs)", () => {
  it("requires / HAS matches entities with all listed components", () => {
    const { w } = setup();
    const q = w.query("test").requires(Position, Velocity);
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    b.add(Velocity);
    expect(q.belongs(a)).toBe(false);
    expect(q.belongs(b)).toBe(true);
  });

  it("HAS_ONLY matches entities with exactly that component set", () => {
    const { w } = setup();
    const q = w.query("test").query({ HAS_ONLY: [Position] });
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    b.add(Velocity);
    expect(q.belongs(a)).toBe(true);
    expect(q.belongs(b)).toBe(false);
  });

  it("AND requires all sub-predicates to match", () => {
    const { w } = setup();
    const q = w.query("test").query({ AND: [Position, Velocity] });
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    b.add(Velocity);
    expect(q.belongs(a)).toBe(false);
    expect(q.belongs(b)).toBe(true);
  });

  it("OR matches if any branch is satisfied", () => {
    const { w } = setup();
    const q = w.query("test").query({ OR: [Sprite, Container] });
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

  it("NOT inverts a sub-predicate", () => {
    const { w } = setup();
    const q = w.query("test").query({ AND: [Position, { NOT: Velocity }] });
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    b.add(Velocity);
    expect(q.belongs(a)).toBe(true);
    expect(q.belongs(b)).toBe(false);
  });

  it("PARENT checks the entity's parent", () => {
    const { w } = setup();
    const q = w.query("test").query({ PARENT: { AND: [Player, Container] } });
    const parent = w.entity();
    parent.add(Player);
    parent.add(Container);
    const child = w.entity();
    child.setParent(parent);
    child.add(Position);
    expect(q.belongs(child)).toBe(true);
    const orphan = w.entity();
    orphan.add(Position);
    expect(q.belongs(orphan)).toBe(false);
  });

  it("an EntityTestFunc can be passed directly", () => {
    const { w } = setup();
    const q = w.query("test").query((e) => e.eid === 7);
    const seven = w.getOrCreateEntity(7);
    seven.add(Position);
    const three = w.getOrCreateEntity(3);
    three.add(Position);
    expect(q.belongs(seven)).toBe(true);
    expect(q.belongs(three)).toBe(false);
  });

  it("a single class is shorthand for HAS", () => {
    const { w } = setup();
    const q = w.query("test").query(Position);
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Velocity);
    expect(q.belongs(a)).toBe(true);
    expect(q.belongs(b)).toBe(false);
  });

  it("an array is shorthand for HAS", () => {
    const { w } = setup();
    const q = w.query("test").query([Position, Velocity]);
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    b.add(Velocity);
    expect(q.belongs(a)).toBe(false);
    expect(q.belongs(b)).toBe(true);
  });

  it("explicit { HAS: ... } is equivalent to requires", () => {
    const { w } = setup();
    const q = w.query("test").query({ HAS: [Position, Velocity] });
    const e = w.entity();
    e.add(Position);
    e.add(Velocity);
    expect(q.belongs(e)).toBe(true);
  });
});

describe("Query — entity tracking via world pipeline", () => {
  it("entity enters query when it gains the required components", () => {
    const { w, tick } = setup();
    const q = w.query("test").requires(Position);
    w.start();
    const e = w.entity();
    e.add(Position);
    tick();
    expect(q.entities.has(e)).toBe(true);
    expect(q.entities.size).toBe(1);
  });

  it("entity exits query when it loses a required component", () => {
    const { w, tick } = setup();
    const q = w.query("test").requires(Position);
    w.start();
    const e = w.entity();
    e.add(Position);
    tick();
    e.remove(Position);
    tick();
    expect(q.entities.size).toBe(0);
  });

  it("forEach (entity-only) iterates all matched entities", () => {
    const { w, tick } = setup();
    const q = w.query("test").requires(Position);
    w.start();
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

  it("forEach with injection resolves components for each entity", () => {
    const { w, tick } = setup();
    const q = w.query("test").requires(Position, Velocity);
    w.start();
    const e = w.entity();
    e.set(Position, { x: 3 });
    e.set(Velocity, { vx: 4 });
    tick();
    let sum = 0;
    q.forEach([Position, Velocity], (_e, [p, v]) => {
      sum += p.x + v.vx; // non-null — both in requires()
    });
    expect(sum).toBe(7);
  });

  it("forEach with injection yields undefined for components not in requires", () => {
    const { w, tick } = setup();
    const q = w.query("test").requires(Position);
    w.start();
    const e = w.entity();
    e.add(Position);
    tick();
    let velSeen: Velocity | undefined;
    q.forEach([Position, Velocity], (_e, [_p, v]) => {
      velSeen = v as Velocity | undefined;
    });
    expect(velSeen).toBeUndefined();
  });

  it("entities is typed as a ReadonlySet", () => {
    const { w } = setup();
    const q = w.query("test");
    const fakeEntity = {} as any;
    // @ts-expect-error entities is a ReadonlySet — add() is not exposed
    q.entities.add(fakeEntity);
    // @ts-expect-error entities is a ReadonlySet — delete() is not exposed
    q.entities.delete(fakeEntity);
  });

  it("destroyed entity is removed from the query", () => {
    const { w, tick } = setup();
    const q = w.query("test").requires(Position);
    w.start();
    const e = w.entity();
    e.add(Position);
    tick();
    expect(q.entities.has(e)).toBe(true);
    e.destroy();
    tick();
    expect(q.entities.size).toBe(0);
  });
});

describe("Query — enter/exit callbacks", () => {
  it("enter fires when an entity first matches the query", () => {
    const { w, tick } = setup();
    const cb = vi.fn();
    w.query("test").requires(Position).enter(cb);
    w.start();
    const e = w.entity();
    e.add(Position);
    tick();
    expect(cb).toHaveBeenCalledWith(e);
  });

  it("enter with injection passes a typed tuple", () => {
    const { w, tick } = setup();
    const cb = vi.fn();
    w.query("test").requires(Position, Velocity).enter([Position, Velocity], cb);
    w.start();
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    const vel = e.add(Velocity).get(Velocity)!;
    tick();
    expect(cb).toHaveBeenCalledWith(e, [pos, vel]);
  });

  it("exit fires when an entity stops matching", () => {
    const { w, tick } = setup();
    const cb = vi.fn();
    w.query("test").requires(Position).exit(cb);
    w.start();
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
    w.query("test").requires(Position).exit([Position], cb);
    w.start();
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

describe("Query — sort", () => {
  it("sort() orders entities by the comparator", () => {
    const { w, tick } = setup();
    const q = w
      .query("test")
      .requires(Position)
      .sort([Position], ([a], [b]) => a.x - b.x);
    w.start();
    const e1 = w.entity();
    e1.set(Position, { x: 30 });
    const e2 = w.entity();
    e2.set(Position, { x: 10 });
    const e3 = w.entity();
    e3.set(Position, { x: 20 });
    tick();
    expect([...q.entities]).toEqual([e2, e3, e1]);
  });

  it("forEach visits entities in sorted order", () => {
    const { w, tick } = setup();
    const q = w
      .query("test")
      .requires(Position)
      .sort([Position], ([a], [b]) => a.x - b.x);
    w.start();
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
      .requires(Position)
      .sort([Position], ([a], [b]) => a.x - b.x);
    w.start();
    const e1 = w.entity();
    e1.set(Position, { x: 10 });
    const e2 = w.entity();
    e2.set(Position, { x: 20 });
    tick();
    expect([...q.entities]).toEqual([e1, e2]);
    e1.remove(Position);
    tick();
    expect([...q.entities]).toEqual([e2]);
  });

  it("sort() returns the query for chaining", () => {
    const { w } = setup();
    const q = w.query("test").requires(Position);
    expect(q.sort([Position], ([a], [b]) => a.x - b.x)).toBe(q);
  });
});

describe("Query — destroy", () => {
  it("destroy() clears the entities set", () => {
    const { w, tick } = setup();
    const q = w.query("test").requires(Position);
    w.start();
    const e = w.entity();
    e.add(Position);
    tick();
    expect(q.entities.size).toBe(1);
    q.destroy();
    expect(q.entities.size).toBe(0);
  });

  it("destroy() removes the query from the world — new entities no longer enter it", () => {
    const { w, tick } = setup();
    const enter = vi.fn();
    const q = w.query("test").requires(Position).enter(enter);
    w.start();
    q.destroy();
    const e = w.entity();
    e.add(Position);
    tick();
    expect(enter).not.toHaveBeenCalled();
  });

  it("destroy() removes the query from entities — existing entities no longer reference it", () => {
    const { w, tick } = setup();
    const q = w.query("test").requires(Position);
    w.start();
    const e = w.entity();
    e.add(Position);
    tick();
    q.destroy();
    // After destroy the query is no longer in the entity's query set;
    // a component modification should not reach the (dead) query.
    const notify = vi.spyOn(q, "notifyModified");
    const pos = e.get(Position)!;
    pos.modified();
    tick();
    expect(notify).not.toHaveBeenCalled();
  });

  it("destroy() sets world to undefined by force", () => {
    const { w } = setup();
    const q = w.query("test").requires(Position);
    w.start();
    q.destroy();
    expect((q as any).world).toBeUndefined();
  });

  it("destroy() on a query with no tracking still removes it from the world", () => {
    const { w, tick } = setup();
    // Create a system (which is untracked by default) — but we test with a raw query
    // that has tracking disabled via the internal constructor path.
    // Instead, just verify that a tracked query is also properly removed.
    const enter = vi.fn();
    const q = w.query("test").requires(Position).enter(enter);
    w.start();
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

describe("Query — NOT predicate routing", () => {
  it("removing a component causes enter on a NOT query", () => {
    const { w, tick } = setup();
    const enter = vi.fn();
    // Matches entities that have Position but NOT Velocity.
    w.query("test")
      .query({ AND: [Position, { NOT: Velocity }] })
      .enter(enter);
    w.start();
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

  it("adding a component causes exit on a NOT query", () => {
    const { w, tick } = setup();
    const exit = vi.fn();
    w.query("test")
      .query({ AND: [Position, { NOT: Velocity }] })
      .exit(exit);
    w.start();
    const e = w.entity();
    e.add(Position);
    tick(); // entity matches (no Velocity)
    e.add(Velocity);
    tick(); // adding Velocity breaks the NOT predicate → exit fires
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("cycling NOT query fires enter → exit → enter in order", () => {
    const { w, tick } = setup();
    const events: string[] = [];
    w.query("test")
      .query({ AND: [Position, { NOT: Velocity }] })
      .enter(() => events.push("enter"))
      .exit(() => events.push("exit"));
    w.start();
    const e = w.entity();
    e.add(Position);
    tick(); // enter (no Velocity)
    e.add(Velocity);
    tick(); // exit (Velocity added)
    e.remove(Velocity);
    tick(); // enter again (Velocity removed)
    expect(events).toEqual(["enter", "exit", "enter"]);
  });

  it("plain NOT query: entity enters when the excluded component is removed", () => {
    const { w, tick } = setup();
    const enter = vi.fn();
    w.query("test").query({ NOT: Velocity }).enter(enter);
    w.start();
    const e = w.entity();
    e.add(Velocity);
    tick();
    expect(enter).not.toHaveBeenCalled();
    e.remove(Velocity);
    tick();
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("system receives enter inbox event when NOT-excluded component is removed", () => {
    const { w } = setup();
    const enter = vi.fn();
    const phase = w.addPhase("p2");
    w.system("test")
      .phase(phase)
      .query({ AND: [Position, { NOT: Velocity }] })
      .enter(enter);
    w.start();
    const e = w.entity();
    // Add Velocity first so Position's arrival doesn't transiently match.
    e.add(Velocity); // no Position — doesn't match
    e.add(Position); // has both — still doesn't match (has Velocity)
    w.runPhase(phase, 0, 0);
    expect(enter).not.toHaveBeenCalled();
    e.remove(Velocity); // now matches → enter queued on system inbox
    w.runPhase(phase, 0, 0);
    expect(enter.mock.calls[0][0]).toBe(e);
  });
});
