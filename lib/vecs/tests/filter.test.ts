import { describe, it, expect } from "vitest";
import { World } from "../src/index.js";

class Position {
  x = 0;
  y = 0;
}
class Velocity {
  vx = 0;
  vy = 0;
}
class Sprite {}

function setup() {
  const w = new World();
  w.component(Position);
  w.component(Velocity);
  w.component(Sprite);
  return { w };
}

describe("Filter — entity-only forEach", () => {
  it("visits only matching entities", () => {
    const { w } = setup();
    const ePos = w.entity();
    ePos.add(Position);
    const eVel = w.entity();
    eVel.add(Velocity);
    const eBoth = w.entity();
    eBoth.add(Position);
    eBoth.add(Velocity);

    const seen: unknown[] = [];
    w.filter([Position]).forEach((e) => seen.push(e));

    expect(seen).toContain(ePos);
    expect(seen).toContain(eBoth);
    expect(seen).not.toContain(eVel);
  });

  it("reflects world state on each call — non-reactive", () => {
    const { w } = setup();
    const f = w.filter([Position]);
    const e = w.entity();
    e.add(Position);

    const before: unknown[] = [];
    f.forEach((ent) => before.push(ent));
    expect(before).toContain(e);

    e.remove(Position);

    const after: unknown[] = [];
    f.forEach((ent) => after.push(ent));
    expect(after).not.toContain(e);
  });

  it("forEach returns the filter for chaining", () => {
    const { w } = setup();
    const f = w.filter([Position]);
    w.entity().add(Position);

    expect(f.forEach(() => {})).toBe(f);
    expect(f.forEach([Position], () => {})).toBe(f);
  });

  it("works with test DSL", () => {
    const { w } = setup();
    const e = w.entity();
    e.add(Position);

    const seen: unknown[] = [];
    w.filter({ test: (ent) => ent.get(Position) !== undefined }).forEach((ent) => seen.push(ent));

    expect(seen).toContain(e);
  });

  it("all DSL matches only entities with all required components", () => {
    const { w } = setup();
    const ePos = w.entity();
    ePos.add(Position);
    const eBoth = w.entity();
    eBoth.add(Position);
    eBoth.add(Velocity);

    const seen: unknown[] = [];
    w.filter({ all: [Position, Velocity] }).forEach((e) => seen.push(e));

    expect(seen).toContain(eBoth);
    expect(seen).not.toContain(ePos);
  });

  it("any DSL matches entities with any component", () => {
    const { w } = setup();
    const ePos = w.entity();
    ePos.add(Position);
    const eVel = w.entity();
    eVel.add(Velocity);
    const eSprite = w.entity();
    eSprite.add(Sprite);

    const seen: unknown[] = [];
    w.filter({ any: [Position, Velocity] }).forEach((e) => seen.push(e));

    expect(seen).toContain(ePos);
    expect(seen).toContain(eVel);
    expect(seen).not.toContain(eSprite);
  });

  it("not DSL excludes matching entities", () => {
    const { w } = setup();
    const ePos = w.entity();
    ePos.add(Position);
    const eVel = w.entity();
    eVel.add(Velocity);

    const seen: unknown[] = [];
    w.filter({ not: Position }).forEach((e) => seen.push(e));

    expect(seen).not.toContain(ePos);
    expect(seen).toContain(eVel);
  });
});

describe("Filter — rootTerm", () => {
  it("reflects a term created after the filter was constructed", () => {
    const { w } = setup();
    const f = w.filter([Position, Velocity]);

    expect(f.rootTerm).toBeUndefined();

    w.getTerm([Position, Velocity]);

    expect(f.rootTerm).toBeDefined();
  });
});

describe("Filter — forEach with injection", () => {
  it("resolves injected components", () => {
    const { w } = setup();
    const e = w.entity();
    const pos = e.set(Position, { x: 42 }).get(Position)!;

    let received: Position | undefined;
    w.filter([Position]).forEach([Position], (_e, [p]) => {
      received = p;
    });

    expect(received).toBe(pos);
  });

  it("accepts injection options", () => {
    const { w } = setup();
    const e = w.entity();
    const pos = e.set(Position, { x: 42 }).get(Position)!;

    let received: Position | undefined;
    w.filter([Position]).forEach({ inject: [Position] }, (_e, [p]) => {
      received = p;
    });

    expect(received).toBe(pos);
  });

  it("absent injected component is undefined", () => {
    const { w } = setup();
    w.entity().add(Position);

    let vel: Velocity | undefined;
    w.filter([Position]).forEach([Position, Velocity], (_e, [_p, v]) => {
      vel = v;
    });

    expect(vel).toBeUndefined();
  });

  it("_guaranteed override lets caller assert non-null for opaque DSL", () => {
    const { w } = setup();
    const e = w.entity();
    e.set(Position, { x: 7 });

    let result = 0;
    w.filter({ with: { any: [Position, Velocity] }, hint: [Position] }).forEach(
      [Position],
      (_e, [p]) => {
        result += p.x; // p is Position (not Position | undefined)
      }
    );

    expect(result).toBe(7);
  });
});

describe("Filter — type deduction (compile-time)", () => {
  it("plain array DSL deduces required components", () => {
    const { w } = setup();
    const e = w.entity();
    e.set(Position, { x: 1 });
    e.set(Velocity, { vx: 2 });

    let sum = 0;
    w.filter([Position, Velocity]).forEach([Position, Velocity], (_e, [p, v]) => {
      sum += p.x + v.vx; // both non-null — compile error if they were | undefined
    });
    expect(sum).toBe(3);
  });

  it("component array DSL deduces required components", () => {
    const { w } = setup();
    w.entity().set(Position, { x: 5 });

    let sum = 0;
    w.filter([Position]).forEach([Position], (_e, [p]) => {
      sum += p.x; // p is Position, not Position | undefined
    });
    expect(sum).toBe(5);
  });

  it("all deduces all required components", () => {
    const { w } = setup();
    const e = w.entity();
    e.set(Position, { x: 3 });
    e.set(Velocity, { vx: 4 });

    let sum = 0;
    w.filter({ all: [Position, Velocity] }).forEach([Position, Velocity], (_e, [p, v]) => {
      sum += p.x + v.vx; // both non-null
    });
    expect(sum).toBe(7);
  });
});
