import { describe, it, expect, vi } from "vitest";
import { CommandKind } from "../src/command.js";
import { CleanupPolicy, Exclusive, Relationship, World } from "../src/index.js";

class Position {
  x = 0;
  y = 0;
}
class Velocity {
  vx = 0;
}
class Walking {}
class Running {}
class DeferredRemove {}
class DeferredDelete {}
class LinkedTo extends Relationship {}
class Counted {
  public static constructions = 0;
  public value = 0;

  public constructor() {
    Counted.constructions++;
  }
}

function setup() {
  const w = new World();
  w.component(Position);
  w.component(Velocity);
  w.component(Walking);
  w.component(Running);
  return {
    w,
    tick(now = 0, delta = 0) {
      w.progress(now, delta);
    },
  };
}

describe("Deferred mode — data-layer visibility", () => {
  it("applies relationship edge commands in FIFO order", () => {
    const w = new World();
    w.component(LinkedTo);
    const source = w.entity();
    const first = w.entity();
    const second = w.entity();

    w.defer(() => {
      source.add(LinkedTo, first);
      source.add(LinkedTo, second);
      source.remove(LinkedTo, first);
      expect(source.targets(LinkedTo)).toEqual([]);
    });

    expect(source.targets(LinkedTo)).toEqual([second]);
  });

  it("applies deferred exclusive replacements atomically in arrival order", () => {
    const w = new World();
    w.component(LinkedTo).add(Exclusive);
    const source = w.entity();
    const first = w.entity();
    const second = w.entity();

    w.defer(() => {
      source.add(LinkedTo, first);
      source.add(LinkedTo, second);
      source.add(LinkedTo, first);
    });

    expect(source.targets(LinkedTo)).toEqual([first]);
  });

  it("rejects cross-world targets before enqueue and during command execution", () => {
    const w = new World();
    const other = new World();
    const relationship = w.component(LinkedTo);
    other.component(LinkedTo);
    const source = w.entity();
    const foreignTarget = other.entity();

    w.defer(() => {
      expect(() => source.add(LinkedTo, foreignTarget)).toThrow(/same World/);
    });
    expect(() =>
      (w as any)._executeCommand({
        kind: CommandKind.AddTarget,
        entity: source,
        meta: relationship.meta,
        target: foreignTarget,
      })
    ).toThrow(/same World/);

    expect(source.has(LinkedTo)).toBe(false);
    expect(foreignTarget.children(LinkedTo)).not.toContain(source);
  });

  it("entity.get(C) returns undefined after entity.add(C) inside a system", () => {
    const { w, tick } = setup();
    const observed: any[] = [];
    w.system("test").run(() => {
      const e = w.entity();
      e.add(Position);
      observed.push(e.get(Position));
    });
    tick();
    expect(observed[0]).toBeUndefined();
  });

  it("entity.get(C) returns the previous value after entity.set(C, props) inside a system", () => {
    const { w, tick } = setup();
    const observed: number[] = [];
    let target: any;
    w.system("test").run(() => {
      target.set(Position, { x: 999 });
      // Defer mode: the new props haven't been applied yet.
      observed.push(target.get(Position).x);
    });
    target = w.entity();
    target.set(Position, { x: 7 });
    tick();
    expect(observed[0]).toBe(7);
  });

  it("entity.get(C) still returns the component after entity.remove(C) inside a system", () => {
    const { w, tick } = setup();
    const observed: any[] = [];
    let target: any;
    w.system("test").run(() => {
      target.remove(Position);
      observed.push(target.get(Position));
    });
    target = w.entity();
    target.add(Position);
    const pos = target.get(Position);
    tick();
    expect(observed[0]).toBe(pos);
  });

  it("entity.getMut(C) without a callback is allowed and marks modified inside defer", () => {
    const { w } = setup();
    const onSet = vi.fn();
    w.component(Position).on("set", onSet);
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    onSet.mockClear();

    let observed: Position | undefined;
    w.defer(() => {
      observed = e.getMut(Position);
      observed!.x = 3;
      expect(onSet).not.toHaveBeenCalled();
    });

    expect(observed).toBe(pos);
    expect(onSet).toHaveBeenCalledWith(e, pos);
  });

  it("entity.getMut(C) without a callback returns undefined for missing components inside defer", () => {
    const { w } = setup();
    const onSet = vi.fn();
    w.component(Position).on("set", onSet);
    const e = w.entity();

    let observed: Position | undefined;
    w.defer(() => {
      observed = e.getMut(Position);
    });

    expect(observed).toBeUndefined();
    expect(onSet).not.toHaveBeenCalled();
  });

  it("entity.ensure(C) without a callback creates a mutable component inside defer", () => {
    const { w } = setup();
    const onAdd = vi.fn();
    const onSet = vi.fn();
    w.component(Position).on("add", onAdd).on("set", onSet);
    const e = w.entity();

    let observed: Position | undefined;
    w.defer(() => {
      observed = e.ensure(Position);
      observed!.x = 3;
      expect(e.get(Position)).toBeUndefined();
      expect(onAdd).not.toHaveBeenCalled();
      expect(onSet).not.toHaveBeenCalled();
    });

    expect(e.get(Position)).toBe(observed);
    expect(observed?.x).toBe(3);
    expect(onAdd).toHaveBeenCalledWith(e, observed);
    expect(onSet).toHaveBeenCalledWith(e, observed);
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("repeated ensure calls share one pending component instance", () => {
    const { w } = setup();
    Counted.constructions = 0;
    const component = w.component(Counted);
    const onAdd = vi.fn();
    const onSet = vi.fn();
    component.on("add", onAdd).on("set", onSet);
    const e = w.entity();

    let first: Counted | undefined;
    let second: Counted | undefined;
    w.defer(() => {
      first = e.ensure(Counted, (value) => {
        value.value = 1;
      });
      second = e.ensure(Counted, (value) => {
        value.value++;
      });

      expect(second).toBe(first);
      expect(second.value).toBe(2);
      expect(e.get(Counted)).toBeUndefined();
      expect(component.meta._pendingEnsures?.get(e)).toBe(first);
    });

    expect(Counted.constructions).toBe(1);
    expect(e.get(Counted)).toBe(first);
    expect(e.get(Counted)?.value).toBe(2);
    expect(component.meta._pendingEnsures?.get(e)).toBeUndefined();
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("clears a pending ensure when its attachment reaches a destroyed entity", () => {
    const { w } = setup();
    const component = w.component(Counted);
    const e = w.entity();

    w.defer(() => {
      e.destroy();
      e.ensure(Counted);
      expect(component.meta._pendingEnsures?.has(e)).toBe(true);
    });

    expect(e.destroyed).toBe(true);
    expect(component.meta._pendingEnsures?.has(e)).toBe(false);
  });

  it("at top level, mutations are immediately visible", () => {
    const { w } = setup();
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
    w.beginDefer();
    const e = w.entity();
    expect(w.entity(e.eid)).toBe(e);
    expect(w.getEntity(e.eid)).toBe(e);
    expect(w.entities.get(e.eid)).toBeUndefined();
    w.endDefer();
    expect(w.entity(e.eid)).toBe(e);
    expect(w.getEntity(e.eid)).toBe(e);
    expect(w.entities.get(e.eid)).toBe(e);
  });

  it("getOrCreateEntity inside a deferred block does not appear in world.entities until drain", () => {
    const { w } = setup();
    w.beginDefer();
    const e = w.getOrCreateEntity(1234);
    expect(w.entity(e.eid)).toBe(e);
    expect(w.getEntity(e.eid)).toBe(e);
    expect(w.entities.get(e.eid)).toBeUndefined();
    w.endDefer();
    expect(w.entity(e.eid)).toBe(e);
    expect(w.getEntity(e.eid)).toBe(e);
    expect(w.entities.get(e.eid)).toBe(e);
  });

  it("getOrCreateEntity returns the same pending entity inside a deferred block", () => {
    const { w } = setup();
    w.beginDefer();
    const first = w.getOrCreateEntity(1234);
    const second = w.getOrCreateEntity(1234);
    expect(second).toBe(first);
    expect(w.entity(first.eid)).toBe(first);
    expect(w.getEntity(first.eid)).toBe(first);
    expect(w.entities.get(first.eid)).toBeUndefined();
    w.endDefer();
    expect(w.entity(first.eid)).toBe(first);
    expect(w.getEntity(first.eid)).toBe(first);
    expect(w.entities.get(first.eid)).toBe(first);
  });

  it("getOrCreateEntity runs its onCreate callback at drain in deferred mode", () => {
    const { w } = setup();
    const seen: number[] = [];
    w.beginDefer();
    const e = w.getOrCreateEntity(1234, (created) => seen.push(created.eid));
    expect(seen).toEqual([]); // deferred until drain
    w.endDefer();
    expect(seen).toEqual([e.eid]);
  });

  it("world.entity() inside a Filter.forEach is not visited by the same iteration", () => {
    const { w } = setup();
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
    w.component(Position).on("add", onAdd);
    const e = w.entity();
    w.beginDefer();
    e.add(Position);
    expect(onAdd).not.toHaveBeenCalled();
    w.endDefer();
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(e.get(Position)).toBeInstanceOf(Position);
  });

  it("flush() outside any begin/end is a no-op (queue already empty)", () => {
    const { w } = setup();
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
    w.query("q").with(Position).enter(enter).build();
    const e = w.entity();
    e.add(Position);
    expect(enter).toHaveBeenCalledWith(e);
  });

  it("Query.update callback fires immediately on c.modified()", () => {
    const { w } = setup();
    const update = vi.fn();
    w.query("q").with(Position).update(Position, update).build();
    const e = w.entity();
    const pos = e.add(Position).get(Position)!;
    update.mockClear();
    e.modified(Position);
    expect(update).toHaveBeenCalledWith(e, pos);
  });
});

describe("Deferred mode — System inbox ordering", () => {
  it("system inbox replays enter -> exit -> enter in arrival order", () => {
    const { w, tick } = setup();
    const events: string[] = [];
    w.system("test")
      .with(Position)
      .enter((e) => events.push(`enter ${e.eid}`))
      .exit((e) => events.push(`exit ${e.eid}`))
      .build();
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
    w.component(Position).on("add", onAdd);
    w.component(Position).on("remove", onRemove);
    const e = w.entity();
    w.beginDefer();
    e.add(Position);
    e.remove(Position);
    w.endDefer();
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
    w.component(Walking).on("remove", () => order.push("onRemove Walking"));
    w.component(Running).on("add", () => order.push("onAdd Running"));
    const e = w.entity();
    e.add(Walking);
    order.length = 0;
    e.add(Running);
    expect(order).toEqual(["onRemove Walking", "onAdd Running"]);
  });
});

describe("Deferred mode — parent destruction", () => {
  it("child's exit observes parent already removed from world.entities", () => {
    const { w, tick } = setup();
    let observedParentId: number | undefined;
    let parentEid = -1;
    w.system("test")
      .with(Position)
      .exit((e) => {
        observedParentId = w.getEntity(parentEid)?.eid;
        // Parent was destroyed before this child's exit fires (top-down).
      });
    const parent = w.entity();
    parentEid = parent.eid;
    const child = w.entity();
    child.childOf(parent);
    child.add(Position);
    tick(); // settle enter
    parent.destroy();
    tick(); // process Destroy + drain inbox
    expect(observedParentId).toBeUndefined();
  });
});

describe("World.defer(fn)", () => {
  it("mutations inside defer() are queued and applied after the callback returns", () => {
    const { w } = setup();
    const e = w.entity();
    let visibleDuring: Position | undefined;
    w.defer(() => {
      e.add(Position);
      visibleDuring = e.get(Position);
    });
    expect(visibleDuring).toBeUndefined();
    expect(e.get(Position)).toBeInstanceOf(Position);
  });

  it("hooks fire after defer() returns, not during the callback", () => {
    const { w } = setup();
    const onAdd = vi.fn();
    w.component(Position).on("add", onAdd);
    const e = w.entity();
    w.defer(() => {
      e.add(Position);
      expect(onAdd).not.toHaveBeenCalled();
    });
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("error thrown in fn propagates but the queue still drains via finally", () => {
    const { w } = setup();
    const onAdd = vi.fn();
    w.component(Position).on("add", onAdd);
    const e = w.entity();
    expect(() =>
      w.defer(() => {
        e.add(Position);
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(e.get(Position)).toBeInstanceOf(Position);
  });

  it("nested defer() only drains when the outermost callback exits", () => {
    const { w } = setup();
    const onAdd = vi.fn();
    w.component(Position).on("add", onAdd);
    w.component(Velocity).on("add", onAdd);
    const e = w.entity();
    w.defer(() => {
      e.add(Position);
      w.defer(() => {
        e.add(Velocity);
        expect(e.get(Position)).toBeUndefined();
        expect(e.get(Velocity)).toBeUndefined();
      });
      // inner endDefer ran but outer depth is still 1 — nothing drained yet
      expect(e.get(Velocity)).toBeUndefined();
    });
    expect(e.get(Position)).toBeInstanceOf(Position);
    expect(e.get(Velocity)).toBeInstanceOf(Velocity);
    expect(onAdd).toHaveBeenCalledTimes(2);
  });

  it("applies component entity onDelete cleanup during deferred drain", () => {
    {
      const w = new World();
      const componentEntity = w.component(DeferredRemove);
      componentEntity.meta.onDelete = CleanupPolicy.Remove;
      w.component(Velocity);
      const carrier = w.entity().add(DeferredRemove);
      const sentinel = w.entity();

      w.defer(() => {
        componentEntity.destroy();
        sentinel.add(Velocity);
      });

      expect(carrier.destroyed).toBe(false);
      expect(carrier._get(componentEntity.eid)).toBeUndefined();
      expect(sentinel.get(Velocity)).toBeInstanceOf(Velocity);
      expect(componentEntity.destroyed).toBe(true);
    }

    {
      const w = new World();
      const componentEntity = w.component(DeferredDelete);
      componentEntity.meta.onDelete = CleanupPolicy.Delete;
      w.component(Velocity);
      const carrier = w.entity().add(DeferredDelete);
      const sentinel = w.entity();

      w.defer(() => {
        componentEntity.destroy();
        sentinel.add(Velocity);
      });

      expect(() => w.entity(carrier.eid)).toThrow();
      expect(sentinel.get(Velocity)).toBeInstanceOf(Velocity);
      expect(componentEntity.destroyed).toBe(true);
    }
  });
});

describe("Deferred mode — forEach nesting", () => {
  it("Query.forEach defers mutations made inside the callback", () => {
    const { w } = setup();
    const a = w.entity();
    a.add(Position);
    const b = w.entity();
    b.add(Position);
    const q = w.query("q").with(Position).build();
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
