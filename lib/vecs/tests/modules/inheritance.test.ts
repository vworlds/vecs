import { describe, expect, it, vi } from "vitest";
import {
  DontInherit,
  Implements,
  Inherit,
  IsA,
  OnInstantiate,
  Override,
  Singleton,
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
class Position {
  x = 0;
  y = 0;
}

function setupSpecWorld(): World {
  const world = new World();
  world.component(Helmet).add(OnInstantiate, Inherit);
  world.component(Sword).add(OnInstantiate, Override);
  world.component(Faction).add(OnInstantiate, DontInherit);
  world.component(Horse);
  return world;
}

describe("IsA entity inheritance", () => {
  it("instantiates the template per component policy (spec example)", () => {
    const world = setupSpecWorld();
    const warrior = world
      .entity()
      .set(Helmet, { armor: 3 })
      .set(Sword, { damage: 10 })
      .set(Faction, { team: 1 });
    const knight = world.entity().add(IsA, warrior).add(Horse);

    expect(warrior.has(Horse)).toBe(false);
    expect(warrior.has(Faction)).toBe(true);
    expect(knight.has(Helmet)).toBe(true);
    expect(knight.has(Sword)).toBe(true);
    expect(knight.has(Horse)).toBe(true);
    expect(knight.has(Faction)).toBe(false);
    expect(knight.get(Helmet)?.armor).toBe(3);
    expect(knight.get(Sword)?.damage).toBe(10);
  });

  it("stores plain instances of the component class on the inheritor", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const knight = world.entity().add(IsA, warrior);

    const helmet = knight.get(Helmet);
    expect(helmet).toBeInstanceOf(Helmet);
    expect(helmet?.constructor).toBe(Helmet);
    expect(helmet).not.toBe(warrior.get(Helmet));
  });

  it("defaults to Override when no OnInstantiate edge is present", () => {
    const world = new World();
    world.component(Horse);
    const template = world.entity().set(Horse, { speed: 7 });
    const e = world.entity().add(IsA, template);

    expect(e.get(Horse)?.speed).toBe(7);
    template.set(Horse, { speed: 99 });
    expect(e.get(Horse)?.speed).toBe(7);
  });

  it("keeps Override copies independent in both directions", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Sword, { damage: 10 });
    const knight = world.entity().add(IsA, warrior);

    knight.set(Sword, { damage: 42 });
    expect(warrior.get(Sword)?.damage).toBe(10);
    warrior.set(Sword, { damage: 5 });
    expect(knight.get(Sword)?.damage).toBe(42);
  });

  it("exposes the template through target() and the inheritors through children()", () => {
    const world = setupSpecWorld();
    const warrior = world.entity();
    const knight = world.entity().add(IsA, warrior);

    expect(knight.target(IsA)).toBe(warrior);
    expect(warrior.children(IsA).has(knight)).toBe(true);
  });

  it("re-adds the same template as an idempotent no-op", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const knight = world.entity().add(IsA, warrior);
    knight.set(Helmet, { armor: 9 });

    knight.add(IsA, warrior);

    expect(knight.get(Helmet)?.armor).toBe(9);
  });

  it("prefers the inheritor's own component over the template's", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 }).set(Sword, { damage: 10 });
    const knight = world.entity().set(Helmet, { armor: 8 }).add(IsA, warrior);

    expect(knight.get(Helmet)?.armor).toBe(8);
    expect(knight.get(Sword)?.damage).toBe(10);
    warrior.set(Helmet, { armor: 5 });
    expect(knight.get(Helmet)?.armor).toBe(8);
  });
});

describe("IsA live mirroring (Inherit)", () => {
  it("propagates template value changes until the inheritor diverges", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const knight = world.entity().add(IsA, warrior);

    warrior.set(Helmet, { armor: 5 });
    expect(knight.get(Helmet)?.armor).toBe(5);

    knight.set(Helmet, { armor: 7 });
    expect(warrior.get(Helmet)?.armor).toBe(5);
    expect(knight.get(Helmet)?.armor).toBe(7);

    warrior.set(Helmet, { armor: 9 });
    expect(knight.get(Helmet)?.armor).toBe(7);
  });

  it("diverges per component, keeping the others mirrored", () => {
    const world = new World();
    world.component(Helmet).add(OnInstantiate, Inherit);
    world.component(Position).add(OnInstantiate, Inherit);
    const template = world.entity().set(Helmet, { armor: 3 }).set(Position, { x: 1, y: 2 });
    const e = world.entity().add(IsA, template);

    e.set(Helmet, { armor: 7 });
    template.set(Helmet, { armor: 4 });
    template.set(Position, { x: 10, y: 20 });

    expect(e.get(Helmet)?.armor).toBe(7);
    expect(e.get(Position)).toMatchObject({ x: 10, y: 20 });
  });

  it("propagates getMut mutations on the template", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const knight = world.entity().add(IsA, warrior);

    warrior.getMut(Helmet, (h) => {
      h.armor = 11;
    });

    expect(knight.get(Helmet)?.armor).toBe(11);
  });

  it("propagates a later addition on the template to inheritors", () => {
    const world = setupSpecWorld();
    const warrior = world.entity();
    const knight = world.entity().add(IsA, warrior);

    warrior.set(Helmet, { armor: 6 });

    expect(knight.has(Helmet)).toBe(true);
    expect(knight.get(Helmet)?.armor).toBe(6);
    warrior.set(Helmet, { armor: 7 });
    expect(knight.get(Helmet)?.armor).toBe(7);
  });

  it("does not clobber an inheritor's own component on a later template addition", () => {
    const world = setupSpecWorld();
    const warrior = world.entity();
    const knight = world.entity().add(IsA, warrior).set(Helmet, { armor: 8 });

    warrior.set(Helmet, { armor: 6 });

    expect(knight.get(Helmet)?.armor).toBe(8);
  });

  it("does not propagate later Override additions or changes", () => {
    const world = setupSpecWorld();
    const warrior = world.entity();
    const knight = world.entity().add(IsA, warrior);

    warrior.set(Sword, { damage: 10 });

    expect(knight.has(Sword)).toBe(false);
  });

  it("removes a mirrored component from inheritors when the template removes it", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const knight = world.entity().add(IsA, warrior);

    warrior.remove(Helmet);

    expect(knight.has(Helmet)).toBe(false);
  });

  it("keeps a diverged component when the template removes it", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const knight = world.entity().add(IsA, warrior);
    knight.set(Helmet, { armor: 7 });

    warrior.remove(Helmet);

    expect(knight.get(Helmet)?.armor).toBe(7);
  });

  it("supports attach on the template without dangling state", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const knight = world.entity().add(IsA, warrior);

    const replacement = new Helmet();
    replacement.armor = 21;
    warrior.attach(replacement);

    expect(knight.get(Helmet)?.armor).toBe(21);
    expect(knight.get(Helmet)).not.toBe(replacement);
  });

  it("mirrors to every inheritor of the same template", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const a = world.entity().add(IsA, warrior);
    const b = world.entity().add(IsA, warrior);

    warrior.set(Helmet, { armor: 5 });

    expect(a.get(Helmet)?.armor).toBe(5);
    expect(b.get(Helmet)?.armor).toBe(5);
  });

  it("fires user set hooks and update queries on propagated changes", () => {
    const world = setupSpecWorld();
    const onSet = vi.fn();
    world.component(Helmet).on("set", onSet);
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const knight = world.entity().add(IsA, warrior);
    const update = vi.fn();
    world.query("watch").with(Helmet).update(Helmet, update).build();

    onSet.mockClear();
    warrior.set(Helmet, { armor: 5 });

    const setEntities = onSet.mock.calls.map((call) => call[0]);
    expect(setEntities).toContain(warrior);
    expect(setEntities).toContain(knight);
    const updatedEntities = update.mock.calls.map((call) => call[0]);
    expect(updatedEntities).toContain(knight);
  });
});

describe("IsA chains", () => {
  it("mirrors through multiple IsA layers", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const unit = world.entity().set(Position, { x: 5, y: 7 });
    const warrior = world.entity().add(IsA, unit);
    const knight = world.entity().add(IsA, warrior);

    expect(knight.get(Position)).toMatchObject({ x: 5, y: 7 });

    unit.set(Position, { x: 1, y: 1 });
    expect(warrior.get(Position)).toMatchObject({ x: 1, y: 1 });
    expect(knight.get(Position)).toMatchObject({ x: 1, y: 1 });
  });

  it("isolates the tail of a chain when the middle diverges", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const unit = world.entity().set(Position, { x: 5, y: 7 });
    const warrior = world.entity().add(IsA, unit);
    const knight = world.entity().add(IsA, warrior);

    warrior.set(Position, { x: 100, y: 100 });
    expect(knight.get(Position)).toMatchObject({ x: 100, y: 100 });

    unit.set(Position, { x: 2, y: 2 });
    expect(warrior.get(Position)).toMatchObject({ x: 100, y: 100 });
    expect(knight.get(Position)).toMatchObject({ x: 100, y: 100 });

    warrior.set(Position, { x: 200, y: 200 });
    expect(knight.get(Position)).toMatchObject({ x: 200, y: 200 });
  });

  it("cascades a template's own new IsA edge down to existing inheritors", () => {
    const world = new World();
    world.component(Position).add(OnInstantiate, Inherit);
    const unit = world.entity().set(Position, { x: 5, y: 7 });
    const warrior = world.entity();
    const knight = world.entity().add(IsA, warrior);

    warrior.add(IsA, unit);

    expect(knight.get(Position)).toMatchObject({ x: 5, y: 7 });
    unit.set(Position, { x: 9, y: 9 });
    expect(knight.get(Position)).toMatchObject({ x: 9, y: 9 });
  });

  it("terminates on cyclic IsA edges", () => {
    const world = new World();
    world.component(Helmet).add(OnInstantiate, Inherit);
    const a = world.entity().set(Helmet, { armor: 1 });
    const b = world.entity().add(IsA, a);
    a.add(IsA, b);

    a.set(Helmet, { armor: 2 });

    expect(b.get(Helmet)?.armor).toBe(2);
  });
});

describe("IsA retargeting and removal", () => {
  it("retargets by shedding mirrored components and instantiating the new template", () => {
    const world = setupSpecWorld();
    world.component(Position);
    const warrior = world.entity().set(Helmet, { armor: 3 }).set(Sword, { damage: 10 });
    const mage = world.entity().set(Helmet, { armor: 1 }).set(Position, { x: 4, y: 4 });
    const e = world.entity().add(IsA, warrior);

    e.add(IsA, mage);

    expect(e.target(IsA)).toBe(mage);
    expect(e.get(Helmet)?.armor).toBe(1);
    expect(e.has(Position)).toBe(true);
    // The Override copy from the old template is an own component and stays.
    expect(e.get(Sword)?.damage).toBe(10);
    mage.set(Helmet, { armor: 2 });
    expect(e.get(Helmet)?.armor).toBe(2);
    warrior.set(Helmet, { armor: 9 });
    expect(e.get(Helmet)?.armor).toBe(2);
  });

  it("keeps diverged components across a retarget", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const mage = world.entity();
    const e = world.entity().add(IsA, warrior);
    e.set(Helmet, { armor: 7 });

    e.add(IsA, mage);

    expect(e.get(Helmet)?.armor).toBe(7);
  });

  it("sheds retargeted components from the whole chain below", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const mage = world.entity();
    const e = world.entity().add(IsA, warrior);
    const follower = world.entity().add(IsA, e);
    expect(follower.has(Helmet)).toBe(true);

    e.add(IsA, mage);

    expect(e.has(Helmet)).toBe(false);
    expect(follower.has(Helmet)).toBe(false);
  });

  it("re-mirrors the whole chain from the new template", () => {
    const world = setupSpecWorld();
    const t1 = world.entity().set(Helmet, { armor: 1 });
    const t2 = world.entity().set(Helmet, { armor: 2 });
    const e = world.entity().add(IsA, t1);
    const follower = world.entity().add(IsA, e);

    e.add(IsA, t2);

    expect(e.get(Helmet)?.armor).toBe(2);
    expect(follower.get(Helmet)?.armor).toBe(2);
    t2.set(Helmet, { armor: 5 });
    expect(follower.get(Helmet)?.armor).toBe(5);
    t1.set(Helmet, { armor: 9 });
    expect(e.get(Helmet)?.armor).toBe(5);
  });

  it("keeps inherited components as own copies when the edge is removed", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 }).set(Sword, { damage: 10 });
    const knight = world.entity().add(IsA, warrior);

    knight.remove(IsA);

    expect(knight.get(Helmet)?.armor).toBe(3);
    expect(knight.get(Sword)?.damage).toBe(10);
    warrior.set(Helmet, { armor: 9 });
    expect(knight.get(Helmet)?.armor).toBe(3);
  });

  it("keeps inherited components with their last values when the template is destroyed", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const knight = world.entity().add(IsA, warrior);
    warrior.set(Helmet, { armor: 5 });

    warrior.destroy();

    expect(knight.has(IsA)).toBe(false);
    expect(knight.get(Helmet)?.armor).toBe(5);
    knight.set(Helmet, { armor: 6 });
    expect(knight.get(Helmet)?.armor).toBe(6);
  });

  it("tears down a world with live IsA edges", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    world.entity().add(IsA, warrior);
    world.entity().add(IsA, warrior);

    expect(() => world.clearAllEntities()).not.toThrow();
  });
});

describe("IsA in deferred mode", () => {
  it("instantiates the template when the queued edge is applied", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const knight = world.entity();

    world.defer(() => {
      knight.add(IsA, warrior);
      expect(knight.has(Helmet)).toBe(false);
    });

    expect(knight.get(Helmet)?.armor).toBe(3);
  });

  it("propagates template mutations made inside systems", () => {
    const world = setupSpecWorld();
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const knight = world.entity().add(IsA, warrior);
    world
      .system("harden")
      .with(Helmet)
      .each([Helmet], (e, [helmet]) => {
        if (e !== warrior) {
          return;
        }
        helmet.armor += 10;
        e.modified(Helmet);
      });

    world.progress(0, 0);

    expect(warrior.get(Helmet)?.armor).toBe(13);
    expect(knight.get(Helmet)?.armor).toBe(13);
  });
});

describe("OnInstantiate policy configuration", () => {
  it("rejects targets that are not policy options", () => {
    const world = new World();
    const notAnOption = world.entity();

    expect(() => world.component(Helmet).add(OnInstantiate, notAnOption)).toThrow("OneOf");
  });

  it("stops live mirroring when a component is switched away from Inherit", () => {
    const world = new World();
    world.component(Helmet).add(OnInstantiate, Inherit);
    const warrior = world.entity().set(Helmet, { armor: 3 });
    const knight = world.entity().add(IsA, warrior);

    world.component(Helmet).add(OnInstantiate, Override);
    warrior.set(Helmet, { armor: 9 });

    expect(knight.get(Helmet)?.armor).toBe(3);
  });

  it("applies a policy switch to future IsA edges", () => {
    const world = new World();
    world.component(Helmet).add(OnInstantiate, Override);
    const warrior = world.entity().set(Helmet, { armor: 3 });
    world.component(Helmet).add(OnInstantiate, Inherit);

    const knight = world.entity().add(IsA, warrior);
    warrior.set(Helmet, { armor: 5 });

    expect(knight.get(Helmet)?.armor).toBe(5);
  });
});

describe("IsA instantiation skips", () => {
  it("skips singleton components and the Singleton marker itself", () => {
    const world = new World();
    class Gravity {
      g = 9.8;
    }
    // The singleton instance lives on the component entity itself, so that
    // entity is the only possible template carrying a singleton component.
    const template = world.component(Gravity).add(Singleton);
    const e = world.entity().add(IsA, template);

    expect(e.has(Gravity)).toBe(false);
    expect(e.has(Singleton)).toBe(false);
  });

  it("skips relationships and does not inherit the IsA edge itself", () => {
    const world = setupSpecWorld();
    const grandTemplate = world.entity();
    const warrior = world.entity().add(IsA, grandTemplate);
    const parent = world.entity();
    warrior.childOf(parent);
    const knight = world.entity().add(IsA, warrior);

    expect(knight.target(IsA)).toBe(warrior);
    expect(knight.parent).toBeUndefined();
  });

  it("attaches interface-implementing components once, with aliases intact", () => {
    const world = new World();
    abstract class Wearable {
      weight = 0;
    }
    class Armor extends Wearable {
      protection = 5;
      weight = 12;
    }
    world.component(Wearable);
    world.component(Armor).set(Implements, { interfaces: [Wearable] });
    const template = world.entity().set(Armor, { protection: 7 });
    const e = world.entity().add(IsA, template);

    expect(e.get(Armor)?.protection).toBe(7);
    expect(e.get(Wearable)).toBe(e.get(Armor));
    // Exactly IsA + Armor + the Wearable alias — no duplicate attach through the alias eid.
    expect(e.components.size).toBe(3);
  });
});
