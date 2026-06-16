import { describe, expect, it, vi } from "vitest";
import { Implements, Relationship, World } from "../src/index.js";

abstract class Food {
  calories = 0;
}

abstract class Fruit extends Food {
  color = "";
}

abstract class Foreign {
  importCost = 0;
}

class Orange extends Fruit implements Foreign {
  acidity = 8;
  color = "orange";
  calories = 4;
  importCost = 15;
}

class Apple extends Fruit {
  color = "red";
  calories = 3;
}

class FriendOf extends Relationship {}

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

function assertType<T extends true>(): void {}

function setup(): World {
  const world = new World();
  world.component(Food);
  world.component(Fruit).set(Implements, { interfaces: [Food] });
  world.component(Foreign);
  world.component(Orange).set(Implements, { interfaces: [Fruit, Foreign] });
  return world;
}

describe("Implements", () => {
  it("queries via a direct interface", () => {
    const world = setup();
    const query = world.query("fruit").with(Fruit).build();
    const entity = world.entity("cheapOrange").set(Orange, { importCost: 1 });

    expect(query.has(entity)).toBe(true);
  });

  it("queries via a transitive parent", () => {
    const world = setup();
    const query = world.query("foods").with(Food).build();
    const entity = world.entity("cheapOrange").set(Orange, { calories: 7 });

    expect(query.has(entity)).toBe(true);
  });

  it("stores the same instance under every alias", () => {
    const world = setup();
    const entity = world.entity("cheapOrange").set(Orange, { importCost: 1, calories: 7 });

    expect(entity.get(Food)).toBe(entity.get(Orange));
    expect(entity.get(Fruit)).toBe(entity.get(Orange));
    expect(entity.get(Foreign)).toBe(entity.get(Orange));
  });

  it("injects concrete data through an interface ref", () => {
    const world = setup();
    const entity = world.entity("cheapOrange").set(Orange, { calories: 7 });
    const foods: Food[] = [];

    world
      .query("foods")
      .with(Food)
      .build()
      .forEach([Food], (_entity, [food]) => foods.push(food));

    expect(foods).toEqual([entity.get(Orange)]);
    expect(foods[0].calories).toBe(7);
  });

  it("removing the concrete removes all aliases", () => {
    const world = setup();
    const entity = world.entity("cheapOrange").set(Orange, {});

    entity.remove(Orange);

    expect(entity.has(Orange)).toBe(false);
    expect(entity.has(Fruit)).toBe(false);
    expect(entity.has(Food)).toBe(false);
    expect(entity.has(Foreign)).toBe(false);
  });

  it("modified on a concrete component notifies parent hooks and update watchers", () => {
    const world = setup();
    const entity = world.entity("cheapOrange").set(Orange, {});
    const orange = entity.get(Orange)!;
    const onSet = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const update = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];

    world.component(Orange).onSet(onSet[0]);
    world.component(Fruit).onSet(onSet[1]);
    world.component(Food).onSet(onSet[2]);
    world.component(Foreign).onSet(onSet[3]);
    world
      .query("orange-updates")
      .with(Orange)
      .update({ watch: Orange, enter: true }, update[0])
      .build();
    world
      .query("fruit-updates")
      .with(Fruit)
      .update({ watch: Fruit, enter: true }, update[1])
      .build();
    world.query("food-updates").with(Food).update({ watch: Food, enter: true }, update[2]).build();
    world
      .query("Foreign-updates")
      .with(Foreign)
      .update({ watch: Foreign, enter: true }, update[3])
      .build();
    update.forEach((fn) => fn.mockClear());

    entity.modified(Orange);

    onSet.forEach((fn) => expect(fn).toHaveBeenCalledWith(entity, orange));
    update.forEach((fn) => expect(fn).toHaveBeenCalledWith(entity, orange));
  });

  it("keeps alias visibility deferred until flush", () => {
    const world = setup();
    const entity = world.entity("cheapOrange");

    world.beginDefer();
    entity.set(Orange, { calories: 7 });
    expect(entity.has(Food)).toBe(false);
    expect(entity.get(Food)).toBeUndefined();
    world.endDefer();
    expect(entity.has(Food)).toBe(true);

    world.beginDefer();
    entity.remove(Orange);
    expect(entity.has(Food)).toBe(true);
    world.endDefer();
    expect(entity.has(Food)).toBe(false);
  });

  it("evicts an existing implementer and aliases when a second implementer is set", () => {
    const world = setup();
    world.component(Apple).set(Implements, { interfaces: [Fruit] });
    const entity = world.entity("snack").set(Orange, { calories: 7 });

    entity.set(Apple, { calories: 2 });

    expect(entity.has(Orange)).toBe(false);
    expect(entity.has(Apple)).toBe(true);
    expect(entity.get(Food)).toBe(entity.get(Apple));
    expect(entity.get(Fruit)).toBe(entity.get(Apple));
    expect(entity.get(Food)?.calories).toBe(2);
  });

  it("throws on cyclic interface declarations", () => {
    abstract class A {}
    abstract class B {}
    const world = new World();

    world.component(A);
    world.component(B);
    world.component(A).set(Implements, { interfaces: [B] });

    expect(() => {
      world.component(B).set(Implements, { interfaces: [A] });
    }).toThrow("Cyclic Implements declaration: A -> B -> A");
  });

  it("allows abstract parents in query refs and injection types", () => {
    const world = setup();
    const entity = world.entity("cheapOrange").set(Orange, { calories: 7 });

    if (false) {
      world
        .query("typed-foods")
        .with(Food)
        .forEach([Food], (_entity, [food]) => {
          assertType<IsEqual<typeof food, Food>>();
        });
    }

    const injected: Food[] = [];
    world.filter([Food]).forEach([Food], (_entity, [food]) => injected.push(food));

    expect(injected).toEqual([entity.get(Orange)]);
  });

  it("throws when mutating through an interface alias", () => {
    const world = setup();
    const entity = world.entity("cheapOrange").set(Orange, {});

    expect(() => entity.remove(Food)).toThrow(
      "Cannot remove the abstract interface Food; operate via the concrete component"
    );
    expect(() => entity.modified(Food)).toThrow(
      "Cannot modify the abstract interface Food; operate via the concrete component"
    );
    expect(() => entity.getMut(Food, () => {})).toThrow(
      "Cannot getMut the abstract interface Food; operate via the concrete component"
    );
    expect(() => entity.attach(Food, entity.get(Orange)! as Orange)).toThrow(
      "Cannot attach the abstract interface Food; operate via the concrete component"
    );
  });

  it("rejects relationships as implementers and interfaces", () => {
    const implementerWorld = new World();
    implementerWorld.component(Food);
    implementerWorld.component(FriendOf);

    expect(() => {
      implementerWorld.component(FriendOf).set(Implements, { interfaces: [Food] });
    }).toThrow("Relationship FriendOf cannot implement interfaces");

    const interfaceWorld = new World();
    interfaceWorld.component(FriendOf);
    interfaceWorld.component(Orange);

    expect(() => {
      interfaceWorld.component(Orange).set(Implements, { interfaces: [FriendOf] });
    }).toThrow("Relationship FriendOf cannot be an interface");
  });

  it("survives teardown that destroys an interface still referenced by another implementer", () => {
    abstract class Iface {}
    class ImplA {}
    class ImplB {}
    const world = new World();
    world.component(Iface);
    world.component(ImplA).set(Implements, { interfaces: [Iface] });
    world.component(ImplB).set(Implements, { interfaces: [Iface] });

    // Destroy the interface component entity, then an implementer: removing the
    // implementer triggers a recompute while ImplB still references the now-gone
    // Iface, which must not throw "unregistered component entity".
    world.component(Iface).destroy();

    expect(() => world.component(ImplA).destroy()).not.toThrow();
  });

  it("expands aliases when attaching a concrete instance", () => {
    const world = setup();
    const orange = new Orange();
    orange.calories = 7;

    const entity = world.entity("cheapOrange").attach(orange);

    expect(entity.get(Orange)).toBe(orange);
    expect(entity.get(Fruit)).toBe(orange);
    expect(entity.get(Food)).toBe(orange);
    expect(entity.get(Foreign)).toBe(orange);

    const foods: Food[] = [];
    world.filter([Food]).forEach([Food], (_entity, [food]) => foods.push(food));
    expect(foods).toEqual([orange]);
    expect(foods[0].calories).toBe(7);
  });

  it("evicts a prior implementer when attaching a second implementer", () => {
    const world = setup();
    world.component(Apple).set(Implements, { interfaces: [Fruit] });
    const entity = world.entity("snack").attach(new Orange());

    const apple = new Apple();
    apple.calories = 2;
    entity.attach(apple);

    expect(entity.has(Orange)).toBe(false);
    expect(entity.has(Apple)).toBe(true);
    expect(entity.get(Fruit)).toBe(apple);
    expect(entity.get(Food)).toBe(apple);
    expect(entity.get(Food)?.calories).toBe(2);
  });

  it("fires parent onAdd and onRemove hooks for interface aliases", () => {
    const world = setup();
    const onAdd = { fruit: vi.fn(), food: vi.fn(), Foreign: vi.fn() };
    const onRemove = { fruit: vi.fn(), food: vi.fn(), Foreign: vi.fn() };

    world.component(Fruit).onAdd(onAdd.fruit);
    world.component(Food).onAdd(onAdd.food);
    world.component(Foreign).onAdd(onAdd.Foreign);
    world.component(Fruit).onRemove(onRemove.fruit);
    world.component(Food).onRemove(onRemove.food);
    world.component(Foreign).onRemove(onRemove.Foreign);

    const entity = world.entity("cheapOrange").set(Orange, {});
    const orange = entity.get(Orange)!;

    expect(onAdd.fruit).toHaveBeenCalledWith(entity, orange);
    expect(onAdd.food).toHaveBeenCalledWith(entity, orange);
    expect(onAdd.Foreign).toHaveBeenCalledWith(entity, orange);

    entity.remove(Orange);

    expect(onRemove.fruit).toHaveBeenCalledWith(entity, orange);
    expect(onRemove.food).toHaveBeenCalledWith(entity, orange);
    expect(onRemove.Foreign).toHaveBeenCalledWith(entity, orange);
  });
});
