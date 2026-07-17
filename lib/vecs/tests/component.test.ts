import { describe, it, expect, vi } from "vitest";
import { World } from "../src/index.js";

class Health {
  hp = 10;
}

describe("ComponentMeta", () => {
  it("stores the component eid", () => {
    const w = new World();
    const component = w.component(Health);
    expect(component.meta.eid).toBe(component.eid);
  });

  it("entity.modified(C) queues an onSet hook delivery", () => {
    const w = new World();
    w.component(Health);
    const onSet = vi.fn();
    w.component(Health).on("set", onSet);
    const e = w.entity();
    const h = e.add(Health).get(Health)!;
    e.modified(Health);
    w.progress(0, 0);
    expect(onSet).toHaveBeenCalledWith(e, h);
  });

  it("entity.modified(C) in deferred mode is coalesced — onSet fires once even if called multiple times", () => {
    const w = new World();
    w.component(Health);
    const onSet = vi.fn();
    w.component(Health).on("set", onSet);
    const e = w.entity();
    e.add(Health);
    onSet.mockClear();
    w.beginDefer();
    e.modified(Health);
    e.modified(Health);
    e.modified(Health);
    w.endDefer();
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("entity.modified(C) at top level fires onSet immediately on each call", () => {
    const w = new World();
    w.component(Health);
    const onSet = vi.fn();
    w.component(Health).on("set", onSet);
    const e = w.entity();
    e.add(Health);
    onSet.mockClear();
    e.modified(Health);
    e.modified(Health);
    e.modified(Health);
    expect(onSet).toHaveBeenCalledTimes(3);
  });
});

describe("Entity.modified", () => {
  it("returns the entity for chaining", () => {
    const w = new World();
    w.component(Health);
    const e = w.entity();
    e.add(Health);
    expect(e.modified(Health)).toBe(e);
  });

  it("queues an onSet hook delivery", () => {
    const w = new World();
    w.component(Health);
    const onSet = vi.fn();
    w.component(Health).on("set", onSet);
    const e = w.entity();
    const h = e.add(Health).get(Health)!;
    e.modified(Health);
    w.progress(0, 0);
    expect(onSet).toHaveBeenCalledWith(e, h);
  });

  it("is coalesced in deferred mode — onSet fires once even if called multiple times", () => {
    const w = new World();
    w.component(Health);
    const onSet = vi.fn();
    w.component(Health).on("set", onSet);
    const e = w.entity();
    e.add(Health);
    onSet.mockClear();
    w.beginDefer();
    e.modified(Health);
    e.modified(Health);
    e.modified(Health);
    w.endDefer();
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("can be chained after add", () => {
    const w = new World();
    w.component(Health);
    const onSet = vi.fn();
    w.component(Health).on("set", onSet);
    const e = w.entity();
    e.add(Health).modified(Health);
    w.progress(0, 0);
    expect(onSet).toHaveBeenCalledTimes(1);
  });
});

describe("Hook", () => {
  it("onAdd fires when a component is first attached", () => {
    const w = new World();
    w.component(Health);
    const onAdd = vi.fn();
    w.component(Health).on("add", onAdd);
    const e = w.entity();
    const h = e.add(Health).get(Health)!;
    expect(onAdd).toHaveBeenCalledWith(e, h);
  });

  it("hooks can be registered after component registration", () => {
    const w = new World();
    w.component(Health);
    const onAdd = vi.fn();

    w.component(Health).on("add", onAdd);
    const e = w.entity();
    const h = e.add(Health).get(Health)!;

    expect(onAdd).toHaveBeenCalledWith(e, h);
  });

  it("onSet fires when a component value is set", () => {
    const w = new World();
    w.component(Health);

    const set_values: number[] = [];
    const onSet = vi.fn((_e, c) => set_values.push(c.hp));

    const onAdd = vi.fn();
    w.component(Health).on("set", onSet).on("add", onAdd);
    const e = w.entity();
    const h = e.set(Health, { hp: 99 }).get(Health)!;

    e.set(Health, { hp: 200 });

    expect(onAdd).toHaveBeenCalledWith(e, h);
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onSet).toHaveBeenCalledWith(e, h);
    expect(onSet).toHaveBeenCalledTimes(2);
    expect(set_values).toEqual([99, 200]);
  });

  it("onRemove fires when a component is removed", () => {
    const w = new World();
    w.component(Health);
    const onRemove = vi.fn();
    w.component(Health).on("remove", onRemove);
    const e = w.entity();
    const h = e.add(Health).get(Health)!;
    e.remove(Health);
    expect(onRemove).toHaveBeenCalledWith(e, h);
  });

  it("onRemove fires when the entity is destroyed", () => {
    const w = new World();
    w.component(Health);
    const onRemove = vi.fn();
    w.component(Health).on("remove", onRemove);
    const e = w.entity();
    e.add(Health);
    e.destroy();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("hooks are chainable on the same Hook object", () => {
    const w = new World();
    w.component(Health);
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const result = w.component(Health).on("add", a).on("remove", b).on("set", c);
    expect(result).toBe(w.component(Health));
  });

  it("hook handlers compose in registration order and can be removed by reference", () => {
    const w = new World();
    const component = w.component(Health);
    const calls: string[] = [];
    const add = () => calls.push("add");
    const set = () => calls.push("set");
    const remove = () => calls.push("remove");

    // Multiple handlers on the same event fire in registration order.
    component.on("add", () => calls.push("first add"));
    component.on("add", add);

    component.on("set", () => calls.push("first set"));
    component.on("set", set);

    component.on("remove", () => calls.push("first remove"));
    component.on("remove", remove);

    const e = w.entity();
    e.set(Health, {});
    e.remove(Health);

    expect(calls).toEqual(["first add", "add", "first set", "set", "first remove", "remove"]);

    // off removes a handler by reference; the remaining handler still fires.
    component.off("add", add);
    component.off("set", set);
    component.off("remove", remove);

    w.entity().set(Health, {}).remove(Health);
    expect(calls).toEqual([
      "first add",
      "add",
      "first set",
      "set",
      "first remove",
      "remove",
      "first add",
      "first set",
      "first remove",
    ]);
  });
});
