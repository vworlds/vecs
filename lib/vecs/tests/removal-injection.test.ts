import { describe, expect, it } from "vitest";
import { Entity, Implements, Iter, Relationship, World } from "../src/index.js";
import { getInjected, type InjectedValue } from "../src/inject.js";

class A {
  value = 1;
}
class B {
  value = 2;
}
abstract class Alias {
  value = 0;
}
class Link extends Relationship {}

describe("removal injection", () => {
  it("does not read or write the register when neither notification root exists", () => {
    const world = new World();
    const removed: unknown[] = [];
    world.component(A).on("remove", (_e, instance) => removed.push(instance));
    const entity = world.entity().add(A);
    const instance = entity.get(A);
    expect(world._componentTerms.get(world.entity(A).eid)).toBeUndefined();
    expect(world._worldTerm).toBeUndefined();
    for (const field of ["_removedEntity", "_removedCeid", "_removedInstance"]) {
      Object.defineProperty(world, field, {
        get: () => {
          throw new Error(`Unexpected read of ${field}`);
        },
        set: () => {
          throw new Error(`Unexpected write of ${field}`);
        },
      });
    }

    entity.remove(A);

    expect(entity.get(A)).toBeUndefined();
    expect(entity.has(A)).toBe(false);
    expect(removed).toEqual([instance]);
    expect(removed[0]).toBe(instance);
    expect(world.component(A).meta.usageCount).toBe(0);
  });

  it("retains exit injection when only the world term observes a removal", () => {
    const world = new World();
    world.component(A);
    world.component(B);
    const entity = world.entity().add(A).add(B);
    const instance = entity.get(A);
    const seen: unknown[] = [];
    world
      .query("shape-only")
      .with({ not: { only: [B] } })
      .exit([A], (e, [a]) => {
        seen.push(a, e.get(A));
      })
      .build();
    expect(world._componentTerms.get(world.entity(A).eid)).toBeUndefined();
    expect(world._worldTerm).not.toBeUndefined();

    entity.remove(A);

    expect(seen).toEqual([instance, undefined]);
    expect(seen[0]).toBe(instance);
  });

  it("preserves an outer register through a nested unobserved removal hook", () => {
    const world = new World();
    world.component(A);
    const seen: InjectedValue[] = [];
    world.component(B).on("remove", (e) => {
      getInjected(e, [world.entity(A).eid], true, seen);
    });
    const entity = world.entity().add(A).add(B);
    const instance = entity.get(A);
    world
      .query("outer-only")
      .with(A)
      .exit((e) => e.remove(B))
      .build();
    expect(world._componentTerms.get(world.entity(B).eid)).toBeUndefined();
    expect(world._worldTerm).toBeUndefined();

    entity.remove(A);

    expect(seen).toEqual([instance]);
    expect(seen[0]).toBe(instance);
  });

  it("injects the removed instance while live reads and predicates see absence", () => {
    const world = new World();
    world.component(A);
    const entity = world.entity().add(A);
    const instance = entity.get(A);
    const seen: unknown[] = [];
    const absent = world
      .query("absent")
      .with({ test: (e) => !e.get(A), watch: [A] })
      .build();
    world
      .query("exit")
      .with(A)
      .exit([A], (e, [a]) => {
        seen.push(a, e.get(A), e.has(A));
      })
      .build();

    entity.remove(A);

    expect(seen).toEqual([instance, undefined, false]);
    expect(seen[0]).toBe(instance);
    expect(absent.has(entity)).toBe(true);
  });

  it("injects evicted interface aliases and exclusive components", () => {
    const world = new World();
    world.component(Alias);
    world.component(A).set(Implements, { interfaces: [Alias] });
    world.component(B).set(Implements, { interfaces: [Alias] });
    const entity = world.entity().add(A);
    const instance = entity.get(A);
    const seen: unknown[] = [];
    world
      .query("alias")
      .with(Alias)
      .exit([Alias], (e, [alias]) => {
        seen.push(alias, e.get(Alias));
      })
      .build();
    world
      .query("exclusive")
      .with(A)
      .exit([A], (e, [a]) => {
        seen.push(a, e.get(A));
      })
      .build();

    entity.add(B);
    expect(seen).toEqual([instance, undefined, instance, undefined]);
    expect(seen[0]).toBe(instance);
    expect(seen[2]).toBe(instance);
    expect(entity.get(Alias)).toBe(entity.get(B));

    const other = new World();
    other.component(A);
    other.component(B);
    other.setExclusiveComponents(A, B);
    const exclusive = other.entity().add(A);
    const previous = exclusive.get(A);
    const evicted: unknown[] = [];
    other
      .query("exclusive")
      .with(A)
      .exit([A], (e, [a]) => {
        evicted.push(a, e.get(A));
      })
      .build();
    exclusive.add(B);
    expect(evicted).toEqual([previous, undefined]);
    expect(evicted[0]).toBe(previous);
  });

  it("keeps both instances when a remove hook removes another component", () => {
    const world = new World();
    world.component(A).on("remove", (e) => e.remove(B));
    world.component(B);
    const entity = world.entity().add(A).add(B);
    const a = entity.get(A);
    const b = entity.get(B);
    const seen: unknown[] = [];
    world
      .query("a")
      .with(A)
      .exit([A], (_e, [value]) => seen.push(value))
      .build();
    world
      .query("b")
      .with(B)
      .exit([B], (_e, [value]) => seen.push(value))
      .build();

    entity.remove(A);

    expect(seen).toEqual([a, b]);
    expect(seen[0]).toBe(a);
    expect(seen[1]).toBe(b);
    expect(entity.get(A)).toBeUndefined();
    expect(entity.get(B)).toBeUndefined();
  });

  it("restores an outer removal after a nested exit and does not leak it afterward", () => {
    const world = new World();
    world.component(A);
    world.component(B);
    const entity = world.entity().add(A).add(B);
    const a = entity.get(A);
    const b = entity.get(B);
    const seen: unknown[] = [];
    world
      .query("nested")
      .with(A)
      .exit((e) => e.remove(B))
      .build();
    world
      .query("b")
      .with(B)
      .exit([B], (_e, [value]) => seen.push(value))
      .build();
    world
      .query("outer")
      .with(A)
      .exit({ cursor: Iter, inject: [A] }, (it, [value]) => {
        seen.push(value, it.src[0]);
      })
      .build();
    const systemSeen: unknown[] = [];
    world
      .system("snapshot")
      .with(A)
      .exit([A], (_e, [value]) => systemSeen.push(value));
    world.progress(0, 0);

    entity.remove(A);
    world.progress(1, 1);

    expect(seen).toEqual([b, a, entity]);
    expect(systemSeen).toEqual([a]);
    expect(systemSeen[0]).toBe(a);
    expect(() => getInjected(entity, [world.entity(A).eid], true, [])).toThrow(
      "query does not contain component"
    );
  });

  it("injects a detached relationship before its targets are cleared", () => {
    const world = new World();
    world.component(Link);
    const target = world.entity();
    const entity = world.entity().add(Link, target);
    const instance = entity.get(Link);
    const seen: unknown[] = [];
    world
      .query("link")
      .with(Link)
      .exit(
        [Link, { target: [Link, Entity] }, { targets: [Link, Entity] }],
        (e, [link, singular, plural]) => {
          seen.push(link, e.get(Link), singular, plural);
        }
      )
      .build();
    entity.remove(Link, target);
    expect(seen).toEqual([instance, undefined, target, [[target]]]);
    expect(seen[0]).toBe(instance);
    expect(entity.targets(Link)).toEqual([]);
  });

  it("does not inject another entity or component when an exit throws", () => {
    const world = new World();
    world.component(A);
    world.component(B);
    const entity = world.entity().add(A);
    const other = world.entity();
    const aId = world.entity(A).eid;
    const bId = world.entity(B).eid;
    world
      .query("throw")
      .with(A)
      .exit(() => {
        expect(() => getInjected(other, [aId], true, [])).toThrow(
          "query does not contain component"
        );
        expect(() => getInjected(entity, [bId], true, [])).toThrow(
          "query does not contain component"
        );
        throw new Error("exit failed");
      })
      .build();

    expect(() => entity.remove(A)).toThrow("exit failed");
    expect(entity.get(A)).toBeUndefined();
  });

  it("retains destroy-time storage for exit injection and remove hooks", () => {
    const world = new World();
    const seen: unknown[] = [];
    world.component(A).on("remove", (e, a) => seen.push(a, e.get(A)));
    const entity = world.entity().add(A);
    const instance = entity.get(A);
    world
      .query("destroy")
      .with(A)
      .exit([A], (_e, [a]) => seen.push(a))
      .build();

    entity.destroy();

    expect(seen).toEqual([instance, instance, instance]);
  });

  it("preserves plural relationship snapshots when the relationship or target component leaves", () => {
    const world = new World();
    world.component(A);
    world.component(Link);
    const target = world.entity().add(A);
    const source = world.entity().add(Link, target);
    const a = target.get(A);
    const seen: unknown[] = [];
    world
      .system("relationship snapshot")
      .with(Link)
      .exit([{ targets: [Link, [A]] }], (_e, [rows]) => seen.push(rows));
    world
      .system("target snapshot")
      .with({ target: [Link, A] })
      .exit([{ targets: [Link, [A]] }], (_e, [rows]) => seen.push(rows));
    world.progress(0, 0);

    target.remove(A);
    source.remove(Link);
    world.progress(1, 1);

    expect(seen).toEqual([[[undefined]], [[a]]]);
  });
});
