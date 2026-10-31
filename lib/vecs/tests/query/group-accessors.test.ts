import { describe, expect, expectTypeOf, it } from "vitest";
import { type Group, World } from "../../src/index.js";

describe("ungrouped accessors", () => {
  it.each(["query", "system"] as const)("rejects every group accessor on a plain %s", (kind) => {
    const world = new World();
    const query = kind === "query" ? world.query("plain") : world.system("plain");
    const accessors = [
      () => query.group(0),
      () => query.groups(),
      () => query.groupKeys(),
      () => query.groupCount,
      () => query.onGroupEnter(() => {}),
      () => query.onGroupExit(() => {}),
    ];
    for (const access of accessors) {
      expect(access).toThrow("query 'plain' is not grouped");
    }
    if (kind === "system") {
      expect(() => query.groupBy([], () => 0)).toThrow(
        "System does not support groupBy; use world.query(...).groupBy(...)"
      );
    }
    world.dispose();
  });

  it("retains typed bucket access and clears grouping on destruction", () => {
    class Team {
      id = 0;
    }
    const world = new World();
    world.component(Team);
    const events: string[] = [];
    const query = world
      .query("teams")
      .with(Team)
      .groupBy([Team], (_e, [team]) => team.id)
      .onGroupEnter((group) => {
        expectTypeOf(group).toEqualTypeOf<Group<number, [typeof Team]>>();
        events.push(`group:${group.key}`);
      })
      .onGroupExit((key, group) => {
        expectTypeOf(key).toEqualTypeOf<number>();
        expectTypeOf(group).toEqualTypeOf<Group<number, [typeof Team]>>();
        events.push(`empty:${key}`);
      })
      .enter(() => events.push("enter"))
      .exit(() => events.push("exit"))
      .build();
    expectTypeOf(query.groups()).toEqualTypeOf<IterableIterator<Group<number, [typeof Team]>>>();
    expectTypeOf(query.groupKeys()).toEqualTypeOf<IterableIterator<number>>();
    expectTypeOf(query.group(0)).toEqualTypeOf<Group<number, [typeof Team]> | undefined>();
    const entity = world.entity().add(Team);
    expect(events).toEqual(["group:0", "enter"]);
    entity.remove(Team);
    expect(events).toEqual(["group:0", "enter", "exit", "empty:0"]);
    entity.add(Team);
    expect(query.groupCount).toBe(1);
    query.destroy();
    query.destroy();
    // Destroying the backing entity also clears its public name.
    expect(() => query.group(0)).toThrow(`query '${query.name}' is not grouped`);
    expect(() => query.groupCount).toThrow(`query '${query.name}' is not grouped`);
    world.dispose();
  });
});
