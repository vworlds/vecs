import { expect, it, vi } from "vitest";
import { Query } from "../../src/query/query.js";
import { World } from "../../src/world/index.js";

// Loading a direct query must not require a barrel's grouping registration side effect.
vi.mock("../../src/query/grouped_query.js", () => {
  throw new Error("runtime grouped-query module must not be required");
});

it("groups a directly imported Query without runtime grouping registration", () => {
  class Team {
    id = 0;
  }
  const world = new World();
  world.component(Team);
  const query = new Query("direct", world).with(Team);
  const grouped = query.groupBy([Team], (_e, [team]) => team.id).build();
  const entity = world.entity().set(Team, { id: 7 });
  expect(grouped).toBe(query);
  expect(grouped.group(7)?.has(entity)).toBe(true);
  entity.getMut(Team, (team) => {
    team.id = 8;
  });
  expect(grouped.group(7)).toBeUndefined();
  expect(grouped.group(8)?.has(entity)).toBe(true);
  entity.remove(Team);
  expect(grouped.groupCount).toBe(0);
  grouped.destroy();
  world.dispose();
});
