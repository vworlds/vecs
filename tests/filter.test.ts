import { describe, it, expect } from "vitest";
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

function setup() {
  const w = new World();
  w.registerComponent(Position);
  w.registerComponent(Velocity);
  w.registerComponent(Sprite);
  return { w };
}

describe("Filter — entity-only forEach", () => {
  it("visits only matching entities", () => {
    const { w } = setup();
    const ePos = w.createEntity();
    ePos.add(Position);
    const eVel = w.createEntity();
    eVel.add(Velocity);
    const eBoth = w.createEntity();
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
    const e = w.createEntity();
    e.add(Position);

    const before: unknown[] = [];
    f.forEach((ent) => before.push(ent));
    expect(before).toContain(e);

    e.remove(Position);

    const after: unknown[] = [];
    f.forEach((ent) => after.push(ent));
    expect(after).not.toContain(e);
  });

  it("works with EntityTestFunc DSL", () => {
    const { w } = setup();
    const e = w.createEntity();
    e.add(Position);

    const seen: unknown[] = [];
    w.filter((ent) => ent.get(Position) !== undefined).forEach((ent) => seen.push(ent));

    expect(seen).toContain(e);
  });

  it("AND DSL matches only entities with all required components", () => {
    const { w } = setup();
    const ePos = w.createEntity();
    ePos.add(Position);
    const eBoth = w.createEntity();
    eBoth.add(Position);
    eBoth.add(Velocity);

    const seen: unknown[] = [];
    w.filter({ AND: [{ HAS: Position }, { HAS: Velocity }] }).forEach((e) => seen.push(e));

    expect(seen).toContain(eBoth);
    expect(seen).not.toContain(ePos);
  });

  it("OR DSL matches entities with any component", () => {
    const { w } = setup();
    const ePos = w.createEntity();
    ePos.add(Position);
    const eVel = w.createEntity();
    eVel.add(Velocity);
    const eSprite = w.createEntity();
    eSprite.add(Sprite);

    const seen: unknown[] = [];
    w.filter({ OR: [Position, Velocity] }).forEach((e) => seen.push(e));

    expect(seen).toContain(ePos);
    expect(seen).toContain(eVel);
    expect(seen).not.toContain(eSprite);
  });

  it("NOT DSL excludes matching entities", () => {
    const { w } = setup();
    const ePos = w.createEntity();
    ePos.add(Position);
    const eVel = w.createEntity();
    eVel.add(Velocity);

    const seen: unknown[] = [];
    w.filter({ NOT: Position }).forEach((e) => seen.push(e));

    expect(seen).not.toContain(ePos);
    expect(seen).toContain(eVel);
  });
});

describe("Filter — forEach with injection", () => {
  it("resolves injected components", () => {
    const { w } = setup();
    const e = w.createEntity();
    const pos = e.set(Position, { x: 42 });

    let received: Position | undefined;
    w.filter([Position]).forEach([Position], (_e, [p]) => {
      received = p;
    });

    expect(received).toBe(pos);
  });

  it("absent injected component is undefined", () => {
    const { w } = setup();
    w.createEntity().add(Position);

    let vel: Velocity | undefined;
    w.filter([Position]).forEach([Position, Velocity], (_e, [_p, v]) => {
      vel = v as Velocity | undefined;
    });

    expect(vel).toBeUndefined();
  });

  it("_guaranteed override lets caller assert non-null for opaque DSL", () => {
    const { w } = setup();
    const e = w.createEntity();
    e.set(Position, { x: 7 });

    let result = 0;
    w.filter({ OR: [Position, Velocity] }, [Position]).forEach([Position], (_e, [p]) => {
      result += p.x; // p is Position (not Position | undefined)
    });

    expect(result).toBe(7);
  });
});

describe("Filter — type deduction (compile-time)", () => {
  it("plain array DSL deduces required components", () => {
    const { w } = setup();
    const e = w.createEntity();
    e.set(Position, { x: 1 });
    e.set(Velocity, { vx: 2 });

    let sum = 0;
    w.filter([Position, Velocity]).forEach([Position, Velocity], (_e, [p, v]) => {
      sum += p.x + v.vx; // both non-null — compile error if they were | undefined
    });
    expect(sum).toBe(3);
  });

  it("HAS DSL deduces required components", () => {
    const { w } = setup();
    w.createEntity().set(Position, { x: 5 });

    let sum = 0;
    w.filter({ HAS: [Position] }).forEach([Position], (_e, [p]) => {
      sum += p.x; // p is Position, not Position | undefined
    });
    expect(sum).toBe(5);
  });

  it("AND of HAS deduces all required components", () => {
    const { w } = setup();
    const e = w.createEntity();
    e.set(Position, { x: 3 });
    e.set(Velocity, { vx: 4 });

    let sum = 0;
    w.filter({ AND: [{ HAS: Position }, { HAS: Velocity }] }).forEach(
      [Position, Velocity],
      (_e, [p, v]) => {
        sum += p.x + v.vx; // both non-null
      }
    );
    expect(sum).toBe(7);
  });
});
