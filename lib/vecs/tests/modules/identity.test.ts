import { describe, expect, it } from "vitest";
import { Identity, IdentityModule, World } from "../../src/index.js";

describe("IdentityModule", () => {
  it("loads automatically", () => {
    const world = new World();
    const entity = world.entity().set(Identity, { name: "player" });

    expect(world.module(IdentityModule)).toBe(
      world.entity(world.getComponentMeta(IdentityModule).eid)
    );
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
