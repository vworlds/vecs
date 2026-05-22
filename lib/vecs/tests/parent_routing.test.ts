import { describe, it, expect, vi } from "vitest";
import { World } from "../src/index.js";

class Container {}
class OtherContainer {}
class Item {}
class Tag {}

function setup() {
  const w = new World();
  w.registerComponent(Container);
  w.registerComponent(OtherContainer);
  w.registerComponent(Item);
  w.registerComponent(Tag);
  return { w };
}

describe("setParent - query routing for PARENT-dependent predicates", () => {
  it("fires enter when reparented under a matching parent", () => {
    const { w } = setup();
    const enter = vi.fn();
    w.query("inContainer").query({ PARENT: Container }).enter(enter).build();
    w.start();

    const parent = w.entity().add(Container);
    const child = w.entity();
    child.setParent(parent);

    expect(enter).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledWith(child);
  });

  it("fires exit when reparented away from a matching parent", () => {
    const { w } = setup();
    const enter = vi.fn();
    const exit = vi.fn();
    w.query("inContainer").query({ PARENT: Container }).enter(enter).exit(exit).build();
    w.start();

    const parent = w.entity().add(Container);
    const child = w.entity();
    child.setParent(parent);
    expect(enter).toHaveBeenCalledTimes(1);

    child.setParent(undefined);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(child);
  });

  it("fires exit then enter when moved between two matching parents of different types", () => {
    const { w } = setup();
    const inContainer = { enter: vi.fn(), exit: vi.fn() };
    const inOther = { enter: vi.fn(), exit: vi.fn() };

    w.query("inContainer")
      .query({ PARENT: Container })
      .enter(inContainer.enter)
      .exit(inContainer.exit)
      .build();
    w.query("inOther")
      .query({ PARENT: OtherContainer })
      .enter(inOther.enter)
      .exit(inOther.exit)
      .build();
    w.start();

    const c = w.entity().add(Container);
    const o = w.entity().add(OtherContainer);
    const child = w.entity();

    child.setParent(c);
    expect(inContainer.enter).toHaveBeenCalledTimes(1);
    expect(inOther.enter).toHaveBeenCalledTimes(0);

    child.setParent(o);
    expect(inContainer.exit).toHaveBeenCalledTimes(1);
    expect(inOther.enter).toHaveBeenCalledTimes(1);
  });

  it("does not fire enter/exit when reparenting to an entity with a non-matching parent", () => {
    const { w } = setup();
    const enter = vi.fn();
    const exit = vi.fn();
    w.query("inContainer").query({ PARENT: Container }).enter(enter).exit(exit).build();
    w.start();

    const nonContainer = w.entity();
    const child = w.entity();
    child.setParent(nonContainer);

    expect(enter).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not fire on a no-op reparent to the same parent", () => {
    const { w } = setup();
    const enter = vi.fn();
    const exit = vi.fn();
    w.query("inContainer").query({ PARENT: Container }).enter(enter).exit(exit).build();
    w.start();

    const parent = w.entity().add(Container);
    const child = w.entity();
    child.setParent(parent);
    expect(enter).toHaveBeenCalledTimes(1);

    child.setParent(parent);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it("handles nested PARENT inside AND/OR predicates", () => {
    const { w } = setup();
    const enter = vi.fn();
    w.query("taggedInContainer")
      .query({ AND: [Tag, { PARENT: Container }] })
      .enter(enter)
      .build();
    w.start();

    const parent = w.entity().add(Container);
    const child = w.entity().add(Tag);
    expect(enter).not.toHaveBeenCalled();

    child.setParent(parent);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("handles NOT { PARENT: ... } predicates symmetrically", () => {
    const { w } = setup();
    const enter = vi.fn();
    const exit = vi.fn();
    w.query("looseItems")
      .query({ AND: [Item, { NOT: { PARENT: Container } }] })
      .enter(enter)
      .exit(exit)
      .build();
    w.start();

    const parent = w.entity().add(Container);
    const item = w.entity().add(Item);
    expect(enter).toHaveBeenCalledTimes(1);

    item.setParent(parent);
    expect(exit).toHaveBeenCalledTimes(1);

    item.setParent(undefined);
    expect(enter).toHaveBeenCalledTimes(2);
  });

  it("fires inside deferred mode when the queue drains", () => {
    const { w } = setup();
    const enter = vi.fn();
    w.query("inContainer").query({ PARENT: Container }).enter(enter).build();
    w.start();

    const parent = w.entity().add(Container);
    const child = w.entity();

    w.defer(() => {
      child.setParent(parent);
      expect(enter).not.toHaveBeenCalled();
    });

    expect(enter).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledWith(child);
  });

  it("delivers reparent events through a System inbox on the next phase run", () => {
    const { w } = setup();
    const enter = vi.fn();
    const phase = w.addPhase("p");
    w.system("watch").phase(phase).query({ PARENT: Container }).enter(enter);

    w.start();

    const parent = w.entity().add(Container);
    const child = w.entity();
    child.setParent(parent);
    expect(enter).not.toHaveBeenCalled();

    w.progress(0, 0);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledWith(child);
  });

  it("does not fire reparent events on a destroyed entity", () => {
    const { w } = setup();
    const enter = vi.fn();
    const exit = vi.fn();
    w.query("inContainer").query({ PARENT: Container }).enter(enter).exit(exit).build();
    w.start();

    const parent = w.entity().add(Container);
    const child = w.entity();
    child.setParent(parent);
    enter.mockClear();
    exit.mockClear();

    child.destroy();
    expect(enter).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the world has no PARENT-dependent queries", () => {
    const { w } = setup();
    const enter = vi.fn();
    w.query("hasItem").requires(Item).enter(enter).build();
    w.start();

    const parent = w.entity().add(Container);
    const child = w.entity().add(Item);
    enter.mockClear();
    child.setParent(parent);

    expect(enter).not.toHaveBeenCalled();
  });

  it("re-evaluates correctly when component and parent both change in the same deferred batch", () => {
    const { w } = setup();
    const enter = vi.fn();
    w.query("taggedInContainer")
      .query({ AND: [Tag, { PARENT: Container }] })
      .enter(enter)
      .build();
    w.start();

    const parent = w.entity().add(Container);
    const child = w.entity();

    w.defer(() => {
      child.add(Tag);
      child.setParent(parent);
    });

    expect(enter).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledWith(child);
  });
});
