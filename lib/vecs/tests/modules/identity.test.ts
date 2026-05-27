import { describe, expect, it } from "vitest";
import { Entity, Identity, IdentityModule, World } from "../../src/index.js";

describe("IdentityModule", () => {
  it("loads automatically", () => {
    const world = new World();
    const entity = world.entity().set(Identity, { name: "player" });
    const mod = world.module(IdentityModule);

    expect(mod).toBe(world.entity(mod.eid));
    expect(mod).toBeInstanceOf(Entity);
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
});
