import { describe, it, expect, vi } from "vitest";
import { World } from "../src/index.js";
import { makeWorldWithFlushPhase } from "./_helpers.js";

class Health {
  hp = 10;
}

describe("ComponentMeta", () => {
  it("stores the component name", () => {
    const w = new World();
    const meta = w.registerComponent(Health, "HP");
    expect(meta.componentName).toBe("HP");
  });

  it("entity.modified(C) queues an onSet hook delivery", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const e = env.w.entity();
    const h = e.add(Health).get(Health)!;
    e.modified(Health);
    env.tick();
    expect(onSet).toHaveBeenCalledWith(e, h);
  });

  it("entity.modified(C) in deferred mode is coalesced — onSet fires once even if called multiple times", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const e = env.w.entity();
    e.add(Health);
    onSet.mockClear();
    env.w.beginDefer();
    e.modified(Health);
    e.modified(Health);
    e.modified(Health);
    env.w.endDefer();
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("entity.modified(C) at top level fires onSet immediately on each call", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const e = env.w.entity();
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
    w.registerComponent(Health);
    const e = w.entity();
    e.add(Health);
    expect(e.modified(Health)).toBe(e);
  });

  it("queues an onSet hook delivery", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const e = env.w.entity();
    const h = e.add(Health).get(Health)!;
    e.modified(Health);
    env.tick();
    expect(onSet).toHaveBeenCalledWith(e, h);
  });

  it("is coalesced in deferred mode — onSet fires once even if called multiple times", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const e = env.w.entity();
    e.add(Health);
    onSet.mockClear();
    env.w.beginDefer();
    e.modified(Health);
    e.modified(Health);
    e.modified(Health);
    env.w.endDefer();
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("can be chained after add", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const e = env.w.entity();
    e.add(Health).modified(Health);
    env.tick();
    expect(onSet).toHaveBeenCalledTimes(1);
  });
});

describe("Hook", () => {
  it("onAdd fires when a component is first attached", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onAdd = vi.fn();
    env.w.hook(Health).onAdd(onAdd);
    env.start();
    const e = env.w.entity();
    const h = e.add(Health).get(Health)!;
    expect(onAdd).toHaveBeenCalledWith(e, h);
  });

  it("onSet fires when a component value is set", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);

    const set_values: number[] = [];
    const onSet = vi.fn((_e, c) => set_values.push(c.hp));

    const onAdd = vi.fn();
    env.w.hook(Health).onSet(onSet).onAdd(onAdd);
    env.start();
    const e = env.w.entity();
    const h = e.set(Health, { hp: 99 }).get(Health)!;

    e.set(Health, { hp: 200 });

    expect(onAdd).toHaveBeenCalledWith(e, h);
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onSet).toHaveBeenCalledWith(e, h);
    expect(onSet).toHaveBeenCalledTimes(2);
    expect(set_values).toEqual([99, 200]);
  });

  it("onRemove fires when a component is removed", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onRemove = vi.fn();
    env.w.hook(Health).onRemove(onRemove);
    env.start();
    const e = env.w.entity();
    const h = e.add(Health).get(Health)!;
    e.remove(Health);
    expect(onRemove).toHaveBeenCalledWith(e, h);
  });

  it("onRemove fires when the entity is destroyed", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onRemove = vi.fn();
    env.w.hook(Health).onRemove(onRemove);
    env.start();
    const e = env.w.entity();
    e.add(Health);
    e.destroy();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("hooks are chainable on the same Hook object", () => {
    const w = new World();
    w.registerComponent(Health);
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const result = w.hook(Health).onAdd(a).onRemove(b).onSet(c);
    expect(result).toBe(w.hook(Health));
  });

  it("repeated hook registrations stack in registration order", () => {
    const w = new World();
    w.registerComponent(Health);
    const calls: string[] = [];
    w.hook(Health)
      .onAdd(() => calls.push("add 1"))
      .onAdd(() => calls.push("add 2"))
      .onSet(() => calls.push("set 1"))
      .onSet(() => calls.push("set 2"))
      .onRemove(() => calls.push("remove 1"))
      .onRemove(() => calls.push("remove 2"));

    const e = w.entity();
    e.set(Health, {});
    e.remove(Health);

    expect(calls).toEqual(["add 2", "add 1", "set 2", "set 1", "remove 2", "remove 1"]);
  });
});
