import { describe, expect, it, vi } from "vitest";
import { Implements, Relationship, World } from "../src/index.js";

class Position {
  x = 0;
  y = 0;
}

describe.each([false, true])("assign (deferred=%s)", (deferred) => {
  function setup() {
    const world = new World();
    const component = world.component(Position);
    const entity = world.entity().set(Position, { x: 1, y: 2 });
    const update = vi.fn();
    world.query("watch").with(Position).update({ watch: Position }, update).build();
    const set = vi.fn();
    component.on("set", set);
    const write = (fn: () => void) => (deferred ? world.defer(fn) : fn());
    return { world, component, entity, update, set, write };
  }

  it("equal props and instances are silent, and do not suppress a later modification", () => {
    const { entity, update, set, write } = setup();
    write(() => {
      expect(entity.assign(Position, { x: 1 })).toBe(entity);
      entity.assign(Position, Object.assign(new Position(), { x: 1, y: 2 }));
    });
    expect(set).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    write(() => entity.modified(Position));
    expect(set).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("writes differences in place, merging props but resetting omitted instance fields", () => {
    const { entity, component, update, set, write } = setup();
    const original = entity.get(Position);
    write(() => entity.assign(component.eid, { x: 3 }));
    expect(entity.get(Position)).toBe(original);
    expect(original).toEqual({ x: 3, y: 2 });
    write(() => entity.assign(component, Object.assign(new Position(), { x: 4 })));
    expect(entity.get(Position)).toBe(original);
    expect(original).toEqual({ x: 4, y: 0 });
    expect(set).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("adds an absent component with add and set hooks and query entry", () => {
    const { world, component, write } = setup();
    const add = vi.fn();
    const set = vi.fn();
    const enter = vi.fn();
    component.on("add", add).on("set", set);
    world.query("entry").with(Position).enter(enter).build();
    enter.mockClear();
    const entity = world.entity();
    write(() => entity.assign(Position, { x: 5 }));
    expect(entity.get(Position)).toEqual({ x: 5, y: 0 });
    expect(add).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("uses static equals, replaces it with on, and restores the default with off", () => {
    class Approx {
      x = 0;
      static vecs_equals(a: Approx, b: Approx) {
        return Math.floor(a.x) === Math.floor(b.x);
      }
    }
    const { world, write } = setup();
    const definition = world.component(Approx);
    const entity = world.entity().add(Approx);
    write(() => entity.assign(Approx, { x: 0.5 }));
    expect(entity.get(Approx)?.x).toBe(0);
    const override = vi.fn(() => false);
    definition.on("equals", override);
    write(() => entity.assign(Approx, { x: 0.5 }));
    expect(override).toHaveBeenCalledTimes(1);
    expect(entity.get(Approx)?.x).toBe(0.5);
    definition.off("equals", () => true);
    write(() => entity.assign(Approx, { x: 0.6 }));
    expect(override).toHaveBeenCalledTimes(2);
    definition.off("equals", override);
    write(() => entity.assign(Approx, { x: 0.7 }));
    expect(entity.get(Approx)?.x).toBe(0.7);
    expect(override).toHaveBeenCalledTimes(2);
  });

  it("compares only declared VecsStruct members by default", () => {
    class Reflected {
      x = 0;
      ignored = 0;
    }
    const { world, write } = setup();
    world.component(Reflected).member("x", "i32");
    const entity = world.entity().add(Reflected);
    write(() => entity.assign(Reflected, { ignored: 9 }));
    expect(entity.get(Reflected)).toEqual({ x: 0, ignored: 0 });
    write(() => entity.assign(Reflected, { x: 1, ignored: 9 }));
    expect(entity.get(Reflected)).toEqual({ x: 1, ignored: 9 });
  });

  it("uses strict field equality, including references and NaN", () => {
    class Data {
      value = 0;
      reference: object | null = null;
    }
    const { world, write } = setup();
    const set = vi.fn();
    world.component(Data).on("set", set);
    const reference = {};
    const entity = world.entity().set(Data, { reference });
    set.mockClear();
    write(() => entity.assign(Data, { value: -0, reference }));
    expect(set).not.toHaveBeenCalled();
    write(() => entity.assign(Data, { reference: {} }));
    expect(set).toHaveBeenCalledTimes(1);
    write(() => entity.assign(Data, { value: NaN }));
    write(() => entity.assign(Data, { value: NaN }));
    expect(set).toHaveBeenCalledTimes(3);
  });

  it("distinguishes omitted props from explicit undefined", () => {
    class Optional {
      value: number | undefined = 1;
      other = 2;
    }
    const { world, write } = setup();
    const set = vi.fn();
    world.component(Optional).on("set", set);
    const entity = world.entity().add(Optional);
    write(() => entity.assign(Optional, {}));
    expect(set).not.toHaveBeenCalled();
    write(() => entity.assign(Optional, { value: undefined }));
    expect(entity.get(Optional)).toEqual({ value: undefined, other: 2 });
    expect(set).toHaveBeenCalledTimes(1);
    write(() => entity.assign(Optional, { value: undefined }));
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("merges only component fields for custom hooks, without leaking extra props keys", () => {
    const { component, entity, write } = setup();
    const candidates: Position[] = [];
    component.on("equals", (stored, candidate) => {
      expect(candidate).toBeInstanceOf(Position);
      candidates.push({ ...candidate });
      return stored.x === candidate.x && stored.y === candidate.y;
    });
    write(() => entity.assign(component, { x: 3, extra: "not a component field" }));
    write(() => entity.assign(component, { y: 4 }));
    expect(candidates).toEqual([
      { x: 3, y: 2 },
      { x: 3, y: 4 },
    ]);
    // Only comparison is schema-limited; a differing write still copies all props as set does.
    expect(entity.get(component)).toEqual({ x: 3, y: 4, extra: "not a component field" });
  });

  it("allows live remove-hook writes but drops dying-entity remove-hook writes", () => {
    const { world, entity, component, write } = setup();
    const remove = vi.fn((removed: typeof entity) => removed.assign(Position, { x: 9 }));
    component.on("remove", remove);
    write(() => entity.destroy());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(entity.has(Position)).toBe(false);
    const other = world.entity().add(Position);
    write(() => {
      other.assign(Position, { x: 1 });
      other.remove(Position);
    });
    // A live-entity remove hook may explicitly re-add, but an earlier dirty
    // notification cannot resurrect a destroyed entity.
    expect(other.get(Position)?.x).toBe(9);
  });

  it("rejects relationships and aliases but drops all writes on dying entities", () => {
    class Link extends Relationship {}
    class Alias {}
    class Concrete {}
    const { world, entity, write } = setup();
    world.component(Link);
    world.component(Alias);
    world.component(Concrete).set(Implements, { interfaces: [Alias] });
    expect(() => write(() => entity.assign(Link, {}))).toThrow(/Relationship/);
    expect(() => write(() => entity.assign(Alias, {}))).toThrow(/interface/i);
    entity.destroy();
    expect(() =>
      write(() => {
        entity.assign(Link, {}).assign(Alias, {}).assign(Position, { x: 10 });
      })
    ).not.toThrow();
    expect(entity.has(Position)).toBe(false);
  });

  it("keeps outer candidate intact when equals re-enters assign for the same class", () => {
    const { world, component, entity, write } = setup();
    const other = world.entity().set(Position, { x: 10, y: 20 });
    let nested = false;
    component.on("equals", (stored, candidate) => {
      if (!nested) {
        nested = true;
        other.assign(Position, { x: 30 });
        expect(candidate).toEqual({ x: 5, y: 2 });
      }
      return stored.x === candidate.x && stored.y === candidate.y;
    });
    write(() => entity.assign(Position, { x: 5 }));
    expect(entity.get(Position)).toEqual({ x: 5, y: 2 });
    expect(other.get(Position)).toEqual({ x: 30, y: 20 });
  });
});

it("reuses scratch after warmup, including nested comparisons and thrown hooks", () => {
  let constructions = 0;
  class Counted {
    x = 0;
    constructor() {
      constructions++;
    }
  }
  const world = new World();
  const definition = world.component(Counted);
  const outer = world.entity().add(Counted);
  const inner = world.entity().add(Counted);
  let nesting = false;
  let fail = false;
  definition.on("equals", (a, b) => {
    if (!nesting) {
      nesting = true;
      try {
        inner.assign(Counted, { x: 2 });
        expect(b.x).toBe(1);
        if (fail) {
          throw new Error("hook failed");
        }
      } finally {
        nesting = false;
      }
    }
    return a.x === b.x;
  });
  outer.assign(Counted, { x: 1 });
  const warmed = constructions;
  fail = true;
  expect(() => outer.assign(Counted, { x: 1 })).toThrow("hook failed");
  fail = false;
  for (let i = 0; i < 5; i++) {
    outer.assign(Counted, { x: 1 });
  }
  expect(constructions).toBe(warmed);
  expect(outer.get(Counted)?.x).toBe(1);
  expect(inner.get(Counted)?.x).toBe(2);
});

it("does not construct scratch for default props comparison", () => {
  let constructions = 0;
  class Counted {
    x = 0;
    constructor() {
      constructions++;
    }
  }
  const world = new World();
  world.component(Counted).member("x", "i32");
  const entity = world.entity().add(Counted);
  expect(constructions).toBe(1);
  entity.assign(Counted, {});
  entity.assign(Counted, { x: 0 });
  entity.assign(Counted, { x: 1 });
  expect(entity.get(Counted)?.x).toBe(1);
  expect(constructions).toBe(1);
});

it("compares at application time after earlier queued writes and coalesces differences", () => {
  const world = new World();
  const definition = world.component(Position);
  const entity = world.entity().set(Position, { x: 1 });
  const set = vi.fn();
  definition.on("set", set);
  const update = vi.fn();
  world.query("watch").with(Position).update({ watch: Position }, update).build();
  world.defer(() => {
    entity.set(Position, { x: 2 });
    entity.assign(Position, { x: 2 });
  });
  expect(set).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(1);
  set.mockClear();
  update.mockClear();
  world.defer(() => {
    entity.assign(Position, { x: 3 });
    entity.assign(Position, { x: 4 });
    entity.assign(Position, { x: 4 });
    expect(entity.get(Position)?.x).toBe(2);
  });
  expect(entity.get(Position)?.x).toBe(4);
  expect(set).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(1);
});
