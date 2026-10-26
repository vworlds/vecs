import { expect, it } from "vitest";
import { World } from "@vworlds/vecs";
import { componentSchema, validateSet } from "@vworlds/vecs-mcp/schema";
import { Ball } from "../src/demo/modules/balls/components.js";
import { Electron } from "../src/demo/modules/local-offsets/components.js";
import { Player } from "../src/demo/modules/players/components.js";

it("exposes demo core metadata and preserves score validation and MCP-only policy", () => {
  const world = new World();
  world.component(Ball);
  world.component(Electron);
  world.component(Player);
  expect(componentSchema(Ball).schema.properties).toEqual({
    radius: {
      type: "number",
      minimum: 0.01,
      maximum: 5,
      description: "Ball radius at spawn",
      "x-vecs-unit": "m",
    },
  });
  expect(componentSchema(Electron).schema.properties).toMatchObject({
    angle: { type: "number", "x-vecs-unit": "rad" },
    radius: { type: "number" },
    speed: { type: "number", minimum: -1, maximum: 1, "x-vecs-unit": "rad/tick" },
  });
  expect(componentSchema(Player).fields.scoreText).toEqual({
    type: "entity",
    description: "Score label entity",
    optional: true,
    readOnly: true,
  });
  expect(() => validateSet(world, Player, { score: 1000000 }, { score: 1000000 })).not.toThrow();
  expect(() => validateSet(world, Player, { score: 1000001 }, { score: 1000001 })).toThrow(
    "score exceeds demo limit"
  );
  expect(() => validateSet(world, Player, { score: -1 }, { score: -1 })).toThrow(
    "non-negative integer"
  );
  expect(() =>
    validateSet(world, Player, { score: 0, scoreText: undefined }, { scoreText: undefined })
  ).toThrow("readOnly");
  expect(() => validateSet(world, Ball, { radius: 6 }, { radius: 6 })).toThrow(
    "radius: 6 is above the maximum 5"
  );
  world.dispose();
});
