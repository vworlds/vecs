import { afterEach, describe, expect, it, vi } from "vitest";
import { World } from "@vworlds/vecs";
import { LocalWorld } from "../../src/bridge/world.js";
import { WATCH_IDLE_MS } from "../../src/bridge/watch.js";

class A {
  x = 1;
}
class B {
  y = 2;
}
class Other {
  z = 3;
}
const locals: LocalWorld[] = [];
afterEach(() => {
  for (const local of locals.splice(0)) {
    local.watches.close("one");
    local.watches.close("two");
  }
  vi.useRealTimers();
});
function setup() {
  const world = new World();
  world.component(A);
  world.component(B);
  world.component(Other);
  const entity = world.entity("sample").add(A);
  world.flush();
  const local = new LocalWorld(world, true);
  locals.push(local);
  return { world, entity, local };
}
function create(local: LocalWorld, params = {}) {
  return local.command("vecs_watch", {
    _session: "one",
    where: "A",
    include: ["A"],
    ...params,
  }) as { watch: string; members: number };
}
function read(local: LocalWorld, watch: string, params = {}) {
  return local.watches.read({ _session: "one", watch, ...params });
}

describe("watch logs", () => {
  it.each(
    ["source", "children"].flatMap((operator) => {
      const term = operator === "source" ? { source: ["ChildOf", "A"] } : { children: "A" };
      return [
        { label: operator, where: term },
        { label: `${operator} in array`, where: ["A", term] },
        { label: `${operator} in all`, where: { all: ["A", term] } },
        { label: `${operator} in any`, where: { any: ["A", term] } },
        { label: `${operator} in not`, where: { not: term } },
        { label: `${operator} in target`, where: { target: ["ChildOf", term] } },
        { label: `${operator} in parent`, where: { parent: term } },
      ].map((row) => ({ ...row, operator }));
    })
  )("rejects $label without leaving queries or hooks behind", ({ where, operator, label }) => {
    const { local, world, entity } = setup();
    world.entity("child").add(A).childOf(entity);
    world.flush();
    const baseline = world.queries.length;
    const hook = world.component(A).meta._onSet;
    expect(() => create(local, { where })).toThrow(
      `${operator} is filter-only: vecs_find supports it, vecs_watch does not`
    );
    expect(world.queries.length).toBe(baseline);
    expect(world.component(A).meta._onSet).toBe(hook);
    expect(local.watches.ids("one")).toEqual([]);
    const total = label.endsWith("in not")
      ? world.entities.size - 1
      : label.endsWith("in any")
        ? 2
        : 1;
    expect(local.command("vecs_find", { where })).toMatchObject({ total });
  });

  it.each([
    { label: "parent", where: { parent: "A" } },
    { label: "target", where: { target: ["ChildOf", "A"] } },
  ])("keeps $label reactive", ({ where }) => {
    const { local, world, entity } = setup();
    const child = world.entity("child").add(A).childOf(entity);
    const { watch, members } = create(local, { where, include: [] });
    expect(members).toBe(1);
    entity.remove(A);
    entity.add(A);
    expect(read(local, watch).events).toEqual([
      { seq: 1, kind: "exit", eid: child.eid, name: "child" },
      { seq: 2, kind: "enter", eid: child.eid, name: "child" },
    ]);
  });

  it("supports numeric browser timers without requiring Node timer methods", () => {
    const { local, entity } = setup();
    const timeout = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(42 as unknown as ReturnType<typeof setTimeout>);
    const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      const { watch } = create(local);
      entity.set(A, { x: 7 });
      expect(read(local, watch).events[0].value).toEqual({ x: 7 });
      local.watches.remove({ watch, _session: "one" });
      expect(clear).toHaveBeenCalledWith(42);
    } finally {
      timeout.mockRestore();
      clear.mockRestore();
    }
  });

  it("registers nothing without watches and restores queries and hook slots on teardown", () => {
    const { world, local, entity } = setup();
    const baseline = world.queries.length;
    const hooks = world.component(A).meta._onSet;
    const updateWatchers = world._updateWatchers.map((entry) => entry?.queries.length ?? 0);
    expect(world._updateWatchers[world.component(A).eid]).toBeUndefined();
    expect(world._updateWatchers[world.component(B).eid]).toBeUndefined();
    local.command("vecs_find", { where: "A" });
    entity.set(A, { x: 2 });
    expect(world.queries.length).toBe(baseline);
    expect(world.component(A).meta._onSet).toBe(hooks);
    const { watch, members } = create(local);
    expect(members).toBe(1);
    expect(world.queries.length).toBe(baseline + 1);
    expect(world.component(A).meta._onSet).not.toBe(hooks);
    expect(read(local, watch)).toEqual({ events: [], latest: 0, dropped: 0 });
    local.command("vecs_unwatch", { watch, _session: "one" });
    expect(world.queries.length).toBe(baseline);
    expect(world.component(A).meta._onSet).toBe(hooks);
    expect(world._updateWatchers.map((entry) => entry?.queries.length ?? 0)).toEqual(
      updateWatchers
    );
    expect(() => read(local, watch)).toThrow("Unknown watch");
  });

  it("preserves where membership with absent/multiple includes and records ordered snapshots", () => {
    const { world, entity, local } = setup();
    const { watch, members } = create(local, { include: ["A", "B", "B"] });
    expect(members).toBe(1);
    entity.set(A, { x: 5 });
    entity.set(Other, { z: 9 });
    const newcomer = world.entity("new").add(A);
    newcomer.set(B, { y: 7 });
    entity.remove(A);
    expect(read(local, watch)).toEqual({
      latest: 4,
      dropped: 0,
      events: [
        {
          seq: 1,
          kind: "update",
          eid: entity.eid,
          name: "sample",
          component: "A",
          value: { x: 5 },
        },
        { seq: 2, kind: "enter", eid: newcomer.eid, name: "new", value: { A: { x: 1 } } },
        { seq: 3, kind: "update", eid: newcomer.eid, name: "new", component: "B", value: { y: 7 } },
        { seq: 4, kind: "exit", eid: entity.eid, name: "sample" },
      ],
    });
    newcomer.set(B, { y: 8 });
    expect(read(local, watch).events[2].value).toEqual({ y: 7 });
  });

  it("uses a ring, counts overflow and pages strictly after since", () => {
    const { entity, local } = setup();
    const { watch } = create(local, { maxEvents: 2 });
    for (let x = 2; x <= 5; x++) {
      entity.set(A, { x });
    }
    expect(read(local, watch)).toMatchObject({
      latest: 4,
      dropped: 2,
      events: [{ seq: 3 }, { seq: 4 }],
    });
    expect(read(local, watch, { since: 2, limit: 1 }).events.map((e) => e.seq)).toEqual([3]);
    expect(read(local, watch, { since: 3 }).events.map((e) => e.seq)).toEqual([4]);
    expect(read(local, watch, { limit: 0 }).events).toEqual([]);
    expect(() => read(local, watch, { since: -1 })).toThrow("since");
    expect(() => create(local, { maxEvents: 0 })).toThrow("maxEvents");
  });

  it("preserves existing hooks, and observes attach/getMut/ensure/modified only for matched carriers", () => {
    const { local, world, entity } = setup();
    const original = vi.fn();
    const component = world.component(A).on("set", original);
    const before = component.meta._onSet;
    const { watch } = create(local);
    const slot = component.meta._onSet;
    expect(slot && "handlers" in slot ? slot.handlers.length : 1).toBe(2);
    world.entity().attach(new A());
    entity.attach(Object.assign(new A(), { x: 4 }));
    entity.getMut(A, (a) => {
      a.x = 5;
    });
    entity.ensure(A, (a) => {
      a.x = 6;
    });
    entity.modified(A);
    expect(
      read(local, watch)
        .events.filter((event) => event.eid === entity.eid)
        .map((event) => event.value)
    ).toEqual([{ x: 4 }, { x: 5 }, { x: 6 }, { x: 6 }]);
    local.watches.remove({ watch, _session: "one" });
    expect(component.meta._onSet).toBe(before);
    entity.set(A, { x: 7 });
    expect(original).toHaveBeenCalledTimes(6);
  });

  it("expires without reads even with writes, reports once, and refreshes on reads", () => {
    vi.useFakeTimers();
    const { world, entity, local } = setup();
    const baseline = world.queries.length;
    const { watch } = create(local);
    vi.advanceTimersByTime(WATCH_IDLE_MS - 1);
    read(local, watch);
    vi.advanceTimersByTime(WATCH_IDLE_MS - 1);
    entity.set(A, { x: 3 });
    expect(world.queries.length).toBe(baseline + 1);
    vi.advanceTimersByTime(1);
    expect(world.queries.length).toBe(baseline);
    expect(read(local, watch)).toEqual({ events: [], latest: 0, dropped: -1 });
    expect(() => read(local, watch)).toThrow("Unknown watch");
  });

  it("caps at 32 per world across owners, isolates owners and frees capacity", () => {
    const { local, world } = setup();
    const baseline = world.queries.length;
    const ids = Array.from({ length: 32 }, () => create(local).watch);
    expect(() => create(local, { _session: "two" })).toThrow(ids.join(", "));
    expect(() => read(local, ids[0], { _session: "two" })).toThrow("Unknown watch");
    expect(() => local.watches.remove({ watch: ids[0], _session: "two" })).toThrow("Unknown watch");
    local.watches.close("one");
    expect(world.queries.length).toBe(baseline);
    expect(create(local, { _session: "two" }).members).toBe(1);
  });

  it("logs actual deferred delivery order and per-set snapshots, coalescing pending modified", () => {
    const { local, world, entity } = setup();
    const { watch } = create(local);
    world.defer(() => {
      entity.set(A, { x: 2 });
      entity.set(A, { x: 3 });
      entity.modified(A);
      entity.modified(A);
      world.entity("new").set(A, { x: 8 });
    });
    expect(
      read(local, watch).events.map(({ kind, name, value }) => ({ kind, name, value }))
    ).toEqual([
      { kind: "update", name: "sample", value: { x: 2 } },
      { kind: "update", name: "sample", value: { x: 3 } },
      { kind: "update", name: "sample", value: { x: 3 } },
      { kind: "enter", name: "new", value: { A: { x: 8 } } },
      { kind: "update", name: "new", value: { x: 8 } },
    ]);
  });
});
