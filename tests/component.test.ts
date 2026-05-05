import { describe, it, expect, vi } from "vitest";
import { World, Component } from "../src/index.js";
import { makeWorldWithFlushPhase } from "./_helpers.js";

class Health extends Component {
  hp = 10;
}

describe("Component", () => {
  it("type is shorthand for meta.type", () => {
    const w = new World();
    w.registerComponent(Health, 42);
    const e = w.entity();
    const h = e.add(Health).get(Health)!;
    expect(h.type).toBe(42);
    expect(h.type).toBe(h.meta.type);
  });

  it("bitPtr is shorthand for meta.bitPtr", () => {
    const w = new World();
    w.registerComponent(Health);
    const h = w.entity().add(Health).get(Health)!;
    expect(h.bitPtr).toBe(h.meta.bitPtr);
  });

  it("toString returns the component name", () => {
    const w = new World();
    w.registerComponent(Health, "HP");
    const h = w.entity().add(Health).get(Health)!;
    expect(h.toString()).toBe("HP");
  });

  it("modified() queues an onSet hook delivery", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const h = env.w.entity().add(Health).get(Health)!;
    h.modified();
    env.tick();
    expect(onSet).toHaveBeenCalledWith(h);
  });

  it("modified() in deferred mode is coalesced — onSet fires once even if called multiple times", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const h = env.w.entity().add(Health).get(Health)!;
    onSet.mockClear();
    env.w.beginDefer();
    h.modified();
    h.modified();
    h.modified();
    env.w.endDefer();
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("modified() at top level fires onSet immediately on each call", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const h = env.w.entity().add(Health).get(Health)!;
    onSet.mockClear();
    h.modified();
    h.modified();
    h.modified();
    expect(onSet).toHaveBeenCalledTimes(3);
  });
});

describe("Entity.modified", () => {
  it("returns the entity for chaining", () => {
    const w = new World();
    w.registerComponent(Health);
    const e = w.entity();
    const h = e.add(Health).get(Health)!;
    expect(e.modified(h)).toBe(e);
  });

  it("queues an onSet hook delivery", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const e = env.w.entity();
    const h = e.add(Health).get(Health)!;
    e.modified(h);
    env.tick();
    expect(onSet).toHaveBeenCalledWith(h);
  });

  it("is coalesced in deferred mode — onSet fires once even if called multiple times", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const e = env.w.entity();
    const h = e.add(Health).get(Health)!;
    onSet.mockClear();
    env.w.beginDefer();
    e.modified(h);
    e.modified(h);
    e.modified(h);
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
    e.add(Health).modified(e.get(Health)!);
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
    const h = env.w.entity().add(Health).get(Health)!;
    expect(onAdd).toHaveBeenCalledWith(h);
  });

  it("onSet fires when a component value is set", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);

    const set_values: number[] = [];
    const onSet = vi.fn((c) => set_values.push(c.hp));

    const onAdd = vi.fn();
    env.w.hook(Health).onSet(onSet).onAdd(onAdd);
    env.start();
    const e = env.w.entity();
    const h = e.set(Health, { hp: 99 }).get(Health)!;

    e.set(Health, { hp: 200 });

    expect(onAdd).toHaveBeenCalledWith(h);
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onSet).toHaveBeenCalledWith(h);
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
    expect(onRemove).toHaveBeenCalledWith(h);
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
});
