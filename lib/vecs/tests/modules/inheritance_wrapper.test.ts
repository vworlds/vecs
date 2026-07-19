import { describe, it, expect } from "vitest";
import { World } from "../../src/index.js";
import { isWrapperInstance } from "../../src/component_meta.js";

class Position {
  x = 0;
  y = 0;
}

class Sprite {}

describe("ComponentMeta._proxy dirty-on-write wrapper", () => {
  it("clean read delegates to target", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;
    target.y = 7;

    const wrapper: Position = meta._proxy(target) as Position;

    expect(isWrapperInstance(wrapper)).toBe(true);
    expect(wrapper.x).toBe(5);
    expect(wrapper.y).toBe(7);
  });

  it("write lazily copies into INTERNAL and does not propagate to target", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;
    target.y = 7;

    const wrapper = meta._proxy(target);
    (wrapper as Position).x = 99;

    expect((wrapper as Position).x).toBe(99);
    expect(target.x).toBe(5);
    // Other field was copied from target during the lazy copy.
    expect((wrapper as Position).y).toBe(7);
  });

  it("preserves instanceof before and after __unproxy", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;

    const wrapper = meta._proxy(target);
    expect(wrapper instanceof Position).toBe(true);

    (wrapper as Position).x = 42;
    const real = (wrapper as unknown as { __unproxy(): Position }).__unproxy();
    expect(real instanceof Position).toBe(true);
    expect(real.x).toBe(42);
  });

  it("__unproxy pre-dirty returns a real instance with target values", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;
    target.y = 7;

    const wrapper = meta._proxy(target);
    const real = (wrapper as unknown as { __unproxy(): Position }).__unproxy();

    expect(isWrapperInstance(real)).toBe(false);
    expect(real.x).toBe(5);
    expect(real.y).toBe(7);

    // Mutating the returned instance does not affect target or wrapper.
    real.x = 123;
    expect(target.x).toBe(5);
    expect((wrapper as Position).x).toBe(5);
  });

  it("__unproxy post-dirty returns a real instance with INTERNAL values", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;
    target.y = 7;

    const wrapper = meta._proxy(target);
    (wrapper as Position).x = 99;
    const real = (wrapper as unknown as { __unproxy(): Position }).__unproxy();

    expect(isWrapperInstance(real)).toBe(false);
    expect(real.x).toBe(99);
    expect(real.y).toBe(7);
  });

  it("does not leak Symbol keys", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;
    target.y = 7;

    const wrapper = meta._proxy(target);

    // Own enumerable string keys are the declared fields; Symbols do not leak
    // through Object.keys or for...in.
    expect(Object.keys(wrapper).sort()).toEqual(["x", "y"]);
    for (const k in wrapper) {
      expect(typeof k).toBe("string");
    }
    expect(() => JSON.stringify(wrapper)).not.toThrow();
    const json = JSON.parse(JSON.stringify(wrapper));
    expect(json).toEqual({ x: 5, y: 7 });
  });

  it("caches the wrapper class on the meta", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;

    const wrapper1 = meta._proxy(target);
    const wrapper2 = meta._proxy(target);
    expect(wrapper1.constructor).toBe(wrapper2.constructor);
    expect(meta._inheritWrapperClass).toBeDefined();
  });

  it("proxy-of-proxy shortcut, clean: collapses to the inner target", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;
    target.y = 7;

    const w1 = meta._proxy(target);
    const w2 = meta._proxy(w1);

    expect(isWrapperInstance(w2)).toBe(true);
    // w2 reads the same values as target.
    expect((w2 as Position).x).toBe(5);
    expect((w2 as Position).y).toBe(7);

    // Writing to w2 does not change target or w1.
    (w2 as Position).x = 999;
    expect(target.x).toBe(5);
    expect((w1 as Position).x).toBe(5);

    // w2 unproxies to a real instance with the written value; w1 unaffected.
    const real = (w2 as unknown as { __unproxy(): Position }).__unproxy();
    expect(isWrapperInstance(real)).toBe(false);
    expect(real.x).toBe(999);
    expect((w1 as Position).x).toBe(5);
  });

  it("proxy-of-proxy shortcut, dirty: returns a real instance", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;

    const w1 = meta._proxy(target);
    (w1 as Position).x = 100;
    const w2 = meta._proxy(w1);

    expect(isWrapperInstance(w2)).toBe(false);
    expect((w2 as Position).x).toBe(100);
  });

  it("fieldless component produces a working wrapper", () => {
    const w = new World();
    const meta = w.component(Sprite).meta;
    const target = new Sprite();

    const wrapper = meta._proxy(target);

    expect(isWrapperInstance(wrapper)).toBe(true);
    expect(wrapper instanceof Sprite).toBe(true);
    const real = (wrapper as unknown as { __unproxy(): Sprite }).__unproxy();
    expect(real instanceof Sprite).toBe(true);
  });
});
