import { describe, it, expect, vi } from "vitest";
import { Entity, Query, System, World } from "../src/index.js";

class Client {}
class View {
  radius = 0;
}
class Controls {
  ship = 0;
}
class Transfer {
  sector = 0;
}
/** Marker attached to system entities to group them into a silence domain. */
class Physics {}

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

function assertType<T extends true>(): void {}

function setup() {
  const w = new World();
  w.component(Client);
  w.component(View);
  w.component(Controls);
  w.component(Transfer);
  w.component(Physics);
  return { w, tick: () => w.progress(0, 0) };
}

/** Record every update callback as `[event, present, value]`, read at dispatch time. */
function recorder() {
  const calls: [string, boolean, number][] = [];
  const record = (e: Entity, c: Controls) => calls.push(["controls", e.has(Controls), c.ship]);
  return { calls, record };
}

describe("update({ watch, optional }) — System", () => {
  it("does not require the watched component for membership", () => {
    const { w, tick } = setup();
    const enter = vi.fn();
    const exit = vi.fn();
    const sys = w
      .system("views")
      .with(Client)
      .update({ watch: Controls, optional: true }, () => {})
      .enter(enter)
      .exit(exit);

    const e = w.entity().add(Client);
    tick();
    expect(sys.belongs(e)).toBe(true);
    expect(enter).toHaveBeenCalledWith(e);

    e.remove(Client);
    tick();
    expect(sys.belongs(e)).toBe(false);
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("routes changes of the watched component on a member", () => {
    const { w, tick } = setup();
    const { calls, record } = recorder();
    w.system("views").with(Client).update({ watch: Controls, optional: true }, record);

    const e = w.entity().add(Client).set(Controls, { ship: 1 });
    tick();
    expect(calls).toEqual([]);

    e.set(Controls, { ship: 2 });
    tick();
    expect(calls).toEqual([["controls", true, 2]]);
  });

  it("routes arrival on a member with onEnter and stays silent without it", () => {
    const { w, tick } = setup();
    const withEnter = recorder();
    const without = recorder();
    w.system("enter")
      .with(Client)
      .update({ watch: Controls, optional: true, onEnter: true }, withEnter.record);
    w.system("plain").with(Client).update({ watch: Controls, optional: true }, without.record);

    const e = w.entity().add(Client);
    tick();
    expect(withEnter.calls).toEqual([]);

    e.set(Controls, { ship: 3 });
    tick();
    expect(withEnter.calls).toEqual([["controls", true, 3]]);
    expect(without.calls).toEqual([]);

    e.set(Controls, { ship: 4 });
    tick();
    expect(withEnter.calls).toEqual([
      ["controls", true, 3],
      ["controls", true, 4],
    ]);
    expect(without.calls).toEqual([["controls", true, 4]]);
  });

  it("fires onEnter at entry only when the watched component is present", () => {
    const { w, tick } = setup();
    const { calls, record } = recorder();
    w.system("views")
      .with(Client)
      .update({ watch: Controls, optional: true, onEnter: true }, record);

    w.entity().add(Client);
    w.entity().add(Client).set(Controls, { ship: 5 });
    tick();
    expect(calls).toEqual([["controls", true, 5]]);
  });

  it("dispatches once when the entity and its watched component arrive together", () => {
    const { w, tick } = setup();
    const { calls, record } = recorder();
    w.system("views")
      .with(Client)
      .update({ watch: Controls, optional: true, onEnter: true }, record);

    w.entity().set(Controls, { ship: 6 }).add(Client);
    w.entity().add(Client).set(Controls, { ship: 7 });
    tick();
    expect(calls).toEqual([
      ["controls", true, 6],
      ["controls", true, 7],
    ]);
  });

  it("routes removal with onRemove, without exiting the entity", () => {
    const { w, tick } = setup();
    const { calls, record } = recorder();
    const exit = vi.fn();
    const sys = w
      .system("views")
      .with(Client)
      .update({ watch: Controls, optional: true, onRemove: true }, record)
      .exit(exit);

    const e = w.entity().add(Client).set(Controls, { ship: 8 });
    tick();
    e.remove(Controls);
    tick();
    expect(calls).toEqual([["controls", false, 8]]);
    expect(sys.belongs(e)).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it("leaves removal unobserved without onRemove", () => {
    const { w, tick } = setup();
    const { calls, record } = recorder();
    const exit = vi.fn();
    const sys = w
      .system("views")
      .with(Client)
      .update({ watch: Controls, optional: true, onEnter: true }, record)
      .exit(exit);

    const e = w.entity().add(Client).set(Controls, { ship: 9 });
    tick();
    calls.length = 0;
    e.remove(Controls);
    tick();
    expect(calls).toEqual([]);
    expect(sys.belongs(e)).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not route removal when the entity is destroyed", () => {
    const { w, tick } = setup();
    const { calls, record } = recorder();
    const exit = vi.fn();
    w.system("views")
      .with(Client)
      .update({ watch: Controls, optional: true, onRemove: true }, record)
      .exit(exit);

    const e = w.entity().add(Client).set(Controls, { ship: 10 });
    tick();
    e.destroy();
    tick();
    expect(calls).toEqual([]);
    expect(exit).toHaveBeenCalledWith(e);
  });

  it("watches several optional components from one system", () => {
    const { w, tick } = setup();
    const views: string[] = [];
    const recompute = (label: string) => (e: Entity) =>
      views.push(`${label}:${e.has(Controls)}:${e.has(Transfer)}`);
    w.system("UpdatePlayerViews")
      .with(Client, View)
      .update({ watch: Controls, optional: true, onEnter: true, onRemove: true }, recompute("c"))
      .update({ watch: Transfer, optional: true, onEnter: true, onRemove: true }, recompute("t"));

    const e = w.entity().add(Client).add(View);
    tick();
    e.add(Controls);
    tick();
    e.add(Transfer);
    tick();
    e.remove(Controls);
    tick();
    e.set(Transfer, { sector: 2 });
    tick();
    expect(views).toEqual(["c:true:false", "t:true:true", "c:false:true", "t:false:true"]);
  });

  it("applies ignoreSource silence to arrival, change and removal", () => {
    const { w, tick } = setup();
    const { calls, record } = recorder();
    w.system("views")
      .with(Client)
      .ignoreSource([Physics])
      .update({ watch: Controls, optional: true, onEnter: true, onRemove: true }, record);
    const e = w.entity().add(Client);
    let step = 0;
    const writer = w.system("writer").run(() => {
      step++;
      if (step === 1) {
        e.set(Controls, { ship: 1 });
      } else if (step === 2) {
        e.set(Controls, { ship: 2 });
      } else if (step === 3) {
        e.remove(Controls);
      }
    });
    writer.entity.add(Physics);

    tick();
    tick();
    tick();
    tick();
    expect(step).toBe(4);
    expect(calls).toEqual([]);

    e.set(Controls, { ship: 3 }); // unsourced write is not silenced
    tick();
    expect(calls).toEqual([["controls", true, 3]]);
  });

  it("reports the optional watch in watched without changing the predicate", () => {
    const { w, tick } = setup();
    const sys = w
      .system("views")
      .with(Client)
      .update({ watch: Controls, optional: true }, () => {});
    expect(sys.watched).toEqual([Controls]);
    const e = w.entity().add(Client);
    tick();
    expect(sys.belongs(e)).toBe(true);
  });
});

describe("update({ watch, optional }) — Query", () => {
  it("routes arrival, change and removal synchronously on a standalone query", () => {
    const { w } = setup();
    const { calls, record } = recorder();
    const q = w
      .query("views")
      .with(Client)
      .update({ watch: Controls, optional: true, onEnter: true, onRemove: true }, record)
      .build();

    const e = w.entity().add(Client);
    w.flush();
    expect(q.has(e)).toBe(true);
    expect(calls).toEqual([]);

    e.set(Controls, { ship: 1 });
    w.flush();
    e.set(Controls, { ship: 2 });
    w.flush();
    e.remove(Controls);
    w.flush();
    expect(calls).toEqual([
      ["controls", true, 1],
      ["controls", true, 2],
      ["controls", false, 2],
    ]);
    expect(q.has(e)).toBe(true);
  });

  it("without flags, routes only changes and keeps membership", () => {
    const { w } = setup();
    const { calls, record } = recorder();
    const q = w.query("views").with(Client).update({ watch: Controls, optional: true }, record);
    q.build();

    const e = w.entity().add(Client);
    w.flush();
    e.set(Controls, { ship: 1 });
    w.flush();
    e.set(Controls, { ship: 2 });
    w.flush();
    e.remove(Controls);
    w.flush();
    expect(calls).toEqual([["controls", true, 2]]);
    expect(q.has(e)).toBe(true);
  });

  it("rejects onRemove without optional", () => {
    const { w } = setup();
    // @ts-expect-error onRemove is only accepted on an optional watch.
    expect(() => w.query("views").update({ watch: Controls, onRemove: true }, () => {})).toThrow(
      "update watch of Controls: onRemove requires optional: true"
    );
  });

  it("keeps the query type and the callback's component non-optional", () => {
    const { w } = setup();
    const q = w
      .query("views")
      .with(Client)
      .update({ watch: Controls, optional: true, inject: [Client] }, (_e, c, [client]) => {
        assertType<IsEqual<typeof c, Controls>>();
        assertType<IsEqual<typeof client, Client>>();
      });
    assertType<IsEqual<typeof q, Query<[typeof Client]>>>();

    const sys = w
      .system("views")
      .with(Client)
      .update({ watch: Controls, optional: true, onRemove: true }, (_e, c) => {
        assertType<IsEqual<typeof c, Controls>>();
      });
    assertType<IsEqual<typeof sys, System<[typeof Client]>>>();
    expect(sys.watched).toEqual([Controls]);
  });
});
