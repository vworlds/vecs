import { describe, it, expect, vi } from "vitest";
import { ChildOf, Entity, Iter, Relationship, World } from "../src/index.js";

class Position {
  x = 0;
}
class Velocity {
  vx = 0;
}
class Tag {}
class FriendOf extends Relationship {}

describe("Iter cursor", () => {
  describe("plural target injection", () => {
    it("injects one row-array slot and keeps singular injection on the first target", () => {
      const w = new World();
      w.component(Position);
      w.component(Velocity);
      w.component(Tag);
      w.component(FriendOf);
      const first = w.entity().set(Position, { x: 1 });
      const second = w.entity().set(Velocity, { vx: 2 });
      const source = w.entity().add(Tag).add(FriendOf, first).add(FriendOf, second);
      const empty = w.entity().add(Tag);
      const seen = new Map<Entity, unknown[]>();

      const query = w.query("plural-inject").with(Tag).build();
      query.forEach(
        {
          cursor: Iter,
          inject: [
            { target: [FriendOf, Entity] },
            { targets: [FriendOf, [Entity, Position, Velocity]] },
          ],
        },
        (it, [singular, rows]) => {
          const typedRows: ReadonlyArray<
            readonly [Entity, Position | undefined, Velocity | undefined]
          > = rows;
          seen.set(it.entity, [singular, typedRows, it.src[0], it.src[1]]);
        }
      );

      expect(seen.get(source)).toEqual([
        first,
        [
          [first, first.get(Position), undefined],
          [second, undefined, second.get(Velocity)],
        ],
        first,
        [first, second],
      ]);
      expect(seen.get(empty)).toEqual([undefined, [], undefined, []]);

      const bareRows = new Map<Entity, unknown>();
      query.forEach([{ targets: [FriendOf, [Entity, Position]] }], (entity, [rows]) => {
        bareRows.set(entity, rows);
      });
      expect(bareRows.get(source)).toEqual([
        [first, first.get(Position)],
        [second, undefined],
      ]);
      expect(bareRows.get(empty)).toEqual([]);
    });

    it("preserves the plural slot around down injection", () => {
      const w = new World();
      w.component(Position);
      w.component(Tag);
      w.component(FriendOf);
      const target = w.entity().add(Position);
      const parent = w.entity().add(Tag).add(FriendOf, target);
      const child = w.entity().childOf(parent).add(Position);
      const seen: unknown[][] = [];

      w.filter(Tag).forEach(
        {
          cursor: Iter,
          inject: [
            { targets: [FriendOf, Entity] },
            { down: [ChildOf, [Position]] },
            { target: [FriendOf, Position] },
          ],
        },
        (it, tuple) => seen.push([tuple.length, ...tuple, ...it.src])
      );

      expect(seen).toEqual([
        [3, [[target]], child.get(Position), target.get(Position), [target], child, target],
      ]);

      const bareSeen: unknown[][] = [];
      w.filter(Tag).forEach(
        [{ targets: [FriendOf, Entity] }, { down: [ChildOf, [Position]] }],
        (_entity, tuple) => bareSeen.push([...tuple])
      );
      expect(bareSeen).toEqual([[[[target]], child.get(Position)]]);
    });
  });

  describe("System.each", () => {
    it("Iter cursor reuses one object across entities", () => {
      const w = new World();
      w.component(Position);
      w.component(Velocity);
      const cursors: Iter[] = [];
      w.system("sys")
        .with(Position)
        .each({ cursor: Iter, inject: [Position, Velocity] }, (it) => {
          cursors.push(it);
        });
      w.entity().add(Position).add(Velocity);
      w.entity().add(Position);
      w.progress(0, 0);
      expect(cursors.length).toBe(2);
      expect(cursors[0] === cursors[1]).toBe(true);
    });

    it("it.entity is the visited entity", () => {
      const w = new World();
      w.component(Position);
      const seen: unknown[] = [];
      w.system("sys")
        .with(Position)
        .each({ cursor: Iter, inject: [Position] }, (it) => {
          seen.push(it.entity);
        });
      const e1 = w.entity().add(Position);
      const e2 = w.entity().add(Position);
      w.progress(0, 0);
      expect(seen).toEqual([e1, e2]);
    });

    it("it.src[0] is the entity for a direct component", () => {
      const w = new World();
      w.component(Position);
      const srcs: unknown[] = [];
      w.system("sys")
        .with(Position)
        .each({ cursor: Iter, inject: [Position] }, (it) => {
          srcs.push(it.src[0]);
        });
      const e = w.entity().add(Position);
      w.progress(0, 0);
      expect(srcs).toEqual([e]);
    });

    it("it.src is the relationship target for target-injected components", () => {
      const w = new World();
      w.component(Position);
      w.component(Tag);
      w.component(FriendOf);
      const srcs: unknown[] = [];
      w.system("sys")
        .with({ target: [FriendOf, Position] })
        .each({ cursor: Iter, inject: [{ target: [FriendOf, [Position, Tag]] }] }, (it) => {
          srcs.push([it.src[0], it.src[1]]);
        });
      const target = w.entity().add(Position);
      w.entity().add(FriendOf, target);
      w.progress(0, 0);
      expect(srcs).toEqual([[target, target]]);
    });

    it("src tracks the read-from entity even when the target lacks a component", () => {
      const w = new World();
      w.component(Position);
      w.component(Tag);
      w.component(FriendOf);
      const srcs: unknown[] = [];
      w.system("sys")
        .with({ target: [FriendOf, Position] })
        .each({ cursor: Iter, inject: [{ target: [FriendOf, [Position, Tag]] }] }, (it) => {
          srcs.push([it.src[0], it.src[1]]);
        });
      const target = w.entity().add(Position);
      w.entity().add(FriendOf, target);
      w.progress(0, 0);
      expect(srcs).toEqual([[target, target]]);
    });

    it("src is undefined when the entity lacks the relationship entirely", () => {
      const w = new World();
      class Tag2 {}
      w.component(Tag2);
      w.component(Position);
      w.component(FriendOf);
      const src = vi.fn();
      w.system("sys")
        .with(Tag2)
        .each({ cursor: Iter, inject: [{ target: [FriendOf, [Position]] }] }, (it) =>
          src(it.src[0])
        );
      w.entity().add(Tag2);
      w.progress(0, 0);
      expect(src).toHaveBeenCalledWith(undefined);
    });
  });

  describe("Query.forEach", () => {
    it("Iter cursor reuses one object across entities", () => {
      const w = new World();
      w.component(Position);
      const cursors: Iter[] = [];
      const q = w.query("q").with(Position).build();
      w.entity().add(Position);
      w.entity().add(Position);
      q.forEach({ cursor: Iter, inject: [Position] }, (it) => cursors.push(it));
      expect(cursors.length).toBe(2);
      expect(cursors[0] === cursors[1]).toBe(true);
    });

    it("iterates with Iter cursor", () => {
      const w = new World();
      w.component(Position);
      const q = w.query("q").with(Position).build();
      const e = w.entity().add(Position);
      const seen: unknown[] = [];
      q.forEach({ cursor: Iter, inject: [Position] }, (it) => seen.push([it.entity, it.src[0]]));
      expect(seen[0][0]).toBe(e);
      expect(seen[0][1]).toBe(e);
    });
  });

  describe("Filter.forEach", () => {
    it("Iter cursor reuses one object across matching entities", () => {
      const w = new World();
      w.component(Position);
      w.entity().add(Position);
      w.entity().add(Position);
      const cursors: Iter[] = [];
      w.filter([Position]).forEach({ cursor: Iter, inject: [Position] }, (it) => cursors.push(it));
      expect(cursors.length).toBe(2);
      expect(cursors[0] === cursors[1]).toBe(true);
    });

    it("it.entity and it.src are correct for matching entities", () => {
      const w = new World();
      w.component(Position);
      const e = w.entity().add(Position);
      w.entity();
      const seen: unknown[] = [];
      w.filter([Position]).forEach({ cursor: Iter, inject: [Position] }, (it) =>
        seen.push(it.entity)
      );
      expect(seen).toEqual([e]);
    });
  });

  describe("Query.enter", () => {
    it("fires with Iter cursor and correct entity/src", () => {
      const w = new World();
      w.component(Position);
      const cb = vi.fn();
      const q = w
        .query("q")
        .with(Position)
        .enter({ cursor: Iter, inject: [Position] }, cb);
      const e = w.entity().add(Position);
      const pos = e.get(Position);
      q.build();
      expect(cb).toHaveBeenCalledTimes(1);
      const it = cb.mock.calls[0][0] as Iter;
      expect(it.entity).toBe(e);
      expect(it.src[0]).toBe(e);
      expect(cb.mock.calls[0][1]).toEqual([pos]);
    });

    it("fresh Iter per enter event (reentrancy safety)", () => {
      const w = new World();
      w.component(Position);
      const iters: Iter[] = [];
      const q = w
        .query("q")
        .with(Position)
        .enter({ cursor: Iter, inject: [Position] }, (it) => {
          iters.push(it);
          if (iters.length === 1) {
            w.entity().add(Position);
          }
        });
      w.entity().add(Position);
      q.build();
      expect(iters.length).toBe(2);
      expect(iters[0]).not.toBe(iters[1]);
      const e0 = iters[0].entity;
      const e1 = iters[1].entity;
      expect(e0 === e1).toBe(false);
    });

    it("throws on missing required inject component in cursor mode", () => {
      const w = new World();
      w.component(Position);
      w.component(Velocity);
      const q = w.query("q").with(Position);
      q.enter({ cursor: Iter, inject: [Position, Velocity] }, () => {});
      expect(() => {
        w.entity().add(Position);
        q.build();
      }).toThrow("query does not contain component");
    });
  });

  describe("Query.exit", () => {
    it("fires with Iter cursor and correct entity/src", () => {
      const w = new World();
      w.component(Position);
      const cb = vi.fn();
      const q = w
        .query("q")
        .with(Position)
        .exit({ cursor: Iter, inject: [Position] }, cb)
        .build();
      const e = w.entity().add(Position);
      const pos = e.get(Position);
      e.remove(Position);
      expect(cb).toHaveBeenCalledTimes(1);
      const it = cb.mock.calls[0][0] as Iter;
      expect(it.entity).toBe(e);
      expect(it.src[0]).toBe(e);
      expect(cb.mock.calls[0][1]).toEqual([pos]);
    });

    it("fresh Iter per exit event", () => {
      const w = new World();
      w.component(Position);
      const iters: Iter[] = [];
      const q = w
        .query("q")
        .with(Position)
        .exit({ cursor: Iter, inject: [Position] }, (it) => {
          iters.push(it);
        })
        .build();
      const e1 = w.entity().add(Position);
      const e2 = w.entity().add(Position);
      e1.remove(Position);
      e2.remove(Position);
      expect(iters.length).toBe(2);
      expect(iters[0]).not.toBe(iters[1]);
    });

    it("exit snapshot still works in cursor mode", () => {
      const w = new World();
      w.component(Position);
      const cb = vi.fn();
      const q = w
        .query("q")
        .with(Position)
        .exit({ cursor: Iter, inject: [Position] }, cb)
        .build();
      const e = w.entity().add(Position);
      const pos = e.get(Position);
      e.remove(Position);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][1][0]).toBe(pos);
    });
  });

  describe("Query.update", () => {
    it("Iter cursor in update callback", () => {
      const w = new World();
      w.component(Position);
      w.component(Velocity);
      const cb = vi.fn();
      const q = w
        .query("q")
        .with(Position, Velocity)
        .update({ watch: Position, cursor: Iter, inject: [Velocity] }, cb as any)
        .build();
      const e = w.entity().add(Position).add(Velocity);
      cb.mockClear();
      const pos = e.get(Position);
      const vel = e.get(Velocity);
      e.modified(Position);
      expect(cb).toHaveBeenCalledTimes(1);
      const it = cb.mock.calls[0][0] as Iter;
      expect(it.entity).toBe(e);
      expect(it.src[0]).toBe(e);
      expect(cb.mock.calls[0][1]).toBe(pos);
      expect(cb.mock.calls[0][2]).toEqual([vel]);
    });

    it("Iter cursor is reused across update calls", () => {
      const w = new World();
      w.component(Position);
      const iters: Iter[] = [];
      const q = w
        .query("q")
        .with(Position)
        .update({ watch: Position, cursor: Iter, inject: [Position] }, ((it: Iter) =>
          iters.push(it)) as any)
        .build();
      const e = w.entity().add(Position);
      iters.length = 0;
      e.modified(Position);
      e.modified(Position);
      expect(iters.length).toBe(2);
      expect(iters[0] === iters[1]).toBe(true);
    });
  });

  describe("Query.orderBy", () => {
    it("Iter cursor in orderBy comparator passes resolved tuples", () => {
      const w = new World();
      w.component(Position);
      w.entity().add(Position).set(Position, { x: 2 });
      w.entity().add(Position).set(Position, { x: 1 });
      const q = w
        .query("q")
        .with(Position)
        .orderBy({ cursor: Iter, inject: [Position] }, (_a, [posA], _b, [posB]) => posA.x - posB.x)
        .build();
      const order = [...q];
      expect(order[0].get(Position)!.x).toBe(1);
      expect(order[1].get(Position)!.x).toBe(2);
    });
  });

  describe("System.enter", () => {
    it("Iter cursor fires through system inbox", () => {
      const w = new World();
      w.component(Position);
      const cb = vi.fn();
      w.system("sys")
        .with(Position)
        .enter({ cursor: Iter, inject: [Position] }, cb);
      const e = w.entity().add(Position);
      const pos = e.get(Position);
      w.progress(0, 0);
      expect(cb).toHaveBeenCalledTimes(1);
      const it = cb.mock.calls[0][0] as Iter;
      expect(it.entity).toBe(e);
      expect(it.src[0]).toBe(e);
      expect(cb.mock.calls[0][1]).toEqual([pos]);
    });

    it("does not dispatch an Iter enter when the source is destroyed before drain", () => {
      const w = new World();
      w.component(Tag);
      w.component(FriendOf);
      const cb = vi.fn();
      w.system("sys")
        .with({ target: [FriendOf, Tag] })
        .enter({ cursor: Iter, inject: [{ target: [FriendOf, [Entity, Tag]] }] }, cb);
      w.progress(0, 0);
      const target = w.entity().add(Tag);
      const source = w.entity().add(FriendOf, target);
      source.destroy();

      w.progress(0, 0);

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("System.exit", () => {
    it("Iter cursor fires through system inbox", () => {
      const w = new World();
      w.component(Position);
      const cb = vi.fn();
      w.system("sys")
        .with(Position)
        .exit({ cursor: Iter, inject: [Position] }, cb);
      const e = w.entity().add(Position);
      w.progress(0, 0);
      const pos = e.get(Position);
      e.remove(Position);
      w.progress(0, 0);
      expect(cb).toHaveBeenCalledTimes(1);
      const it = cb.mock.calls[0][0] as Iter;
      expect(it.entity).toBe(e);
      expect(it.src[0]).toBe(e);
      expect(cb.mock.calls[0][1]).toEqual([pos]);
    });

    it("snapshots direct and target inject terms by resolved position", () => {
      const w = new World();
      w.component(Position);
      w.component(Velocity);
      w.component(FriendOf);
      w.component(Tag);
      const cb = vi.fn();
      w.system("sys")
        .with(Position)
        .exit([Position, { target: [FriendOf, [Tag]] }, Velocity], cb);
      const target = w.entity().add(Tag);
      const tag = target.get(Tag);
      const e = w.entity().add(Position).add(Velocity).add(FriendOf, target);
      w.progress(0, 0);
      const pos = e.get(Position);
      const vel = e.get(Velocity);
      e.destroy();
      w.progress(0, 0);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][1]).toEqual([pos, tag, vel]);
    });

    it("snapshots direct and target inject terms with Iter sources", () => {
      const w = new World();
      w.component(Position);
      w.component(Velocity);
      w.component(FriendOf);
      w.component(Tag);
      const cb = vi.fn();
      w.system("sys")
        .with(Position)
        .exit({ cursor: Iter, inject: [Position, { target: [FriendOf, [Tag]] }, Velocity] }, cb);
      const target = w.entity().add(Tag);
      const tag = target.get(Tag);
      const e = w.entity().add(Position).add(Velocity).add(FriendOf, target);
      w.progress(0, 0);
      const pos = e.get(Position);
      const vel = e.get(Velocity);
      e.destroy();
      w.progress(0, 0);
      expect(cb).toHaveBeenCalledTimes(1);
      const it = cb.mock.calls[0][0] as Iter;
      expect(cb.mock.calls[0][1]).toEqual([pos, tag, vel]);
      expect(it.src).toEqual([e, target, e]);
    });

    it("snapshots the current target after retarget then relationship removal", () => {
      const w = new World();
      w.component(Tag);
      const cb = vi.fn();
      w.system("sys")
        .with(ChildOf, { target: [ChildOf, Tag] })
        .exit([{ target: [ChildOf, [Entity, Tag]] }], cb);
      const first = w.entity().add(Tag);
      const second = w.entity().add(Tag);
      const secondTag = second.get(Tag);
      const child = w.entity().childOf(first);
      w.progress(0, 0);

      child.childOf(second);
      child.remove(ChildOf);
      w.progress(0, 0);

      expect(cb).toHaveBeenCalledWith(child, [second, secondTag]);
    });

    it("does not restore a target removed before the exit event", () => {
      const w = new World();
      w.component(Position);
      w.component(Tag);
      w.component(FriendOf);
      const cb = vi.fn();
      w.system("sys")
        .with(Position)
        .exit([{ target: [FriendOf, [Entity, Tag]] }], cb);
      const target = w.entity().add(Tag);
      const source = w.entity().add(Position).add(FriendOf, target);
      w.progress(0, 0);

      source.remove(FriendOf);
      source.remove(Position);
      w.progress(0, 0);

      expect(cb).toHaveBeenCalledWith(source, [undefined, undefined]);
    });

    it("keeps a target component removed before inbox drain", () => {
      const w = new World();
      w.component(Tag);
      w.component(FriendOf);
      const cb = vi.fn();
      w.system("sys")
        .with({ target: [FriendOf, Tag] })
        .exit([{ target: [FriendOf, [Entity, Tag]] }], cb);
      const target = w.entity().add(Tag);
      const tag = target.get(Tag);
      const source = w.entity().add(FriendOf, target);
      w.progress(0, 0);

      target.remove(Tag);
      w.progress(0, 0);

      expect(cb).toHaveBeenCalledWith(source, [target, tag]);
    });

    it("snapshots plural target rows and Iter.src before relationship teardown", () => {
      const w = new World();
      w.component(Position);
      w.component(Tag);
      w.component(FriendOf);
      const cb = vi.fn();
      w.system("sys")
        .with(Position, { target: [FriendOf, Tag] })
        .exit({ cursor: Iter, inject: [{ targets: [FriendOf, [Entity, Position]] }] }, cb);
      const first = w.entity().add(Tag).set(Position, { x: 1 });
      const second = w.entity().add(Tag);
      const source = w.entity().add(Position).add(FriendOf, first).add(FriendOf, second);
      w.progress(0, 0);

      source.remove(Position);
      source.remove(FriendOf);
      w.progress(0, 0);

      const it = cb.mock.calls[0][0] as Iter;
      expect(cb.mock.calls[0][1]).toEqual([
        [
          [first, first.get(Position)],
          [second, undefined],
        ],
      ]);
      expect(it.src).toEqual([[first, second]]);
    });
  });

  describe("System.update", () => {
    it("Iter cursor in system update callback through inbox", () => {
      const w = new World();
      w.component(Position);
      w.component(Velocity);
      const cb = vi.fn();
      w.system("sys")
        .with(Position)
        .update({ watch: Position, cursor: Iter, inject: [Velocity] }, cb as any);
      const e = w.entity().add(Position).add(Velocity);
      w.progress(0, 0);
      cb.mockClear();
      const vel = e.get(Velocity);
      e.modified(Position);
      w.progress(0, 0);
      const pos = e.get(Position);
      expect(cb).toHaveBeenCalledTimes(1);
      const it = cb.mock.calls[0][0] as Iter;
      expect(it.entity).toBe(e);
      expect(it.src[0]).toBe(e);
      expect(cb.mock.calls[0][1]).toBe(pos);
      expect(cb.mock.calls[0][2]).toEqual([vel]);
    });
  });

  describe("System.orderBy", () => {
    it("Iter cursor in system orderBy comparator passes resolved tuples", () => {
      const w = new World();
      w.component(Position);
      w.entity().add(Position).set(Position, { x: 2 });
      w.entity().add(Position).set(Position, { x: 1 });
      const sys = w
        .system("sys")
        .with(Position)
        .orderBy({ cursor: Iter, inject: [Position] }, (_a, [posA], _b, [posB]) => posA.x - posB.x);
      w.progress(0, 0);
      const order = [...sys];
      expect(order[0].get(Position)!.x).toBe(1);
      expect(order[1].get(Position)!.x).toBe(2);
    });
  });

  describe("Regression", () => {
    it("bare each and explicit Entity each produce identical results", () => {
      const w = new World();
      w.component(Position);
      const bare = vi.fn();
      const explicit = vi.fn();
      w.system("a").with(Position).each([Position], bare);
      w.system("b")
        .with(Position)
        .each({ cursor: Entity, inject: [Position] }, explicit);
      const e = w.entity().add(Position);
      const pos = e.get(Position);
      w.progress(0, 0);
      expect(bare).toHaveBeenCalledWith(e, [pos]);
      expect(explicit).toHaveBeenCalledWith(e, [pos]);
    });

    it("explicit Entity marker produces same results as bare form (enter)", () => {
      const w = new World();
      w.component(Position);
      const bareCb = vi.fn();
      const entityCb = vi.fn();
      w.entity().add(Position);
      w.query("a").with(Position).enter([Position], bareCb).build();
      w.query("b")
        .with(Position)
        .enter({ cursor: Entity, inject: [Position] }, entityCb)
        .build();
      expect(bareCb).toHaveBeenCalledTimes(1);
      expect(entityCb).toHaveBeenCalledTimes(1);
      expect(bareCb.mock.calls[0][0] === entityCb.mock.calls[0][0]).toBe(true);
      expect(bareCb.mock.calls[0][1]).toEqual(entityCb.mock.calls[0][1]);
    });

    it("explicit Entity marker produces same results as bare form (exit)", () => {
      const w = new World();
      w.component(Position);
      const bareCb = vi.fn();
      const entityCb = vi.fn();
      const e = w.entity().add(Position);
      w.query("a").with(Position).exit([Position], bareCb).build();
      w.query("b")
        .with(Position)
        .exit({ cursor: Entity, inject: [Position] }, entityCb)
        .build();
      e.remove(Position);
      expect(bareCb.mock.calls[0][0] === entityCb.mock.calls[0][0]).toBe(true);
      expect(bareCb.mock.calls[0][1]).toEqual(entityCb.mock.calls[0][1]);
    });

    it("explicit Entity marker produces same results as bare form (forEach)", () => {
      const w = new World();
      w.component(Position);
      const bareCb = vi.fn();
      const entityCb = vi.fn();
      const q = w.query("q").with(Position).build();
      const e = w.entity().add(Position);
      q.forEach([Position], bareCb);
      q.forEach({ cursor: Entity, inject: [Position] }, entityCb);
      expect(bareCb.mock.calls[0][0] === entityCb.mock.calls[0][0]).toBe(true);
      expect(bareCb.mock.calls[0][1]).toEqual(entityCb.mock.calls[0][1]);
    });

    it("explicit Entity marker works with update", () => {
      const w = new World();
      w.component(Position);
      w.component(Velocity);
      const cb = vi.fn();
      const q = w
        .query("q")
        .with(Position, Velocity)
        .update({ watch: Position, cursor: Entity, inject: [Velocity] }, cb)
        .build();
      const e = w.entity().add(Position).add(Velocity);
      cb.mockClear();
      const vel = e.get(Velocity);
      e.modified(Position);
      const pos = e.get(Position);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(e, pos, [vel]);
    });

    it("explicit Entity marker works with orderBy", () => {
      const w = new World();
      w.component(Position);
      const cb = vi.fn(() => 0);
      w.entity().add(Position).set(Position, { x: 2 });
      w.entity().add(Position).set(Position, { x: 1 });
      w.query("q")
        .with(Position)
        .orderBy({ cursor: Entity, inject: [Position] }, cb)
        .build();
      expect(cb).toHaveBeenCalled();
    });
  });

  describe("target injection with Iter cursor across surfaces", () => {
    it("Filter.forEach Iter cursor with target injection", () => {
      const w = new World();
      w.component(Position);
      w.component(Tag);
      w.component(FriendOf);
      const target = w.entity().add(Position);
      w.entity().add(Position);
      w.entity().add(FriendOf, target);
      const seen: unknown[] = [];
      w.filter({ target: [FriendOf, Position] }).forEach(
        { cursor: Iter, inject: [{ target: [FriendOf, [Position, Tag]] }] },
        (it, [pos, tag]) => {
          seen.push({ entity: it.entity, src0: it.src[0], src1: it.src[1], pos, tag });
        }
      );
      expect(seen.length).toBe(1);
      const entry = seen[0] as any;
      expect(entry.src0).toBe(target);
      expect(entry.src1).toBe(target);
      expect(entry.pos).toBe(target.get(Position));
      expect(entry.tag).toBeUndefined();
    });

    it("Iter cursor target injection through System enter (src is the target)", () => {
      const w = new World();
      w.component(Position);
      w.component(FriendOf);
      const entered: unknown[] = [];
      w.system("sys")
        .with({ target: [FriendOf, Position] })
        .enter({ cursor: Iter, inject: [{ target: [FriendOf, [Position]] }] }, (it, [pos]) => {
          entered.push({ entity: it.entity, src: it.src[0], pos });
        });
      const target = w.entity().add(Position);
      w.entity().add(FriendOf, target);
      w.progress(0, 0);
      expect(entered.length).toBe(1);
      const entry = entered[0] as any;
      expect(entry.src).toBe(target);
    });

    it("Iter cursor target injection through System exit captures target src", () => {
      const w = new World();
      w.component(Position);
      w.component(FriendOf);
      const exited: unknown[] = [];
      w.system("sys")
        .with({ target: [FriendOf, Position] })
        .exit({ cursor: Iter, inject: [{ target: [FriendOf, [Position]] }] }, (it, [pos]) => {
          exited.push({ entity: it.entity, src: it.src[0], pos });
        });
      const target = w.entity().add(Position);
      const candidate = w.entity().add(FriendOf, target);
      w.progress(0, 0);
      // Exit caused by removal of target's Position. The queued snapshot keeps
      // the target source even though the projected component is gone.
      target.remove(Position);
      w.progress(0, 0);
      expect(exited.length).toBe(1);
      const entry = exited[0] as any;
      expect(entry.src).toBe(target);
    });
  });

  describe("ChildOf with Iter cursor", () => {
    it("System.each Iter cursor with ChildOf target injection", () => {
      const w = new World();
      w.component(Position);
      const srcs: unknown[] = [];
      w.system("sys")
        .with({ target: [ChildOf, Position] })
        .each({ cursor: Iter, inject: [{ target: [ChildOf, [Position]] }] }, (it) => {
          srcs.push(it.src[0]);
        });
      const parent = w.entity().add(Position);
      w.entity().childOf(parent);
      w.progress(0, 0);
      expect(srcs).toEqual([parent]);
    });
  });

  describe("forEach invoker reuse", () => {
    function setup() {
      const w = new World();
      w.component(Position);
      w.component(Velocity);
      w.entity().set(Position, { x: 1 }).set(Velocity, { vx: 2 });
      return { w, q: w.query("reuse").with(Position, Velocity).build() };
    }

    it("hands the same tuple to two calls with the same callback", () => {
      const { q } = setup();
      const tuples: unknown[] = [];
      const cb = (_e: Entity, resolved: unknown) => tuples.push(resolved);
      q.forEach([Position, Velocity], cb);
      q.forEach([Position, Velocity], cb);
      expect(tuples).toHaveLength(2);
      expect(tuples[1]).toBe(tuples[0]);
    });

    it("hands a different tuple to a different callback", () => {
      const { q } = setup();
      const tuples: unknown[] = [];
      q.forEach([Position, Velocity], (_e, resolved) => tuples.push(resolved));
      q.forEach([Position, Velocity], (_e, resolved) => tuples.push(resolved));
      expect(tuples[1]).not.toBe(tuples[0]);
    });

    it("rebuilds when the inject elements differ and resolves the new ones", () => {
      const { q } = setup();
      const seen: unknown[][] = [];
      const cb = (_e: Entity, resolved: readonly unknown[]) => seen.push([...resolved]);
      q.forEach([Position, Velocity], cb);
      q.forEach([Velocity, Position], cb);
      expect(seen[0]![0]).toBeInstanceOf(Position);
      expect(seen[1]![0]).toBeInstanceOf(Velocity);
    });

    it("does not share the tuple with a re-entrant call of the same callback", () => {
      const { q } = setup();
      const tuples: unknown[] = [];
      let depth = 0;
      const cb = (_e: Entity, resolved: unknown) => {
        tuples.push(resolved);
        if (depth++ === 0) {
          q.forEach([Position, Velocity], cb);
        }
      };
      q.forEach([Position, Velocity], cb);
      expect(tuples).toHaveLength(2);
      expect(tuples[1]).not.toBe(tuples[0]);
    });
  });
});
