import { describe, expect, it } from "vitest";
import { type Entity, World } from "../src/index.js";

class Member {}
class Extra {}

describe("live query iteration", () => {
  it.each([false, true])("skips removals and visits additions (composite=%s)", (composite) => {
    const world = new World();
    world.component(Member);
    world.component(Extra);
    const entities = Array.from({ length: 5 }, () => world.entity().add(Member));
    const query = world.query("live").with(Member);
    if (composite) {
      query.without(Extra);
    }
    query.build();
    const seen: Entity[] = [];
    let added: Entity | undefined;
    for (const entity of query) {
      seen.push(entity);
      entity.remove(Member); // current removal must not skip its replacement
      if (seen.length === 1) {
        entities[2]!.remove(Member); // not yet visited
        added = world.entity().add(Member);
      }
      expect(seen.length).toBeLessThan(7);
    }
    expect(new Set(seen)).toEqual(new Set([...entities.filter((_, i) => i !== 2), added]));
    expect(seen).toHaveLength(5);
    expect(query.count).toBe(0);
    world.dispose();
  });

  it("keeps independent nested query cursors during inline membership changes", () => {
    const world = new World();
    world.component(Member);
    const entities = Array.from({ length: 5 }, () => world.entity().add(Member));
    const query = world.query("nested").with(Member).build();
    const outer: Entity[] = [];
    const inner: Entity[] = [];
    for (const entity of query) {
      outer.push(entity);
      if (outer.length === 1) {
        for (const nested of query) {
          inner.push(nested);
          nested.remove(Member);
        }
      }
    }
    expect(outer).toEqual([entities[0]]);
    expect(new Set(inner)).toEqual(new Set(entities));
    expect(inner).toHaveLength(5);
    world.dispose();
  });
});
