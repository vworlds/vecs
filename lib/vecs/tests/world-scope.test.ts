import { describe, expect, it } from "vitest";
import { ChildOf, Entity, Identity, Module, OneOf, Relationship, World } from "../src/index.js";

describe("World.scope", () => {
  it("parents every kind of entity created during a module's init", () => {
    class Position {}
    class Feature extends Module {
      public created: Entity[] = [];
      public init(): void {
        this.created = [
          this.world.component(Position),
          this.world.system("move").entity,
          this.world.query("positions").with(Position).entity,
          this.world.entity(),
          this.world.entity("named"),
          this.world.getOrCreateEntity(5000),
        ];
      }
    }
    const world = new World();
    expect(world.component(Identity).parent).toBeUndefined();
    const feature = world.module(Feature);
    expect(feature.parent).toBeUndefined();
    expect(feature.created.map((entity) => entity.parent)).toEqual(
      feature.created.map(() => feature)
    );
    expect(world.entity().parent).toBeUndefined();
  });

  it("restores nested scopes and application context after exceptions", () => {
    const world = new World();
    const outer = world.entity();
    const inner = world.entity();
    const created: Entity[] = [];
    expect(() =>
      world.scope(outer, () => {
        created.push(world.entity());
        expect(() =>
          world.scope(inner, () => {
            created.push(world.entity());
            throw new Error("inner");
          })
        ).toThrow("inner");
        created.push(world.entity());
        throw new Error("outer");
      })
    ).toThrow("outer");
    expect(created.map((entity) => entity.parent)).toEqual([outer, inner, outer]);
    expect(world.entity().parent).toBeUndefined();
  });

  it("does not reparent existing name/id/component/module lookups", () => {
    class Position {}
    class Existing extends Module {
      public init(): void {}
    }
    const world = new World();
    const existing = [world.entity("existing"), world.component(Position), world.module(Existing)];
    const parent = world.entity();
    world.scope(parent, () => {
      expect(world.entity("existing")).toBe(existing[0]);
      expect(world.getOrCreateEntity(existing[0].eid)).toBe(existing[0]);
      expect(world.component(Position)).toBe(existing[1]);
      expect(world.module(Existing)).toBe(existing[2]);
    });
    expect(existing.map((entity) => entity.parent)).toEqual([undefined, undefined, undefined]);
  });

  it("allows explicit reparenting, including OneOf values, and nearest-module ancestry", () => {
    class Region extends Relationship {}
    class Feature extends Module {
      public value!: Entity;
      public init(): void {
        const region = this.world.component(Region);
        region.add(OneOf, region);
        this.value = this.world.entity().childOf(region);
      }
    }
    const world = new World();
    const feature = world.module(Feature);
    expect(feature.value.parent).toBe(world.component(Region));
    expect(feature.value.parent?.parent).toBe(feature);
    const resident = world.entity().add(Region, feature.value);
    expect(resident.target(Region)).toBe(feature.value);
  });

  it("parents nested modules to their creator and restores the outer scope", () => {
    class Inner extends Module {
      public init(): void {
        this.world.entity("inner");
      }
    }
    class Outer extends Module {
      public init(): void {
        this.world.module(Inner);
        this.world.entity("outer");
      }
    }
    const world = new World();
    const outer = world.module(Outer);
    const inner = world.module(Inner);
    expect(inner.parent).toBe(outer);
    expect(world.entity("inner").parent).toBe(inner);
    expect(world.entity("outer").parent).toBe(outer);
  });

  it("builds queries for components registered inside a deferred module scope", () => {
    class Position {}
    class Feature extends Module {
      public init(): void {
        this.world.component(Position);
        this.world.query("scoped positions").with(Position).track();
        this.world.entity("positioned").add(Position);
      }
    }
    const world = new World();
    world.defer(() => world.module(Feature));
    const module = world.module(Feature);
    const query = world.queries.find((candidate) => candidate.name === "scoped positions")!;
    expect(query.built).toBe(true);
    expect([...query]).toEqual([world.entity("positioned")]);
    expect(query.entity.parent).toBe(module);
    expect(world.component(Position).parent).toBe(module);
  });

  it("clears scoped modules children-first without suspending component policies", () => {
    class Position {}
    class Feature extends Module {
      public init(): void {
        this.world.component(Position);
        this.world.entity("positioned").add(Position);
      }
    }
    const world = new World();
    const module = world.module(Feature);
    const component = world.component(Position);
    const child = world.entity("positioned");
    let removed = 0;
    component.on("remove", () => {
      removed++;
    });
    expect(() => component.destroy()).toThrow("component eid is still in use");
    expect(() => world.clearAllEntities()).not.toThrow();
    expect(removed).toBe(1);
    expect([module, component, child].every((entity) => entity.destroyed)).toBe(true);
    expect(world.entities.values()).toEqual([]);
  });

  it("keeps ordinary destruction and clearAllEntities throwing on combined dependency cycles", () => {
    class Key {}
    class Feature extends Module {
      public init(): void {
        const key = this.world.component(Key);
        this.add(key); // key must follow carrier module, which must follow its child key
      }
    }
    const world = new World();
    const module = world.module(Feature);
    expect(() => world.component(Key).destroy()).toThrow("component eid is still in use");
    expect(() => world.clearAllEntities()).toThrow("dependencies cannot be ordered");
    expect(module.alive).toBe(true);
    expect(world.component(Key).alive).toBe(true);
    // Only dispose's final pass suspends the policies and resolves this cycle.
    expect(() => world.dispose()).not.toThrow();
    expect(world.entities.values()).toEqual([]);
  });

  it("publishes deferred creations with their parent before any observer sees them", () => {
    class Position {}
    class Feature extends Module {
      public init(): void {
        this.world.entity("module-child");
      }
    }
    const world = new World();
    const parent = world.entity();
    const observed: Entity[] = [];
    let collecting = false;
    world
      .query("all new entities")
      .with({ all: [] })
      .enter((entity) => {
        if (!collecting) {
          return;
        }
        observed.push(entity);
        expect(entity.parent).not.toBeUndefined();
      })
      .build();
    collecting = true;
    let created: Entity[] = [];
    world.defer(() => {
      world.scope(parent, () => {
        created = [
          world.entity(),
          world.getOrCreateEntity(5000),
          world.component(Position),
          world.module(Feature),
          world.query("scoped pending query").with(Position).entity,
          world.system("scoped pending system").entity,
        ];
      });
      for (const entity of created) {
        if (entity === world.component(Position) || entity === world.module(Feature)) {
          expect(world.entities.has(entity.eid)).toBe(true);
          expect(entity.parent).toBe(parent);
        } else {
          expect(world.entities.has(entity.eid)).toBe(false);
        }
      }
      expect(observed).toEqual([world.component(Position), world.module(Feature)]);
    });
    expect(created.map((entity) => entity.parent)).toEqual(created.map(() => parent));
    expect(world.entity("module-child").parent).toBe(world.module(Feature));
    expect(observed).toEqual(expect.arrayContaining([...created, world.entity("module-child")]));
  });

  it("never exposes scoped entities as unparented, including synchronous creation", () => {
    const world = new World();
    const parent = world.entity();
    const unparented = world.query("roots").without(ChildOf).track().build();
    const before = unparented.count;
    world.scope(parent, () => world.entity());
    expect(unparented.count).toBe(before);
  });

  it("rejects foreign and destroyed parents without changing the current scope", () => {
    const world = new World();
    const parent = world.entity();
    const foreign = new World().entity();
    const dead = world.entity();
    dead.destroy();
    world.scope(parent, () => {
      expect(() => world.scope(foreign, () => {})).toThrow();
      expect(() => world.scope(dead, () => {})).toThrow();
      expect(world.entity().parent).toBe(parent);
    });
  });
});
