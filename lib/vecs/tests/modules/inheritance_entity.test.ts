import { describe, it, expect, vi } from "vitest";
import { World } from "../../src/index.js";
import { isWrapperInstance } from "../../src/component_meta.js";

class Position {
  x = 0;
  y = 0;
}

class Sprite {}

describe("Entity wrapper promotion — _get / _set / _modified", () => {
  it("_get returns a clean wrapper as-is", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;
    target.y = 7;
    const wrapper = meta._proxy(target);

    const e = w.entity();
    e._attach(meta, wrapper);

    const got = e._get(meta.eid);
    expect(isWrapperInstance(got)).toBe(true);
    expect((got as Position).x).toBe(5);
    expect((got as Position).y).toBe(7);
  });

  it("_get promotes a dirty wrapper to a real instance and stores it back", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;
    target.y = 7;
    const wrapper = meta._proxy(target) as Position & {
      __isDirty(): boolean;
      __unproxy(): Position;
    };

    const e = w.entity();
    e._attach(meta, wrapper);

    // Dirty the wrapper via direct field write (no notification path).
    wrapper.x = 99;
    expect(wrapper.__isDirty()).toBe(true);

    // First _get promotes the wrapper to a real instance.
    const got = e._get(meta.eid);
    expect(isWrapperInstance(got)).toBe(false);
    expect((got as Position).x).toBe(99);
    expect((got as Position).y).toBe(7);

    // The promoted real instance is stored back in _components; a second _get
    // returns the same identity (not a fresh unproxy).
    const got2 = e._get(meta.eid);
    expect(got2).toBe(got);
  });

  it("_set unproxies a wrapper before assigning props", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;
    target.y = 7;
    const wrapper = meta._proxy(target);

    const e = w.entity();
    e._attach(meta, wrapper);

    e.set(Position, { x: 42 });

    const got = e.get(Position)!;
    expect(isWrapperInstance(got)).toBe(false);
    expect(got.x).toBe(42);
    // y was preserved through the unproxy + assign.
    expect(got.y).toBe(7);
    // The template is unaffected.
    expect(target.x).toBe(5);
  });

  it("_set on a clean wrapper unproxies even when no fields were dirty", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 1;
    target.y = 2;
    const wrapper = meta._proxy(target);

    const e = w.entity();
    e._attach(meta, wrapper);

    e.set(Position, { x: 10 });

    const got = e.get(Position)!;
    expect(isWrapperInstance(got)).toBe(false);
    expect(got.x).toBe(10);
    expect(got.y).toBe(2);
  });

  it("_modified unproxies a wrapper and fires onSet with a real instance", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const onSet = vi.fn();
    w.component(Position).on("set", onSet);

    const target = new Position();
    target.x = 5;
    target.y = 7;
    const wrapper = meta._proxy(target);

    const e = w.entity();
    e._attach(meta, wrapper);
    onSet.mockClear();

    e.modified(Position);
    w.progress(0, 0);

    expect(onSet).toHaveBeenCalledTimes(1);
    const [, instance] = onSet.mock.calls[0];
    expect(isWrapperInstance(instance)).toBe(false);
    expect((instance as Position).x).toBe(5);
    expect((instance as Position).y).toBe(7);

    // The stored value is now a real instance.
    const got = e._get(meta.eid);
    expect(isWrapperInstance(got)).toBe(false);
  });

  it("getMut returns a real instance when the stored wrapper is dirty", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;
    const wrapper = meta._proxy(target) as Position;

    const e = w.entity();
    e._attach(meta, wrapper);

    // Dirty the wrapper directly (bypasses _markModified).
    wrapper.x = 99;

    let captured: Position | undefined;
    e.getMut(Position, (p) => {
      captured = p;
    });
    expect(captured).toBeDefined();
    expect(isWrapperInstance(captured)).toBe(false);
    expect(captured!.x).toBe(99);

    // The stored value is now real; subsequent getMut returns the same real instance.
    let captured2: Position | undefined;
    e.getMut(Position, (p) => {
      captured2 = p;
    });
    expect(captured2).toBe(captured);
  });

  it("ensure returns a real instance when the stored wrapper is dirty", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;
    const wrapper = meta._proxy(target) as Position;

    const e = w.entity();
    e._attach(meta, wrapper);

    wrapper.x = 88;

    let captured: Position | undefined;
    e.ensure(Position, (p) => {
      captured = p;
    });
    expect(captured).toBeDefined();
    expect(isWrapperInstance(captured)).toBe(false);
    expect(captured!.x).toBe(88);
  });

  it("Object.assign from a wrapper uses getters and yields effective values", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const target = new Position();
    target.x = 5;
    target.y = 7;
    const wrapper = meta._proxy(target) as Position;

    // Pre-dirty: Object.assign reads through getters to the target.
    const pre = new Position();
    Object.assign(pre, wrapper);
    expect(pre.x).toBe(5);
    expect(pre.y).toBe(7);

    // Post-dirty: Object.assign reads from INTERNAL via getters.
    wrapper.x = 99;
    const post = new Position();
    Object.assign(post, wrapper);
    expect(post.x).toBe(99);
    expect(post.y).toBe(7);
  });

  it("fieldless wrapper is promoted by _get after _modified", () => {
    const w = new World();
    const meta = w.component(Sprite).meta;
    const target = new Sprite();
    const wrapper = meta._proxy(target);

    const e = w.entity();
    e._attach(meta, wrapper);

    e.modified(Sprite);
    w.progress(0, 0);

    const got = e._get(meta.eid);
    expect(isWrapperInstance(got)).toBe(false);
    expect(got instanceof Sprite).toBe(true);
  });

  it("non-wrapper instances pass through _get unchanged", () => {
    const w = new World();
    const meta = w.component(Position).meta;
    const e = w.entity();
    e.add(Position);
    const got = e._get(meta.eid);
    expect(isWrapperInstance(got)).toBe(false);
    expect(got instanceof Position).toBe(true);
  });
});
