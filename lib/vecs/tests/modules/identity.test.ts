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
});
