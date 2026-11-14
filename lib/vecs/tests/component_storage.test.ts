import { describe, expect, it } from "vitest";
import { World } from "../src/world/index.js";
import { Relationship } from "../src/component_meta.js";
import { makeInjectedInvoker } from "../src/inject.js";

describe("shared component storage", () => {
  it("keeps a registered injection lookup live across promotion, replacement and empty demotion", () => {
    class Value {
      n = 1;
    }
    const world = new World();
    world.component(Value);
    const all = Array.from({ length: 200 }, () => world.entity());
    const first = all[0]!;
    first.add(Value);
    const seen: unknown[] = [];
    const invoke = makeInjectedInvoker(world, [Value], false, (_entity, values) => {
      seen.push(values[0]);
    });
    const original = first.get(Value);
    invoke(first);
    all.forEach((entity) => entity.add(Value));
    invoke(first);
    const replacement = new Value();
    first.attach(replacement);
    invoke(first);
    all.forEach((entity) => entity.remove(Value));
    invoke(first);
    first.add(Value);
    invoke(first);
    expect(seen).toEqual([original, original, replacement, undefined, first.get(Value)]);
    expect(seen[2]).toBe(replacement);
    world.dispose();
  });

  it("preserves tail-swap teardown hook order and retained ordinary reads", () => {
    class A {}
    class R extends Relationship {}
    class B {}
    class C {}
    const world = new World();
    const hooks: string[] = [];
    const keys = [A, R, B, C];
    keys.forEach((key) =>
      world.component(key).on("remove", (entity) => {
        hooks.push(key.name);
        expect(entity.get(A)).toBe(a);
        expect(entity.get(B)).toBe(b);
        expect(entity.get(C)).toBe(c);
        if (key !== A) expect(entity.get(R)).toBeUndefined();
      })
    );
    const target = world.entity();
    const entity = world.entity().add(A).add(R, target).add(B).add(C);
    const a = entity.get(A);
    const b = entity.get(B);
    const c = entity.get(C);
    entity.destroy();
    expect(hooks).toEqual(["A", "R", "C", "B"]);
    expect(entity.components.values()).toEqual([]);
    world.dispose();
  });

  it("caches a read-only view and snapshots ids before callbacks and iterator advancement", () => {
    class A {
      value = "a";
    }
    class B {
      value = "b";
    }
    class C {
      value = "c";
    }
    class D {
      value = "d";
    }
    const world = new World();
    [A, B, C, D].forEach((key) => world.component(key));
    const entity = world.entity().add(A).add(B).add(C);
    const view = entity.components;
    expect(entity.components).toBe(view);
    expect("set" in view).toBe(false);
    expect("delete" in view).toBe(false);
    expect("clear" in view).toBe(false);
    const iterator = view.entries();
    entity.remove(B);
    entity.add(D);
    expect([...iterator].map(([id]) => id)).toEqual([world.entity(A).eid, world.entity(C).eid]);
    expect(view.values()).toEqual([entity.get(A), entity.get(C), entity.get(D)]);
    expect([...view].map(([id]) => id)).toEqual([
      world.entity(A).eid,
      world.entity(C).eid,
      world.entity(D).eid,
    ]);
    const seen: number[] = [];
    view.forEach((value, id, third) => {
      expect(third).toBe(view);
      expect(value).toBe(view.get(id));
      seen.push(id);
      entity.remove(id);
      entity.add(B);
    });
    expect(seen).toEqual([world.entity(A).eid, world.entity(C).eid, world.entity(D).eid]);
    expect(view.size).toBe(1);
    expect(view.has(world.entity(B).eid)).toBe(true);
    view.forEachSafe((_value, id, third) => {
      expect(third).toBe(view);
      entity.remove(id);
    });
    expect(view.values()).toEqual([]);
    expect(entity.empty).toBe(true);
    world.dispose();
  });

  it("agrees with entity storage across staging, overwrite, removal and destruction", () => {
    class Value {
      n = 1;
    }
    const world = new World();
    const key = world.component(Value);
    const store = key.meta._term._store;
    key.on("add", (entity, value) => {
      expect(store.get(entity)).toBe(value);
      expect(entity.components.get(key.eid)).toBe(value);
    });
    const all = Array.from({ length: 100 }, () => world.entity().add(Value));
    for (const entity of all) {
      expect(store.get(entity)).toBe(entity.get(Value));
    }
    const replacement = new Value();
    all[0]!.attach(replacement);
    expect(store.get(all[0]!)).toBe(replacement);
    all[1]!.remove(Value);
    expect(store.get(all[1]!)).toBeUndefined();
    all[2]!.destroy();
    expect(store.get(all[2]!)).toBeUndefined();
    expect(store.size).toBe(key.instanceCount());
    world.dispose();
    expect(store.size).toBe(0);
  });
});
