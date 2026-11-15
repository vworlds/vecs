import { describe, expect, it } from "vitest";
import { Entity, Iter, World } from "../src/index.js";
import { makeInjectedInvoker, type InjectedValue } from "../src/inject.js";

class A {
  value = 1;
}
class B {
  value = 2;
}
class C {
  value = 3;
}
class D {
  value = 4;
}

describe("direct injected invokers", () => {
  it.each([1, 2, 3, 4].flatMap((arity) => [false, true].map((cursor) => [arity, cursor] as const)))(
    "preserves values and reused tuples at arity %i (Iter %s)",
    (arity, cursor) => {
      const world = new World();
      const keys = [A, B, C, D].slice(0, arity);
      keys.forEach((key) => world.component(key));
      const entities = [world.entity(), world.entity()];
      entities.forEach((entity) => keys.forEach((key) => entity.add(key)));
      let tuple: readonly InjectedValue[] | undefined;
      let previousCursor: Entity | Iter | undefined;
      let calls = 0;
      const invoke = makeInjectedInvoker(world, keys, cursor, (current, values) => {
        const entity = entities[calls]!;
        expect(values).toEqual(keys.map((key) => entity.get(key)));
        if (tuple !== undefined) {
          expect(values).toBe(tuple);
        }
        tuple = values;
        if (cursor) {
          expect(current).toBeInstanceOf(Iter);
          expect((current as Iter).entity).toBe(entity);
          expect((current as Iter).src).toEqual(keys.map(() => entity));
          if (previousCursor !== undefined) {
            expect(current).toBe(previousCursor);
          }
        } else {
          expect(current).toBe(entity);
        }
        previousCursor = current;
        calls++;
      });
      entities.forEach(invoke);
      expect(calls).toBe(2);
      world.dispose();
    }
  );

  it("reads the current store after promotion, density demotion, emptying and refill", () => {
    const world = new World();
    world.component(A);
    const first = world.getOrCreateEntity(10000).add(A);
    const seen: unknown[] = [];
    const invoke = makeInjectedInvoker(world, [A], false, (_e, values) => seen.push(values[0]));
    const original = first.get(A);
    invoke(first);
    const others = Array.from({ length: 1600 }, (_, i) =>
      world.getOrCreateEntity(10001 + i).add(A)
    );
    invoke(first);
    const distant = world.getOrCreateEntity(100000).add(A);
    invoke(first);
    first.remove(A);
    others.forEach((entity) => entity.remove(A));
    distant.remove(A);
    invoke(first);
    first.add(A);
    const replacement = first.get(A);
    invoke(first);
    expect(seen).toEqual([original, original, original, undefined, replacement]);
    expect(replacement).not.toBe(original);
    world.dispose();
  });

  it.each(["remove", "destroy"] as const)(
    "retains optional injection during synchronous %s",
    (action) => {
      const world = new World();
      world.component(A);
      world.component(B);
      const entity = world.entity().add(A).add(B);
      const a = entity.get(A);
      const b = entity.get(B);
      const seen: unknown[] = [];
      const invoke = makeInjectedInvoker(world, [A, B], true, (cursor, values) => {
        seen.push(...values, ...(cursor as Iter).src);
      });
      world.query("retained optional").with(A).exit(invoke).build();
      if (action === "remove") {
        entity.remove(A);
      } else {
        entity.destroy();
      }
      expect(seen).toEqual([a, b, entity, entity]);
      world.dispose();
    }
  );
});
