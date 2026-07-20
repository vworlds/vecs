import { describe, expect, it } from "vitest";
import {
  ChildOf,
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
class Sprite {}

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

describe("IsA edge cases and teardown", () => {
  it("destroying the template removes the IsA edge and leaves inherited components", () => {
    const w = new World();
    w.component(Helmet).add(OnInstantiate, Inherit);
    w.component(Shield);
    const warrior = w.entity().set(Helmet, { armor: 5 }).set(Shield, { defense: 9 });
    const knight = w.entity().add(IsA, warrior);
    expect(knight.has(Helmet)).toBe(true);
    expect(knight.has(Shield)).toBe(true);
    warrior.destroy();
    expect(knight.has(IsA)).toBe(false);
    expect(knight.has(Helmet)).toBe(true);
    expect(knight.has(Shield)).toBe(true);
  });

  it("reads through a stale clean wrapper return last-known values without throwing", () => {
    const w = new World();
    w.component(Helmet).add(OnInstantiate, Inherit);
    const warrior = w.entity().set(Helmet, { armor: 5 });
    const knight = w.entity().add(IsA, warrior);
    warrior.destroy();
    expect(() => knight.get(Helmet)).not.toThrow();
    expect(knight.get(Helmet)!.armor).toBe(5);
  });

  it("writing to a stale clean wrapper snapshots at first write", () => {
    const w = new World();
    w.component(Helmet).add(OnInstantiate, Inherit);
    const warrior = w.entity().set(Helmet, { armor: 5 });
    const knight = w.entity().add(IsA, warrior);
    warrior.destroy();
    const wrapper = knight.get(Helmet) as Helmet;
    wrapper.armor = 99;
    expect(knight.get(Helmet)!.armor).toBe(99);
  });

  it("clearAllEntities succeeds with live IsA edges (teardown contract)", () => {
    const w = new World();
    w.component(Helmet).add(OnInstantiate, Inherit);
    w.component(Shield);
    const warrior = w.entity().set(Helmet, { armor: 5 }).set(Shield, { defense: 9 });
    const knight = w.entity().add(IsA, warrior);
    const squire = w.entity().add(IsA, knight);
    expect(() => w.clearAllEntities()).not.toThrow();
    expect(w.entities.size).toBe(0);
  });

  it("a fieldless Inherit component produces a working wrapper that promotes on modified", () => {
    const w = new World();
    w.component(Sprite).add(OnInstantiate, Inherit);
    const template = w.entity().add(Sprite);
    const inheritor = w.entity().add(IsA, template);
    expect(inheritor.has(Sprite)).toBe(true);
    expect(inheritor.get(Sprite) instanceof Sprite).toBe(true);
    inheritor.modified(Sprite);
    w.progress(0, 0);
    const got = inheritor.get(Sprite);
    expect(got instanceof Sprite).toBe(true);
  });

  it("an Inherit component later removed from the template leaves a stale-but-readable proxy", () => {
    const w = new World();
    w.component(Helmet).add(OnInstantiate, Inherit);
    w.component(Shield);
    const warrior = w.entity().set(Helmet, { armor: 5 }).set(Shield, { defense: 9 });
    const knight = w.entity().add(IsA, warrior);
    warrior.remove(Helmet);
    expect(() => knight.get(Helmet)).not.toThrow();
    expect(knight.get(Helmet)!.armor).toBe(5);
    expect(knight.get(Shield)!.defense).toBe(9);
  });

  it("IsA on an empty template is a no-op", () => {
    const w = new World();
    const empty = w.entity();
    const inheritor = w.entity().add(IsA, empty);
    expect(inheritor.has(IsA)).toBe(true);
    // The inheritor's only component is the IsA relationship itself.
    expect(inheritor.components.size).toBe(1);
  });

  it("IsA on a template with only relationships inherits nothing", () => {
    const w = new World();
    const parent = w.entity();
    const template = w.entity().childOf(parent);
    const inheritor = w.entity().add(IsA, template);
    expect(inheritor.has(IsA)).toBe(true);
    expect(inheritor.has(ChildOf)).toBe(false);
  });

  it("multiple inheritors of the same template get independent wrappers", () => {
    const w = new World();
    w.component(Helmet).add(OnInstantiate, Inherit);
    w.component(Sword).add(OnInstantiate, Override);
    const warrior = w.entity().set(Helmet, { armor: 5 }).set(Sword, { damage: 10 });
    const knight1 = w.entity().add(IsA, warrior);
    const knight2 = w.entity().add(IsA, warrior);
    expect(knight1.get(Helmet)!.armor).toBe(5);
    expect(knight2.get(Helmet)!.armor).toBe(5);
    expect(knight1.get(Sword)!.damage).toBe(10);
    expect(knight2.get(Sword)!.damage).toBe(10);
    knight1.set(Helmet, { armor: 7 });
    expect(knight1.get(Helmet)!.armor).toBe(7);
    expect(knight2.get(Helmet)!.armor).toBe(5);
    warrior.set(Helmet, { armor: 9 });
    expect(knight1.get(Helmet)!.armor).toBe(7);
    expect(knight2.get(Helmet)!.armor).toBe(9);
  });

  it("mutating an Inherit component inside each() promotes via modified()", () => {
    const w = new World();
    w.component(Position).add(OnInstantiate, Inherit);
    const warrior = w.entity().set(Position, { x: 5, y: 7 });
    const knight = w.entity().add(IsA, warrior);
    // Filter the system to only the inheritor so the template is not mutated.
    w.system("move")
      .with(Position)
      .each([Position], (e, [pos]) => {
        if (!e.has(IsA)) {
          return;
        }
        pos.x++;
        e.modified(Position);
      });
    w.progress(0, 0); // enter + first each
    const got = knight.get(Position)!;
    expect(got.x).toBe(6);
    expect(got.y).toBe(7);
    expect(warrior.get(Position)!.x).toBe(5);
  });
});
