import { describe, expect, it, vi } from "vitest";
import {
  range,
  Relationship,
  values,
  type,
  World,
  type Entity,
  type ValidationResult,
} from "../../src/index.js";

// Definitions are per class for the whole process, so every test declares its
// own classes.

describe("default validate and normalize hooks", () => {
  it("checks and clamps u8 to its type bounds", () => {
    class Level {
      @type("u8") public value = 0;
    }
    const world = new World();
    world.component(Level);
    const level = Object.assign(new Level(), { value: 300 });

    expect(world.validate(level)).toEqual(["value: 300 is above the maximum 255"]);
    expect(world.isValid(level)).toBe(false);
    expect(world.normalize(level)).toBe(level);
    expect(level.value).toBe(255);
    expect(world.validate(Object.assign(new Level(), { value: -1 }))).toEqual([
      "value: -1 is below the minimum 0",
    ]);
    expect(world.isValid(level)).toBe(true);
  });

  it("truncates integers, then clamps them into the declared range", () => {
    class Cell {
      @type("i32") @range(-10, 10) public x = 0;
      @type("i16") public y = 0;
    }
    const world = new World();
    world.component(Cell);
    const cell = Object.assign(new Cell(), { x: 12.7, y: -3.9 });

    expect(world.validate(cell)).toEqual([
      "x: 12.7 is not an integer",
      "y: -3.9 is not an integer",
    ]);
    world.normalize(cell);
    expect(cell).toEqual({ x: 10, y: -3 });
    expect(world.validate(cell)).toBe(true);
  });

  it("clamps floats only to their range", () => {
    class Ratio {
      @type("f32") @range(0, 1) public value = 0;
      @type("f64") public free = 0;
    }
    const world = new World();
    world.component(Ratio);
    const ratio = Object.assign(new Ratio(), { value: 1.5, free: 1e300 });

    expect(world.validate(ratio)).toEqual(["value: 1.5 is above the maximum 1"]);
    world.normalize(ratio);
    expect(ratio).toEqual({ value: 1, free: 1e300 });
  });

  it("uses bigint for u64 and i64", () => {
    class Wide {
      @type("u64") public unsigned = 0n;
      @type("i64") @range(-5, 5) public signed = 0n;
    }
    const world = new World();
    world.component(Wide);
    const wide = Object.assign(new Wide(), { unsigned: -1n, signed: 9n });

    expect(world.validate(wide)).toEqual([
      "unsigned: -1 is below the minimum 0",
      "signed: 9 is above the maximum 5",
    ]);
    expect(world.validate(Object.assign(new Wide(), { unsigned: 2 }))).toEqual([
      "unsigned: expected a bigint",
    ]);
    world.normalize(wide);
    expect(wide).toEqual({ unsigned: 0n, signed: 5n });
    const big = Object.assign(new Wide(), { unsigned: 2n ** 64n, signed: 3.8 });
    world.normalize(big);
    expect(big).toEqual({ unsigned: 2n ** 64n - 1n, signed: 3n });
  });

  it("checks each element of an array member", () => {
    class Bytes {
      @type(["u8"]) public data: number[] = [];
    }
    const world = new World();
    world.component(Bytes);
    const bytes = Object.assign(new Bytes(), { data: [1, 256, -2] });

    expect(world.validate(bytes)).toEqual([
      "data[1]: 256 is above the maximum 255",
      "data[2]: -2 is below the minimum 0",
    ]);
    world.normalize(bytes);
    expect(bytes.data).toEqual([1, 255, 0]);
  });

  it("reports values of the wrong type and leaves them to explicit hooks", () => {
    class Typed {
      @type("u8") public value: unknown = 0;
    }
    const world = new World();
    world.component(Typed);
    const typed = Object.assign(new Typed(), { value: "7" });

    expect(world.validate(typed)).toEqual(["value: expected a number"]);
    world.normalize(typed);
    expect(typed.value).toBe("7");
  });

  it("follows fluent declarations made after the first call", () => {
    class Late {
      public value = 0;
    }
    const world = new World();
    world.component(Late).member("value", "f32");
    const late = Object.assign(new Late(), { value: 50 });
    expect(world.validate(late)).toBe(true);

    world.component(Late).member("value", "f32").range(0, 10);
    expect(world.validate(late)).toEqual(["value: 50 is above the maximum 10"]);
  });

  it("reports an enum value outside its values and leaves it to normalize as is", () => {
    class Mode {
      @type("enum") @values([1, 2, 4]) public mode = 1;
      @type(["enum"]) @values([0, 1]) public flags: number[] = [];
    }
    const world = new World();
    world.component(Mode);
    const mode = Object.assign(new Mode(), { mode: 3, flags: [1, 5] });

    expect(world.validate(mode)).toEqual([
      "mode: 3 is not one of [1, 2, 4]",
      "flags[1]: 5 is not one of [0, 1]",
    ]);
    world.normalize(mode);
    expect(mode).toEqual({ mode: 3, flags: [1, 5] });
    expect(world.isValid(Object.assign(new Mode(), { mode: 4, flags: [0] }))).toBe(true);
  });

  it("checks a ranged member another world declares after the first validate", () => {
    class Shared {
      public a = 0;
      public b = 0;
    }
    const first = new World();
    // `a` gives the first world a default hook before `b` exists.
    first.component(Shared).member("a", "u8");
    const shared = Object.assign(new Shared(), { a: 1, b: 50 });
    expect(first.validate(shared)).toBe(true);
    first.normalize(shared);

    new World().component(Shared).member("b", "f32").range(0, 10);

    expect(first.validate(shared)).toEqual(["b: 50 is above the maximum 10"]);
    first.normalize(shared);
    expect(shared.b).toBe(10);
  });

  it("checks members inherited from a base class", () => {
    class Base {
      @type("u8") public level = 0;
    }
    class Derived extends Base {
      public extra = 0;
    }
    const world = new World();
    world.component(Derived);

    expect(world.validate(Object.assign(new Derived(), { level: 256 }))).toEqual([
      "level: 256 is above the maximum 255",
    ]);
    world.component(Base).member("level", "u8").range(0, 9);
    expect(world.validate(Object.assign(new Derived(), { level: 10 }))).toEqual([
      "level: 10 is above the maximum 9",
    ]);
  });

  it("is replaced by the first explicit hook", () => {
    class Replaced {
      @type("u8") public value = 0;
    }
    const world = new World();
    const component = world.component(Replaced);
    const invalid = Object.assign(new Replaced(), { value: 999 });
    expect(world.isValid(invalid)).toBe(false);
    world.normalize(Object.assign(new Replaced(), { value: 999 }));

    const validate = vi.fn((): ValidationResult => "custom");
    const normalize = vi.fn((c: Replaced) => {
      c.value = 7;
    });
    component.on("validate", validate).on("normalize", normalize);

    expect(world.validate(invalid)).toBe("custom");
    world.normalize(invalid);
    expect(invalid.value).toBe(7);
    expect(validate).toHaveBeenCalledWith(invalid);
    expect(normalize).toHaveBeenCalledTimes(1);
  });

  it("is not created for a class without metadata", () => {
    class Plain {
      public value = -1;
    }
    const world = new World();
    world.component(Plain);
    const plain = new Plain();

    expect(world.validate(plain)).toBe(true);
    expect(world.isValid(plain)).toBe(true);
    expect(world.normalize(plain)).toEqual({ value: -1 });
  });
});

describe("explicit validate and normalize hooks", () => {
  it("run in registration order; validate stops at the first failure", () => {
    class Ordered {
      public value = 0;
    }
    const world = new World();
    const calls: string[] = [];
    world
      .component(Ordered)
      .on("validate", () => {
        calls.push("first");
        return true;
      })
      .on("validate", () => {
        calls.push("second");
        return ["too big", "too odd"];
      })
      .on("validate", () => {
        calls.push("third");
        return true;
      })
      .on("normalize", (c) => {
        c.value += 1;
      })
      .on("normalize", (c) => {
        c.value *= 10;
      });

    expect(world.validate(new Ordered())).toEqual(["too big", "too odd"]);
    expect(calls).toEqual(["first", "second"]);
    expect(world.normalize(new Ordered()).value).toBe(10);
  });

  it("can be removed with off", () => {
    class Removable {
      public value = 0;
    }
    const world = new World();
    const failing = (): ValidationResult => "no";
    world.component(Removable).on("validate", failing);
    expect(world.isValid(new Removable())).toBe(false);
    world.component(Removable).off("validate", failing);
    expect(world.isValid(new Removable())).toBe(true);
  });

  it("are not run by set", () => {
    class Unchecked {
      @type("u8") public value = 0;
    }
    const world = new World();
    const validate = vi.fn((): ValidationResult => true);
    const normalize = vi.fn();
    world.component(Unchecked).on("validate", validate).on("normalize", normalize);
    const entity = world.entity().set(Unchecked, { value: 999 });
    entity.modified(Unchecked);

    expect(entity.get(Unchecked)!.value).toBe(999);
    expect(validate).not.toHaveBeenCalled();
    expect(normalize).not.toHaveBeenCalled();
  });

  it("throw for an unregistered class", () => {
    class Unregistered {}
    const world = new World();
    const message = "component class Unregistered is not registered in this world";

    expect(() => world.validate(new Unregistered())).toThrow(`world.validate: ${message}`);
    expect(() => world.isValid(new Unregistered())).toThrow(`world.validate: ${message}`);
    expect(() => world.normalize(new Unregistered())).toThrow(`world.normalize: ${message}`);
  });
});

describe("vecs_ static hooks", () => {
  it("registers every component event ahead of .on hooks", () => {
    const calls: string[] = [];
    class Hooked {
      public value = 0;
      public static vecs_add(this: unknown, _e: Entity, c: Hooked): void {
        calls.push(`add ${this === Hooked} ${c.value}`);
      }
      public static vecs_set(): void {
        calls.push("set static");
      }
      public static vecs_remove(): void {
        calls.push("remove");
      }
      public static vecs_validate(c: Hooked): ValidationResult {
        calls.push("validate static");
        return c.value < 10 ? true : "static";
      }
      public static vecs_normalize(c: Hooked): void {
        calls.push("normalize static");
        c.value = 5;
      }
    }
    const world = new World();
    world
      .component(Hooked)
      .on("set", () => calls.push("set on"))
      .on("validate", () => {
        calls.push("validate on");
        return true;
      })
      .on("normalize", (c) => {
        calls.push(`normalize on ${c.value}`);
      });

    const entity = world.entity().add(Hooked);
    entity.set(Hooked, { value: 1 });
    entity.remove(Hooked);
    world.validate(new Hooked());
    world.normalize(new Hooked());

    expect(calls).toEqual([
      "add true 0",
      "set static",
      "set on",
      "remove",
      "validate static",
      "validate on",
      "normalize static",
      "normalize on 5",
    ]);
  });

  it("registers vecs_targetAdd and vecs_targetRemove on a relationship class", () => {
    const calls: string[] = [];
    class Likes extends Relationship {
      public static vecs_targetAdd(_source: Entity, _r: Likes, target: Entity): void {
        calls.push(`targetAdd ${target.eid}`);
      }
      public static vecs_targetRemove(_source: Entity, _r: Likes, target: Entity): void {
        calls.push(`targetRemove ${target.eid}`);
      }
    }
    const world = new World();
    world.component(Likes);
    const target = world.entity();
    const source = world.entity().add(Likes, target);
    source.remove(Likes);

    expect(calls).toEqual([`targetAdd ${target.eid}`, `targetRemove ${target.eid}`]);
  });

  it("rejects vecs_targetAdd on a class that is not a relationship", () => {
    class NotRelationship {
      public static vecs_targetAdd(): void {}
    }
    const world = new World();
    expect(() => world.component(NotRelationship)).toThrow(
      '"targetAdd" hooks can only be registered on a Relationship component'
    );
    expect(world.getEntity(NotRelationship)).toBeUndefined();
  });

  it("replaces the default hook with vecs_validate", () => {
    class StaticValidated {
      @type("u8") public value = 0;
      public static vecs_validate(): ValidationResult {
        return "static";
      }
    }
    const world = new World();
    world.component(StaticValidated);
    expect(world.validate(new StaticValidated())).toBe("static");
  });
});
