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

describe("System — onEnter / onExit / onUpdate", () => {
  it("onEnter fires when an entity first matches the query", () => {
    const { w, phase } = setup();
    const onEnter = vi.fn();
    w.system("test").phase(phase).requires(Position).onEnter(onEnter);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    expect(onEnter).toHaveBeenCalledWith(e);
  });

  it("onEnter with injection receives a typed tuple", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test")
      .phase(phase)
      .requires(Position, Velocity)
      .onEnter([Position, Velocity], cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position);
    const vel = e.add(Velocity);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(e, [pos, vel]);
  });

  it("onExit fires when an entity stops matching", () => {
    const { w, phase } = setup();
    const onExit = vi.fn();
    w.system("test").phase(phase).requires(Position).onExit(onExit);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    e.remove(Position);
    w.runPhase(phase, 0, 0);
    expect(onExit).toHaveBeenCalledWith(e);
  });

  it("onExit injection includes recently-removed components", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).onExit([Position], cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position);
    w.runPhase(phase, 0, 0);
    e.remove(Position);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(e, [pos]);
  });

  it("onUpdate fires on component.modified()", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).onUpdate(Position, cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position, false);
    w.runPhase(phase, 0, 0); // entity entered
    cb.mockClear();
    pos.modified();
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(pos);
  });

  it("onEnter delivers an initial onUpdate for components already on the entity", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).requires(Position).onUpdate(Position, cb);
    w.start();
    const e = w.createEntity();
    const pos = e.add(Position);
    w.runPhase(phase, 0, 0); // tick 1 enters the entity & queues pos
    w.runPhase(phase, 0, 0); // tick 2 drains the queue
    expect(cb).toHaveBeenCalledWith(pos);
  });

  it("onUpdate with injection delivers extra components", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test")
      .phase(phase)
      .requires(Position, Velocity)
      .onUpdate(Velocity, [Position], cb);
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

  it("onUpdate without an explicit query implicitly requires its component", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).onUpdate(Position, cb);
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

  it("onRun fires every tick regardless of entity state", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).onRun(cb);
    w.start();
    w.runPhase(phase, 100, 16);
    w.runPhase(phase, 116, 16);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith(116, 16);
  });

  it("onRun returns the system for chaining", () => {
    const { w } = setup();
    const sys = w.system("test");
    expect(sys.onRun(() => {})).toBe(sys);
  });

  it("toString returns the system name", () => {
    const { w } = setup();
    const sys = w.system("Move");
    expect(sys.toString()).toBe("Move");
  });

  it("destroyed entity also fires onExit", () => {
    const { w, phase } = setup();
    const onExit = vi.fn();
    w.system("test").phase(phase).requires(Position).onExit(onExit);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    e.destroy();
    w.runPhase(phase, 0, 0);
    expect(onExit).toHaveBeenCalledWith(e);
  });
});

describe("System — query DSL", () => {
  it("HAS / requires matches entities that have all components", () => {
    const { w, phase } = setup();
    const onEnter = vi.fn();
    w.system("test").phase(phase).requires(Position, Velocity).onEnter(onEnter);
    w.start();

    const a = w.createEntity();
    a.add(Position);
    const b = w.createEntity();
    b.add(Position);
    b.add(Velocity);
    w.runPhase(phase, 0, 0);
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEnter).toHaveBeenCalledWith(b);
  });

  it("HAS_ONLY matches entities with exactly that component set", () => {
    const { w, phase } = setup();
    const onEnter = vi.fn();
    w.system("test").phase(phase).query({ HAS_ONLY: [Position] }).onEnter(onEnter);
    w.start();

    const a = w.createEntity();
    a.add(Position);
    const b = w.createEntity();
    b.add(Position);
    b.add(Velocity);
    w.runPhase(phase, 0, 0);
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEnter).toHaveBeenCalledWith(a);
  });

  it("AND combines sub-queries", () => {
    const { w, phase } = setup();
    const onEnter = vi.fn();
    w.system("test").phase(phase).query({ AND: [Position, Velocity] }).onEnter(onEnter);
    w.start();

    const a = w.createEntity();
    a.add(Position);
    const b = w.createEntity();
    b.add(Position);
    b.add(Velocity);
    w.runPhase(phase, 0, 0);
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEnter).toHaveBeenCalledWith(b);
  });

  it("OR matches either branch", () => {
    const { w, phase } = setup();
    const onEnter = vi.fn();
    w.system("test").phase(phase).query({ OR: [Sprite, Container] }).onEnter(onEnter);
    w.start();

    const a = w.createEntity();
    a.add(Sprite);
    const b = w.createEntity();
    b.add(Container);
    const c = w.createEntity();
    c.add(Position);
    w.runPhase(phase, 0, 0);
    expect(onEnter).toHaveBeenCalledTimes(2);
  });

  it("NOT inverts a sub-query", () => {
    const { w, phase } = setup();
    const matches: number[] = [];
    w.system("test")
      .phase(phase)
      .query({ AND: [Position, { NOT: Velocity }] })
      .onEnter((e) => matches.push(e.eid));
    w.start();

    const a = w.createEntity();
    a.add(Position);
    const b = w.createEntity();
    b.add(Position);
    b.add(Velocity);
    w.runPhase(phase, 0, 0);
    expect(matches).toEqual([a.eid]);
  });

  it("PARENT looks up the entity's parent", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test")
      .phase(phase)
      .query({ PARENT: { AND: [Player, Container] } })
      .onEnter(cb);
    w.start();

    const parent = w.createEntity();
    parent.add(Player);
    parent.add(Container);

    const child = w.createEntity();
    child.parent = parent;
    parent.children.add(child);
    child.add(Position); // any component, just so its archetype fires once

    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(child);
  });

  it("an EntityTestFunc can be passed directly", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).query((e) => e.eid === 7).onEnter(cb);
    w.start();

    w.createEntity(); // 0
    const seven = w.getOrCreateEntity(7);
    seven.add(Position); // trigger archetype change
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(seven);
  });

  it("a single class is shorthand for HAS", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).query(Position).onEnter(cb);
    w.start();

    const e = w.createEntity();
    e.add(Position);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(e);
  });

  it("an array is shorthand for HAS", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).query([Position, Velocity]).onEnter(cb);
    w.start();

    const a = w.createEntity();
    a.add(Position);
    const b = w.createEntity();
    b.add(Position);
    b.add(Velocity);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(b);
    expect(cb).not.toHaveBeenCalledWith(a);
  });

  it("query overrides any prior implicit watchlist query", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    // onUpdate would normally add Position to the implicit query;
    // a subsequent query() should fully replace it.
    w.system("test")
      .phase(phase)
      .onUpdate(Position, () => {})
      .query(Velocity)
      .onEnter(cb);
    w.start();

    const e = w.createEntity();
    e.add(Position); // would have matched the implicit query
    w.runPhase(phase, 0, 0);
    expect(cb).not.toHaveBeenCalled();

    e.add(Velocity);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(e);
  });

  it("explicit { HAS: ... } is equivalent to requires", () => {
    const { w, phase } = setup();
    const cb = vi.fn();
    w.system("test").phase(phase).query({ HAS: [Position, Velocity] }).onEnter(cb);
    w.start();
    const e = w.createEntity();
    e.add(Position);
    e.add(Velocity);
    w.runPhase(phase, 0, 0);
    expect(cb).toHaveBeenCalledWith(e);
  });
});

describe("System — phases", () => {
  it("phase by IPhase reference assigns the system to that phase", () => {
    const w = new World();
    const seen: string[] = [];
    const a = w.addPhase("a");
    const b = w.addPhase("b");
    w.system("sysA").phase(a).onRun(() => seen.push("A"));
    w.system("sysB").phase(b).onRun(() => seen.push("B"));
    w.start();
    w.runPhase(b, 0, 0);
    w.runPhase(a, 0, 0);
    expect(seen).toEqual(["B", "A"]);
  });

  it("phase by name resolves at start() time", () => {
    const w = new World();
    const cb = vi.fn();
    w.addPhase("custom");
    w.system("test").phase("custom").onRun(cb);
    w.start();
    const custom = [...w["pipeline"].values()].find((p) => p.name === "custom")!;
    w.runPhase(custom, 0, 0);
    expect(cb).toHaveBeenCalled();
  });

  it("systems without a phase land in the built-in 'update' phase", () => {
    const w = new World();
    const cb = vi.fn();
    w.system("test").onRun(cb);
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

describe("System — registration timing", () => {
  it("system registration is disabled after start()", () => {
    const w = new World();
    w.start();
    expect(() => w.system("late")).toThrow();
  });
});
