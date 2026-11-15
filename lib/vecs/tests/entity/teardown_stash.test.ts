import { describe, expect, it } from "vitest";
import { World } from "../../src/index.js";

class A {
  n = 1;
}
class B {
  n = 2;
}
class C {
  n = 3;
}

describe("teardown scratch reuse", () => {
  it("uses the exact current shape across shrinking, empty and growing destroys", () => {
    const world = new World();
    const removed: unknown[] = [];
    for (const key of [A, B, C]) {
      world.component(key).on("remove", (entity, instance) => {
        removed.push([entity, instance, entity.get(A), entity.get(B), entity.get(C)]);
      });
    }
    for (const keys of [[A, B, C], [A], [], [B, C], [C, A, B]]) {
      const entity = world.entity();
      keys.forEach((key) => entity.add(key));
      const expected = [entity.get(A), entity.get(B), entity.get(C)];
      removed.length = 0;
      entity.destroy();
      expect(removed).toEqual(
        keys.map((key) => [entity, expected[[A, B, C].indexOf(key)], ...expected])
      );
      for (const key of [A, B, C]) {
        expect(entity.get(key)).toBeUndefined();
        expect(entity.has(key)).toBe(false);
      }
    }
    world.dispose();
  });
});
