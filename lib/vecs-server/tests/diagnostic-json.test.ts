import { expect, it } from "vitest";
import { ServerWorld } from "../src/index.js";

it("includes the configured server name without traversing server state", () => {
  const world = new ServerWorld({ name: "arena" });
  expect(world.toJSON()).toEqual({
    world: "ServerWorld",
    entities: world.entities.size,
    name: "arena",
  });
  expect(JSON.parse(JSON.stringify(world))).toEqual(world.toJSON());
  world.dispose();
  expect(world.toJSON()).toEqual({ world: "ServerWorld", entities: 0, name: "arena" });
});
