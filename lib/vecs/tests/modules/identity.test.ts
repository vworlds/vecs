import { describe, expect, it } from "vitest";
import { Identity, IdentityModule, World } from "../../src/index.js";

describe("IdentityModule", () => {
  it("loads automatically", () => {
    const world = new World();
    const entity = world.entity().set(Identity, { name: "player" });
    const mod = world.module(IdentityModule);

    expect(mod).toBe(world.entity(mod.eid));
    expect(entity.get(Identity)?.name).toBe("player");
  });

  it("backs entity.name with the Identity component", () => {
    const world = new World();
    const entity = world.entity();

    expect(entity.name).toBeUndefined();

    entity.name = "player";

    expect(entity.name).toBe("player");
    expect(entity.get(Identity)?.name).toBe("player");
  });

  it("world.entity('player') returns entity with matching Identity.name", () => {
    const world = new World();
    const entity = world.entity();
    entity.name = "player";

    expect(world.entity("player")).toBe(entity);
  });

  it("world.getEntity('player') returns undefined for missing name", () => {
    const world = new World();

    expect(world.getEntity("nobody")).toBeUndefined();

    const entity = world.entity();
    entity.name = "player";

    expect(world.getEntity("player")).toBe(entity);
  });

  it("renaming removes old name and indexes new name", () => {
    const world = new World();
    const entity = world.entity();
    entity.name = "player";

    expect(world.getEntity("player")).toBe(entity);

    entity.name = "monster";

    expect(world.getEntity("player")).toBeUndefined();
    expect(world.getEntity("monster")).toBe(entity);
  });

  it("removing Identity removes the lookup", () => {
    const world = new World();
    const entity = world.entity();
    entity.name = "player";

    expect(world.getEntity("player")).toBe(entity);

    entity.remove(Identity);

    expect(world.getEntity("player")).toBeUndefined();
  });

  it("destroying entity removes name lookup", () => {
    const world = new World();
    const entity = world.entity();
    entity.name = "player";

    entity.destroy();
    world.flush();

    expect(world.getEntity("player")).toBeUndefined();
  });

  it("duplicate names are last-writer-wins", () => {
    const world = new World();
    const a = world.entity();
    const b = world.entity();

    a.name = "hero";
    b.name = "hero";

    expect(world.entity("hero")).toBe(b);
    expect(world.getEntity("hero")).toBe(b);
  });

  it("removing duplicate from older entity does not delete newer winner", () => {
    const world = new World();
    const a = world.entity();
    const b = world.entity();

    a.name = "hero";
    b.name = "hero";

    a.remove(Identity);

    expect(world.getEntity("hero")).toBe(b);
  });

  it("renaming older duplicate does not delete newer winner", () => {
    const world = new World();
    const a = world.entity();
    const b = world.entity();

    a.name = "hero";
    b.name = "hero";

    a.name = "something-else";

    expect(world.getEntity("hero")).toBe(b);
    expect(world.getEntity("something-else")).toBe(a);
  });

  it("deferred set(Identity, ...) is not visible by name until flush/endDefer", () => {
    const world = new World();
    const entity = world.entity();

    world.defer(() => {
      entity.set(Identity, { name: "player" });

      expect(world.getEntity("player")).toBeUndefined();
    });

    expect(world.getEntity("player")).toBe(entity);
  });

  it("world.component('Name') returns a component entity with that Identity.name", () => {
    const world = new World();
    world.component(Identity); // already registered but name is empty

    const comp = world.component(Identity);
    comp.name = "Id";

    expect(world.component("Id")).toBe(comp);
  });

  it("world.component('Name') throws when name resolves to non-component entity", () => {
    const world = new World();
    const entity = world.entity();
    entity.name = "Bob";

    expect(() => world.component("Bob")).toThrow(/not a component entity/);
  });

  it("world.entity('missing') creates entity with that name", () => {
    const world = new World();
    const entity = world.entity("nobody");

    expect(entity).toBe(world.getEntity("nobody"));
    expect(entity.name).toBe("nobody");
    expect(world.entity("nobody")).toBe(entity);
  });

  it("clearing name to empty string removes lookup", () => {
    const world = new World();
    const entity = world.entity();
    entity.name = "player";

    entity.name = "";

    expect(world.getEntity("player")).toBeUndefined();
  });
});
