import { describe, expect, it } from "vitest";
import {
  DontInherit,
  Exclusive,
  Inherit,
  IsA,
  OnInstantiate,
  OneOf,
  Override,
  World,
} from "../../src/index.js";

class Helmet {
  armor = 0;
}
class Sword {
  damage = 0;
}
class Faction {
  team = 0;
}
class Horse {
  speed = 0;
}
class Shield {
  defense = 0;
}
class Position {
  x = 0;
  y = 0;
}
class Switchable {
  value = 0;
}

describe("InheritanceModule", () => {
  it("is auto-registered by new World()", () => {
    const w = new World();
    expect(() => w.component(IsA)).not.toThrow();
    expect(() => w.component(OnInstantiate)).not.toThrow();
    expect(w.component(IsA).meta.isRelationship).toBe(true);
    expect(w.component(OnInstantiate).meta.isRelationship).toBe(true);
  });

  it("configures OnInstantiate as a OneOf self-parent", () => {
    const w = new World();
    const onInstantiate = w.component(OnInstantiate);
    expect(onInstantiate.has(OneOf)).toBe(true);
    expect(onInstantiate.target(OneOf)).toBe(onInstantiate);
  });

  it("creates Override, Inherit, DontInherit as children of OnInstantiate", () => {
    const w = new World();
    const onInstantiate = w.component(OnInstantiate);
    expect(w.component(Override).parent).toBe(onInstantiate);
    expect(w.component(Inherit).parent).toBe(onInstantiate);
    expect(w.component(DontInherit).parent).toBe(onInstantiate);
  });

  it("supports add(OnInstantiate, Inherit) and resolves the target", () => {
    const w = new World();
    const helmet = w.component(Helmet);
    helmet.add(OnInstantiate, Inherit);
    expect(helmet.target(OnInstantiate)).toBe(w.component(Inherit));
  });

  it("rejects an OnInstantiate target that is not a child of OnInstantiate", () => {
    const w = new World();
    const helmet = w.component(Helmet);
    const randomEntity = w.entity();
    expect(() => helmet.add(OnInstantiate, randomEntity)).toThrow("OneOf: target");
  });

  it("marks IsA as Exclusive", () => {
    const w = new World();
    expect(w.component(IsA).has(Exclusive)).toBe(true);
  });

  it("rejects retargeting IsA to a different template", () => {
    const w = new World();
    const t1 = w.entity();
    const t2 = w.entity();
    const e = w.entity().add(IsA, t1);
    expect(e.target(IsA)).toBe(t1);
    expect(() => e.add(IsA, t2)).toThrow("IsA does not allow retargeting");
    // World partially mutated; discard it.
  });

  it("allows re-adding IsA to the same template (idempotent)", () => {
    const w = new World();
    const t1 = w.entity();
    const e = w.entity().add(IsA, t1);
    expect(() => e.add(IsA, t1)).not.toThrow();
    expect(e.target(IsA)).toBe(t1);
  });

  it("allows clearAllEntities to tear down a world with OnInstantiate configured", () => {
    const w = new World();
    const helmet = w.component(Helmet);
    helmet.add(OnInstantiate, Inherit);
    w.entity().add(IsA, w.entity());
    expect(() => w.clearAllEntities()).not.toThrow();
    expect(w.entities.size).toBe(0);
  });
});

describe("IsA component walk", () => {
  it("walks the template copying, proxying, and skipping per OnInstantiate policy", () => {
    const w = new World();
    w.component(Helmet).add(OnInstantiate, Inherit);
    w.component(Sword).add(OnInstantiate, Override);
    w.component(Faction).add(OnInstantiate, DontInherit);
    w.component(Horse);

    const warrior = w
      .entity()
      .set(Helmet, { armor: 3 })
      .set(Sword, { damage: 10 })
      .set(Faction, { team: 1 });
    const knight = w.entity().add(IsA, warrior).add(Horse);

    expect(warrior.has(Horse)).toBe(false);
    expect(warrior.has(Faction)).toBe(true);
    expect(knight.has(Helmet)).toBe(true);
    expect(knight.has(Sword)).toBe(true);
    expect(knight.has(Horse)).toBe(true);
    expect(knight.has(Faction)).toBe(false);
  });

  it("Inherit-mode proxies reads through to the template while clean", () => {
    const w = new World();
    w.component(Helmet).add(OnInstantiate, Inherit);
    const warrior = w.entity().set(Helmet, { armor: 3 });
    const knight = w.entity().add(IsA, warrior);

    expect(knight.get(Helmet)!.armor).toBe(3);
    warrior.set(Helmet, { armor: 5 });
    expect(warrior.get(Helmet)!.armor).toBe(5);
    expect(knight.get(Helmet)!.armor).toBe(5);
  });

  it("Override-mode copies at IsA time and is independent of the template", () => {
    const w = new World();
    w.component(Sword).add(OnInstantiate, Override);
    const warrior = w.entity().set(Sword, { damage: 10 });
    const knight = w.entity().add(IsA, warrior);

    expect(knight.get(Sword)!.damage).toBe(10);
    warrior.set(Sword, { damage: 7 });
    expect(warrior.get(Sword)!.damage).toBe(7);
    expect(knight.get(Sword)!.damage).toBe(10);
  });

  it("Inherit-mode dirty promotion unproxies on the inheritor without writing through", () => {
    const w = new World();
    w.component(Helmet).add(OnInstantiate, Inherit);
    const warrior = w.entity().set(Helmet, { armor: 3 });
    const knight = w.entity().add(IsA, warrior);

    expect(knight.get(Helmet)!.armor).toBe(3);
    warrior.set(Helmet, { armor: 5 });
    expect(knight.get(Helmet)!.armor).toBe(5);
    knight.set(Helmet, { armor: 7 });
    expect(knight.get(Helmet)!.armor).toBe(7);
    expect(warrior.get(Helmet)!.armor).toBe(5);
  });

  it("preserves instanceof for clean wrappers and promoted real instances", () => {
    const w = new World();
    w.component(Helmet).add(OnInstantiate, Inherit);
    const warrior = w.entity().set(Helmet, { armor: 3 });
    const knight = w.entity().add(IsA, warrior);

    expect(knight.get(Helmet) instanceof Helmet).toBe(true);
    knight.set(Helmet, { armor: 7 });
    expect(knight.get(Helmet) instanceof Helmet).toBe(true);
  });

  it("defaults to Override when a component has no OnInstantiate edge", () => {
    const w = new World();
    w.component(Shield);
    const warrior = w.entity().set(Shield, { defense: 5 });
    const knight = w.entity().add(IsA, warrior);

    expect(knight.get(Shield)!.defense).toBe(5);
    warrior.set(Shield, { defense: 9 });
    expect(knight.get(Shield)!.defense).toBe(5);
  });

  it("DontInherit components are absent on the inheritor", () => {
    const w = new World();
    w.component(Faction).add(OnInstantiate, DontInherit);
    const warrior = w.entity().set(Faction, { team: 1 });
    const knight = w.entity().add(IsA, warrior);

    expect(knight.has(Faction)).toBe(false);
    expect(knight.get(Faction)).toBeUndefined();
  });

  it("transitive IsA shortcuts a clean intermediate wrapper", () => {
    const w = new World();
    w.component(Position).add(OnInstantiate, Inherit);
    const unit = w.entity().set(Position, { x: 5, y: 7 });
    const warrior = w.entity().add(IsA, unit);
    const knight = w.entity().add(IsA, warrior);

    expect(knight.get(Position)!.x).toBe(5);
    expect(knight.get(Position)!.y).toBe(7);
    unit.set(Position, { x: 9, y: 9 });
    expect(knight.get(Position)!.x).toBe(9);
    expect(knight.get(Position)!.y).toBe(9);
    warrior.set(Position, { x: 100, y: 100 });
    expect(knight.get(Position)!.x).toBe(9);
    expect(knight.get(Position)!.y).toBe(9);
  });

  it("transitive IsA snapshots a dirty intermediate wrapper as a real copy", () => {
    const w = new World();
    w.component(Position).add(OnInstantiate, Inherit);
    const unit = w.entity().set(Position, { x: 5, y: 7 });
    const warrior = w.entity().add(IsA, unit);
    warrior.set(Position, { x: 42, y: 42 });
    const knight = w.entity().add(IsA, warrior);

    expect(knight.get(Position)!.x).toBe(42);
    expect(knight.get(Position)!.y).toBe(42);
    unit.set(Position, { x: 999, y: 999 });
    expect(knight.get(Position)!.x).toBe(42);
  });

  it("policy switching affects future IsA additions, not past", () => {
    const w = new World();
    w.component(Switchable).add(OnInstantiate, Override);
    const t1 = w.entity().set(Switchable, { value: 10 });
    const e1 = w.entity().add(IsA, t1);
    expect(e1.get(Switchable)!.value).toBe(10);
    t1.set(Switchable, { value: 20 });
    expect(e1.get(Switchable)!.value).toBe(10);

    w.component(Switchable).add(OnInstantiate, Inherit);
    const t2 = w.entity().set(Switchable, { value: 30 });
    const e2 = w.entity().add(IsA, t2);
    expect(e2.get(Switchable)!.value).toBe(30);
    t2.set(Switchable, { value: 40 });
    expect(e2.get(Switchable)!.value).toBe(40);

    expect(e1.get(Switchable)!.value).toBe(10);
  });
});

describe("IsA no-retarget and removal", () => {
  it("surfaces retarget at flush() in deferred mode", () => {
    const w = new World();
    const t1 = w.entity();
    const t2 = w.entity();
    const e = w.entity();

    w.beginDefer();
    e.add(IsA, t1);
    e.add(IsA, t2);
    expect(() => w.endDefer()).toThrow("IsA does not allow retargeting");
    // World partially mutated; discard it.
  });

  it("removing IsA leaves copied components on the inheritor", () => {
    const w = new World();
    w.component(Helmet).add(OnInstantiate, Inherit);
    w.component(Shield);
    const warrior = w.entity().set(Helmet, { armor: 3 }).set(Shield, { defense: 5 });
    const knight = w.entity().add(IsA, warrior);

    expect(knight.has(Helmet)).toBe(true);
    expect(knight.has(Shield)).toBe(true);
    expect(knight.has(IsA)).toBe(true);

    knight.remove(IsA);

    expect(knight.has(IsA)).toBe(false);
    expect(knight.has(Helmet)).toBe(true);
    expect(knight.has(Shield)).toBe(true);
    expect(knight.get(Helmet)!.armor).toBe(3);
    expect(knight.get(Shield)!.defense).toBe(5);
  });

  it("removing IsA by edge leaves other edges and copied components intact", () => {
    const w = new World();
    w.component(Helmet).add(OnInstantiate, Inherit);
    const warrior = w.entity().set(Helmet, { armor: 3 });
    const knight = w.entity().add(IsA, warrior);

    knight.remove(IsA, warrior);
    expect(knight.has(IsA)).toBe(false);
    expect(knight.has(Helmet)).toBe(true);
  });
});
