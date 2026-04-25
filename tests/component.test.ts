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
    const e = w.createEntity();
    const h = e.add(Health);
    expect(h.type).toBe(42);
    expect(h.type).toBe(h.meta.type);
  });

  it("bitPtr is shorthand for meta.bitPtr", () => {
    const w = new World();
    w.registerComponent(Health);
    const h = w.createEntity().add(Health);
    expect(h.bitPtr).toBe(h.meta.bitPtr);
  });

  it("toString returns the component name", () => {
    const w = new World();
    w.registerComponent(Health, "HP");
    const h = w.createEntity().add(Health);
    expect(h.toString()).toBe("HP");
  });

  it("modified() queues an onSet hook delivery", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const h = env.w.createEntity().add(Health, false);
    h.modified();
    env.tick();
    expect(onSet).toHaveBeenCalledWith(h);
  });

  it("modified() is coalesced — onSet fires once even if called twice", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onSet = vi.fn();
    env.w.hook(Health).onSet(onSet);
    env.start();
    const h = env.w.createEntity().add(Health, false);
    h.modified();
    h.modified();
    h.modified();
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
    const h = env.w.createEntity().add(Health);
    expect(onAdd).toHaveBeenCalledWith(h);
  });

  it("onRemove fires when a component is removed", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onRemove = vi.fn();
    env.w.hook(Health).onRemove(onRemove);
    env.start();
    const e = env.w.createEntity();
    const h = e.add(Health);
    e.remove(Health);
    expect(onRemove).toHaveBeenCalledWith(h);
  });

  it("onRemove fires when the entity is destroyed", () => {
    const env = makeWorldWithFlushPhase();
    env.w.registerComponent(Health);
    const onRemove = vi.fn();
    env.w.hook(Health).onRemove(onRemove);
    env.start();
    const e = env.w.createEntity();
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
