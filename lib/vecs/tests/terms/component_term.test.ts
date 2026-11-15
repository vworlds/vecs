import { describe, expect, it } from "vitest";
import { type Entity, Implements, Relationship, TermEventKind, World } from "../../src/index.js";

describe("ComponentTerm bitmask membership", () => {
  it.each(["component", "relationship"] as const)(
    "clears a discarded %s after an add hook interrupts destruction",
    (kind) => {
      class Earlier {}
      class Staged {}
      class Linked extends Relationship {}
      const world = new World();
      world.component(Earlier).on("remove", () => {
        throw new Error("interrupted teardown");
      });
      const key = world.component(kind === "component" ? Staged : Linked);
      key.on("add", (entity) => entity.destroy());
      const entity = world.entity().add(Earlier);
      const target = world.entity();
      const term = key.meta._term;
      const resyncs: boolean[][] = [];
      term.subscribe({
        _resyncsOnEvent: true,
        onTermEvent(kind, entity) {
          expect(kind).toBe(TermEventKind.Exit);
          resyncs.push([entity.has(key), term.has(entity), term._store.has(entity)]);
        },
      });

      expect(() => (kind === "component" ? entity.add(key) : entity.add(key, target))).toThrow(
        "interrupted teardown"
      );
      expect(entity.alive).toBe(false);
      expect(term.has(entity)).toBe(false);
      expect(term._store.has(entity)).toBe(false);
      expect(entity.has(key)).toBe(false);
      expect(entity._ceids).not.toContain(key.eid);
      expect(resyncs).toEqual([[false, false, false]]);
      // Other partial-world teardown state is deliberately not repaired.
    }
  );

  it("rejects foreign-world carriers with the same component bit", () => {
    class Data {}
    const first = new World();
    const second = new World();
    const key = first.component(Data);
    const otherKey = second.component(Data);
    expect(key.eid).toBe(otherKey.eid);
    const foreign = second.entity().add(Data);
    const query = first.query("data").with(Data).build();
    expect(foreign.componentBitmask.hasBit(key.meta.bitPtr)).toBe(true);
    expect(key.meta._term._store.has(foreign)).toBe(false);
    expect(key.meta._term.has(foreign)).toBe(false);
    expect(query.has(foreign)).toBe(false);
    expect(query.belongs(foreign)).toBe(false);
    first.dispose();
    second.dispose();
  });

  it("agrees with the store through hooks, query callbacks and system inbox replay", () => {
    class Data {
      value = 1;
    }
    class Reentrant {}
    class Alias {}
    class Concrete {}
    class Left {}
    class Right {}
    class Linked extends Relationship {}
    const world = new World();
    const classes = [Data, Reentrant, Alias, Concrete, Left, Right, Linked];
    const keys = classes.map((Class) => world.component(Class));
    world.component(Concrete).set(Implements, { interfaces: [Alias] });
    world.setExclusiveComponents(Left, Right);
    const calls: string[] = [];
    const check = (entity: Entity, label: string) => {
      for (const key of keys) {
        const term = key.meta._term;
        const stored = term._store.has(entity);
        expect(term.has(entity), `${label}: ${key.eid}`).toBe(stored);
        expect(entity.componentBitmask.hasBit(key.meta.bitPtr), `${label} bit: ${key.eid}`).toBe(
          stored
        );
      }
    };
    for (const [i, key] of keys.entries()) {
      key.on("add", (entity) => {
        check(entity, "add hook");
        if (i === 0) {
          entity.add(Reentrant);
          // A leaf subscribed inside a hook sees the staged carrier immediately.
          const staged = world.query("staged").with(Data).build();
          expect(staged.has(entity)).toBe(true);
          staged.destroy();
          check(entity, "reentrant add hook");
        }
      });
      key.on("set", (entity) => check(entity, "set hook"));
      key.on("remove", (entity) => {
        check(entity, "remove hook");
        if (entity.destroyed && i === 0 && entity.get(Data)?.value === 3) {
          // No alive guard: a sibling not detached yet remains a member.
          expect(world.component(Linked).meta._term.has(entity)).toBe(true);
          expect(entity.get(Data)).toEqual({ value: 3 });
        }
      });
      world
        .query(`query-${i}`)
        .with(key)
        .enter((entity) => {
          check(entity, "query enter");
          calls.push(`q+${i}`);
        })
        .update({ watch: classes[i] }, (entity) => {
          check(entity, "query update");
          calls.push(`q~${i}`);
        })
        .exit((entity) => {
          check(entity, "query exit");
          calls.push(`q-${i}`);
        })
        .build();
      world
        .system(`system-${i}`)
        .with(key)
        .enter((entity) => {
          check(entity, "inbox enter");
          calls.push(`s+${i}`);
        })
        .update({ watch: classes[i] }, (entity) => {
          check(entity, "inbox update");
          calls.push(`s~${i}`);
        })
        .exit((entity) => {
          check(entity, "inbox exit");
          calls.push(`s-${i}`);
        });
    }
    const relationship = world.component(Linked);
    relationship.on("targetAdd", (entity) => check(entity, "target add"));
    relationship.on("targetRemove", (entity) => check(entity, "target remove"));
    const entity = world.entity();
    const target = world.entity();
    const step = (mutation: () => void) => {
      mutation();
      check(entity, "after mutation");
      world.progress(0, 0);
      check(entity, "after inbox replay");
    };
    step(() => entity.add(Data));
    step(() => entity.attach(Object.assign(new Data(), { value: 2 })));
    expect(entity.get(Data)).toEqual({ value: 2 });
    step(() => entity.remove(Data));
    step(() => entity.add(Concrete));
    step(() => entity.remove(Concrete));
    step(() => entity.add(Left));
    step(() => entity.add(Right));
    step(() => entity.set(Data, { value: 3 }));
    step(() => entity.add(Linked, target));
    step(() => entity.destroy());
    for (const [i, key] of keys.entries()) {
      const entries = i === 0 ? 2 : 1;
      for (const prefix of ["q+", "q-", "s+", "s-"]) {
        expect(calls.filter((call) => call === `${prefix}${i}`)).toHaveLength(entries);
      }
      for (const prefix of ["q~", "s~"]) {
        expect(calls.filter((call) => call === `${prefix}${i}`)).toHaveLength(i === 0 ? 1 : 0);
      }
      expect(key.meta._term.has(entity)).toBe(false);
      expect(entity.has(key)).toBe(false);
    }
    // Reusing an id must not give the stale object the new carrier's membership.
    for (let frame = 0; frame < 16; frame++) {
      world.progress(0, 0);
    }
    const replacement = world.getOrCreateEntity(entity.eid).add(Data);
    expect(replacement).not.toBe(entity);
    expect(world.component(Data).meta._term.has(replacement)).toBe(true);
    expect(world.component(Data).meta._term.has(entity)).toBe(false);
    world.dispose();
  });

  it("retains bit and store when a live carrier's add hook throws", () => {
    class Data {}
    const world = new World();
    const key = world.component(Data).on("add", () => {
      throw new Error("add failed");
    });
    const entity = world.entity();
    expect(() => entity.add(Data)).toThrow("add failed");
    expect(entity.has(Data)).toBe(true);
    expect(key.meta._term.has(entity)).toBe(true);
    expect(key.meta._term._store.has(entity)).toBe(true);
    expect(key.meta._term._stagedCount).toBe(0);
    world.dispose();
  });

  it("removes a staged carrier reentrantly without propagating a late entry", () => {
    class Data {}
    const world = new World();
    const key = world.component(Data);
    const term = key.meta._term;
    const seen: boolean[][] = [];
    const record = (entity: Entity) => seen.push([term.has(entity), term._store.has(entity)]);
    const events: string[] = [];
    key.on("add", (entity) => {
      record(entity);
      world
        .query("inside hook")
        .with(Data)
        .exit((entity) => {
          record(entity);
          events.push("exit");
        })
        .build();
      entity.remove(Data);
      record(entity);
    });
    world
      .query("before hook")
      .with(Data)
      .enter(() => events.push("late enter"))
      .build();
    const entity = world.entity().add(Data);
    expect(seen).toEqual([
      [true, true],
      [false, false],
      [false, false],
    ]);
    expect(events).toEqual(["exit"]);
    expect(entity.has(Data)).toBe(false);
    expect(term.count).toBe(0);
    expect(term._stagedCount).toBe(0);
    world.dispose();
  });

  it("resolves the bit for a plain entity key before its metadata exists", () => {
    const world = new World();
    const key = world.entity();
    const term = world.getTerm(key);
    const entity = world.entity();
    expect(term.has(entity)).toBe(false);
    entity.add(key);
    expect(term.has(entity)).toBe(true);
    expect(key.meta._term._store.has(entity)).toBe(true);
    entity.remove(key);
    expect(term.has(entity)).toBe(false);
    expect(key.meta._term._store.has(entity)).toBe(false);
    world.dispose();
  });
});
