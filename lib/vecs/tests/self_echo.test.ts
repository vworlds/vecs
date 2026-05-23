import { describe, it, expect, vi } from "vitest";
import { World, type Entity } from "../src/index.js";

class Counter {
  value = 0;
}
class Foo {}
class Trigger {}

function setup() {
  const w = new World();
  w.registerComponent(Counter);
  w.registerComponent(Foo);
  w.registerComponent(Trigger);
  const phase = w.addPhase("p");
  return { w, phase };
}

describe("Self-echo suppression — update side", () => {
  it("entity.set inside .update handler does not re-fire the same system's update", () => {
    const { w, phase } = setup();
    const handler = vi.fn((e: Entity, c: Counter) => {
      e.set(Counter, { value: c.value + 1 });
    });
    w.system("S").phase(phase).update(Counter, handler);
    w.start();
    const e = w.entity().set(Counter, { value: 0 });

    w.progress(0, 0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(e.get(Counter)?.value).toBe(1);

    w.progress(0, 0);
    expect(handler).toHaveBeenCalledTimes(1); // self-write must not echo
    expect(e.get(Counter)?.value).toBe(1);
  });

  it("entity.modified inside .update handler does not re-fire the same system's update", () => {
    const { w, phase } = setup();
    const handler = vi.fn((e: Entity, c: Counter) => {
      c.value += 1;
      e.modified(Counter);
    });
    w.system("S").phase(phase).update(Counter, handler);
    w.start();
    const e = w.entity().set(Counter, { value: 0 });

    w.progress(0, 0);
    expect(handler).toHaveBeenCalledTimes(1);
    w.progress(0, 0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("entity.getMut inside .update handler does not re-fire the same system's update", () => {
    const { w, phase } = setup();
    const handler = vi.fn((e: Entity, c: Counter) => {
      const m = e.getMut(Counter)!;
      m.value = c.value + 1;
    });
    w.system("S").phase(phase).update(Counter, handler);
    w.start();
    const e = w.entity().set(Counter, { value: 0 });

    w.progress(0, 0);
    expect(handler).toHaveBeenCalledTimes(1);
    w.progress(0, 0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a different system watching the same component still sees the writer's update", () => {
    const { w, phase } = setup();
    const a = vi.fn((e: Entity, c: Counter) => {
      if (c.value === 0) e.set(Counter, { value: 1 });
    });
    const b = vi.fn();
    w.system("A").phase(phase).update(Counter, a);
    w.system("B").phase(phase).update(Counter, b);
    w.start();
    const e = w.entity().set(Counter, { value: 0 });

    w.progress(0, 0);
    expect(a).toHaveBeenCalledTimes(1);
    // B receives the initial set AND A's subsequent set.
    expect(b).toHaveBeenCalledTimes(2);
    expect(e.get(Counter)?.value).toBe(1);
  });

  it("non-system mutations still propagate to every watching system", () => {
    const { w, phase } = setup();
    const a = vi.fn();
    const b = vi.fn();
    w.system("A").phase(phase).update(Counter, a);
    w.system("B").phase(phase).update(Counter, b);
    w.start();
    const e = w.entity().set(Counter, { value: 0 });

    w.progress(0, 0);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    // External mutation (no current system) — both watchers must fire.
    e.set(Counter, { value: 7 });
    w.progress(0, 0);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });
});

describe("Self-echo suppression — exit is NOT suppressed", () => {
  it("a system removing its own watched component still fires its own exit", () => {
    const { w, phase } = setup();
    const exit = vi.fn();
    const update = vi.fn((e: Entity, c: Counter) => {
      if (c.value === 0) e.remove(Counter);
    });
    w.system("S").phase(phase).exit(exit).update(Counter, update);
    w.start();
    const e = w.entity().set(Counter, { value: 0 });

    w.progress(0, 0);
    expect(update).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls[0][0]).toBe(e);
  });

  it("a system can re-add a component inside its own exit handler without echoing", () => {
    const { w, phase } = setup();
    let removed = false;
    const exit = vi.fn((e: Entity) => {
      if (!removed) {
        removed = true;
        e.add(Foo); // re-add inside our own exit
      }
    });
    const enter = vi.fn();
    w.system("S").phase(phase).requires(Foo).enter(enter).exit(exit);
    w.start();
    const e = w.entity().add(Foo);

    w.progress(0, 0);
    expect(enter).toHaveBeenCalledTimes(1); // initial enter (external add, no origin)
    e.remove(Foo);

    w.progress(0, 0);
    // exit fires (we removed it), then exit handler re-adds Foo with origin=S.
    // The re-add must NOT re-fire S's enter (self-origin).
    expect(exit).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledTimes(1); // still 1 — no echo
  });
});

describe("Self-echo suppression — enter side", () => {
  it("a system that adds a watched component does not fire its own enter, but membership is tracked", () => {
    const { w, phase } = setup();
    const enter = vi.fn();
    let created = false;
    const creator = w
      .system("Creator")
      .phase(phase)
      .requires(Foo)
      .enter(enter)
      .run(() => {
        if (created) return;
        created = true;
        const x = w.entity();
        x.add(Foo);
      });
    w.start();

    w.progress(0, 0);
    w.progress(0, 0);

    expect(enter).not.toHaveBeenCalled();
    // The entity is still tracked by Creator:
    expect(creator.count).toBe(1);
  });

  it("a different system's enter still fires for an entity another system caused to match", () => {
    const { w, phase } = setup();
    const creatorEnter = vi.fn();
    const watcherEnter = vi.fn();
    let created = false;
    w.system("Creator")
      .phase(phase)
      .requires(Foo)
      .enter(creatorEnter)
      .run(() => {
        if (created) return;
        created = true;
        w.entity().add(Foo);
      });
    w.system("Watcher").phase(phase).requires(Foo).enter(watcherEnter);
    w.start();

    w.progress(0, 0);
    w.progress(0, 0);

    expect(creatorEnter).not.toHaveBeenCalled();
    expect(watcherEnter).toHaveBeenCalledTimes(1);
  });
});
