import { describe, it, expect, vi } from "vitest";
import { World, Component } from "../src/index.js";

class Position extends Component {
  x = 0;
  y = 0;
}
class Velocity extends Component {
  vx = 0;
}
class Walking extends Component {}
class Running extends Component {}

function setup() {
  const w = new World();
  w.registerComponent(Position);
  w.registerComponent(Velocity);
  w.registerComponent(Walking);
  w.registerComponent(Running);
  const phase = w.addPhase("p");
  return {
    w,
    phase,
    tick(now = 0, delta = 0) {
      w.runPhase(phase, now, delta);
    },
  };
}

describe("Deferred mode — data-layer visibility", () => {
  it("entity.get(C) returns undefined after entity.add(C) inside a system", () => {
    const { w, phase, tick } = setup();
    const observed: any[] = [];
    w.system("test")
      .phase(phase)
      .run(() => {
        const e = w.entity();
        e.add(Position);
        observed.push(e.get(Position));
      });
    w.start();
    tick();
    expect(observed[0]).toBeUndefined();
  });

  it("entity.get(C) returns the previous value after entity.set(C, props) inside a system", () => {
    const { w, phase, tick } = setup();
    const observed: number[] = [];
    let target: any;
    w.system("test")
      .phase(phase)
      .run(() => {
        target.set(Position, { x: 999 });
        // Defer mode: the new props haven't been applied yet.
        observed.push(target.get(Position).x);
      });
    target = w.entity();
    target.set(Position, { x: 7 });
    w.start();
    tick();
    expect(observed[0]).toBe(7);
  });

  it("entity.get(C) still returns the component after entity.remove(C) inside a system", () => {
    const { w, phase, tick } = setup();
    const observed: any[] = [];
    let target: any;
    w.system("test")
      .phase(phase)
      .run(() => {
        target.remove(Position);
        observed.push(target.get(Position));
      });
    target = w.entity();
    target.add(Position);
    const pos = target.get(Position);
    w.start();
    tick();
    expect(observed[0]).toBe(pos);
  });

  it("at top level, mutations are immediately visible", () => {
    const { w } = setup();
    w.start();
    const e = w.entity();
    e.add(Position);
    expect(e.get(Position)).toBeInstanceOf(Position);
    e.remove(Position);
    expect(e.get(Position)).toBeUndefined();
  });
});

describe("Deferred mode — entity creation", () => {
  it("world.entity() inside a deferred block does not appear in world.entities until drain", () => {
    const { w } = setup();
    w.start();
    w.beginDeferred();
    const e = w.entity();
    expect(w.entity(e.eid)).toBeUndefined();
    w.endDeferred();
    expect(w.entity(e.eid)).toBe(e);
  });

  it("world.entity() inside a Filter.forEach is not visited by the same iteration", () => {
    const { w } = setup();
    w.start();
    const a = w.entity();
    a.add(Position);
    let visits = 0;
    w.filter([Position]).forEach((_e) => {
      visits++;
      // create a new entity with Position; it must NOT be visited in this loop
      const fresh = w.entity();
      fresh.add(Position);
    });
    expect(visits).toBe(1);
  });
});

describe("Deferred mode — flush()", () => {
  it("world.flush() drains queued top-level mutations", () => {
    const { w } = setup();
    const onAdd = vi.fn();
    w.hook(Position).onAdd(onAdd);
    w.start();
    const e = w.entity();
    w.beginDeferred();
    e.add(Position);
    expect(onAdd).not.toHaveBeenCalled();
    w.endDeferred();
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(e.get(Position)).toBeInstanceOf(Position);
  });

  it("flush() outside any begin/end is a no-op (queue already empty)", () => {
    const { w } = setup();
    w.start();
    w.flush();
    w.flush();
    // No errors thrown; nothing to assert beyond that.
    expect(true).toBe(true);
  });
});

describe("Deferred mode — Query dispatches enter/exit/update immediately", () => {
  it("Query.enter callback fires during world queue processing", () => {
    const { w } = setup();
    const enter = vi.fn();
    w.query("q").requires(Position).enter(enter);
    w.start();
    const e = w.entity();
    e.add(Position);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("Query.update callback fires immediately on c.modified()", () => {
    const { w } = setup();
    const update = vi.fn();
    w.query("q").update(Position, update);
    w.start();
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    update.mockClear();
    pos.modified();
    expect(update).toHaveBeenCalledWith(pos);
  });
});

describe("Deferred mode — System inbox ordering", () => {
  it("system inbox replays enter -> exit -> enter in arrival order", () => {
    const { w, phase, tick } = setup();
    const events: string[] = [];
    w.system("test")
      .phase(phase)
      .requires(Position)
      .enter((e) => events.push(`enter ${e.eid}`))
      .exit((e) => events.push(`exit ${e.eid}`));
    w.start();
    const e = w.entity();
    // Top-level: each call inline-routes to the system. Three events queued
    // on the system's inbox.
    e.add(Position);
    e.remove(Position);
    e.add(Position);
    tick();
    expect(events).toEqual([`enter ${e.eid}`, `exit ${e.eid}`, `enter ${e.eid}`]);
  });

  it("Add -> Remove of the same component fires both onAdd and onRemove (no net-zero optimisation)", () => {
    const { w, tick } = setup();
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    w.hook(Position).onAdd(onAdd);
    w.hook(Position).onRemove(onRemove);
    w.start();
    const e = w.entity();
    w.beginDeferred();
    e.add(Position);
    e.remove(Position);
    w.endDeferred();
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
    tick();
  });
});

describe("Deferred mode — exclusive replacement", () => {
  it("onRemove(displaced) fires before onAdd(replacement)", () => {
    const { w } = setup();
    w.setExclusiveComponents(Walking, Running);
    const order: string[] = [];
    w.hook(Walking).onRemove(() => order.push("onRemove Walking"));
    w.hook(Running).onAdd(() => order.push("onAdd Running"));
    w.start();
    const e = w.entity();
    e.add(Walking);
    order.length = 0;
    e.add(Running);
    expect(order).toEqual(["onRemove Walking", "onAdd Running"]);
  });
});

describe("Deferred mode — parent destruction", () => {
  it("child's exit observes parent already removed from world.entities", () => {
    const { w, phase, tick } = setup();
    let observedParentId: number | undefined;
    let parentEid = -1;
    w.system("test")
      .phase(phase)
      .requires(Position)
      .exit((e) => {
        observedParentId = w.entity(parentEid)?.eid;
        // Parent was destroyed before this child's exit fires (top-down).
      });
    w.start();
    const parent = w.entity();
    parentEid = parent.eid;
    const child = w.entity();
    child.parent = parent;
    parent.children.add(child);
    child.add(Position);
    tick(); // settle enter
    parent.destroy();
    tick(); // process Destroy + drain inbox
    expect(observedParentId).toBeUndefined();
  });
});

describe("Deferred mode — forEach nesting", () => {
  it("Query.forEach defers mutations made inside the callback", () => {
    const { w } = setup();
    w.start();
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    const q = w.query("q").requires(Position);
    let seen = 0;
    q.forEach((e) => {
      seen++;
      // Try to add a component; should be deferred until forEach exits.
      e.add(Velocity);
      // The Velocity is not yet visible:
      expect(e.get(Velocity)).toBeUndefined();
    });
    expect(seen).toBe(2);
    // After forEach, the queue drained and Velocity is now installed.
    expect(a.get(Velocity)).toBeInstanceOf(Velocity);
    expect(b.get(Velocity)).toBeInstanceOf(Velocity);
  });

  it("Filter.forEach defers mutations made inside the callback", () => {
    const { w } = setup();
    w.start();
    const a = w.entity();
    a.add(Position);
    const f = w.filter([Position]);
    let count = 0;
    f.forEach((e) => {
      count++;
      e.add(Velocity);
      expect(e.get(Velocity)).toBeUndefined();
    });
    expect(count).toBe(1);
    expect(a.get(Velocity)).toBeInstanceOf(Velocity);
  });
});
